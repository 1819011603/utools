/**
 * 带宽模型的行为钉子。
 *
 * 文档里「最容易改一个数把别处顶穿」的就是这块：EWMA 分档、饱和并发、聚合拐点。
 * 全部喂确定的样本（`bps` 反推 bytes），断言可手算的读数。
 */
import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import { useBandwidthModel } from './bandwidth'

/** 喂一次「每秒 bps 比特、耗时 ms」的下载样本（bytes 由 bps 反推，保证过 100KB 门槛）。 */
const feed = (bw: ReturnType<typeof useBandwidthModel>, bps: number, conc: number, ms = 1000) =>
  bw.sampleSpeed((bps * ms) / 8000, ms, conc)

describe('sampleSpeed：采样与 EWMA', () => {
  it('首个样本直接落值，第二个按 0.7/0.3 混合', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)
    expect(bw.perConnKBps()).toBe(977)   // 8e6/8/1024 ≈ 976.6
    feed(bw, 4e6, 2)
    expect(bw.perConnKBps()).toBe(830)   // (8e6*0.7 + 4e6*0.3)/8/1024 = 6.8e6/8/1024 ≈ 830
  })

  it('过滤：太小 / 太快 / 超 500Mbps 的样本一律丢', () => {
    const bw = useBandwidthModel()
    bw.sampleSpeed(50_000, 1000, 2)     // bytes < 100KB
    bw.sampleSpeed(1_000_000, 10, 2)    // ms < 50
    bw.sampleSpeed(1e12, 1000, 2)       // > 500Mbps
    expect(bw.hasSamples()).toBe(false)
    expect(bw.perConnKBps()).toBe(0)
  })
})

describe('分档：低并发（≤2）/ 高并发（≥5）', () => {
  it('并发 3~4 两个档都不进（不污染采样）', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 3)
    expect(bw.soloConnKBps()).toBe(0)   // 低并发档没数据
  })

  it('低/高并发档都记上后，聚合可并行判据才生效', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)   // 低并发档 = 8e6
    feed(bw, 8e6, 5)   // 高并发档 = 8e6（没掉）→ 可并行
    expect(bw.getAggregateScales()).toBe(true)

    const bw2 = useBandwidthModel()
    feed(bw2, 8e6, 2)
    feed(bw2, 2e6, 5)  // 高并发掉到 2e6 < 8e6*0.55 → 不可并行
    expect(bw2.getAggregateScales()).toBe(false)
  })
})

describe('markConcChange：跨并发变更点的样本不进分档账本', () => {
  it('变更前发起的样本只喂混合均值，不污染低并发档', () => {
    const bw = useBandwidthModel()
    bw.markConcChange()
    bw.sampleSpeed(1_000_000, 1000, 2, -1)          // 发起于变更点之前
    expect(bw.soloConnKBps()).toBe(0)               // 低并发档没被污染
    expect(bw.perConnKBps()).toBeGreaterThan(0)     // 但混合均值照记

    bw.sampleSpeed(1_000_000, 1000, 2, performance.now())   // 变更点之后
    expect(bw.soloConnKBps()).toBe(977)
  })
})

describe('bestAggConn：聚合拐点', () => {
  it('高档明显更差（<85%）→ 返回低档拐点', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)            // aggByConn[2] = 16e6
    feed(bw, 1.333e6, 6)        // aggByConn[6] ≈ 8e6 < 16e6*0.85
    expect(bw.bestAggConn()).toBe(2)
  })

  it('最高档就是最好 → 还没见拐点，返回 0', () => {
    const bw = useBandwidthModel()
    feed(bw, 4e6, 2)            // aggByConn[2] = 8e6
    feed(bw, 4e6, 6)            // aggByConn[6] = 24e6
    expect(bw.bestAggConn()).toBe(0)
  })

  it('样本不足（<2 档）→ 0', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)
    expect(bw.bestAggConn()).toBe(0)
  })
})

describe('saturationConn：饱和并发 = 峰值聚合 ÷ 单条基线', () => {
  it('试过更高档且饱和点更低 → 可信', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)            // 低并发档 8e6；aggByConn[2]=16e6
    feed(bw, 4e6, 6)            // aggByConn[6]=24e6 → 峰值 24e6
    expect(bw.saturationConn()).toBe(3)   // ceil(24e6/8e6)=3 < 试过的最高档 6
  })

  it('饱和点 = 试过的最高档 → 不可信，返回 0（防自锁）', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)            // aggByConn[2]=16e6，只在 2 条上测过
    expect(bw.saturationConn()).toBe(0)
  })
})

describe('requiredConn / aggregateFeeds', () => {
  // （原 maxFluentRate 用例随外推算法一起删除：它虚成过 11.75x / 75x，现在用实测交付吞吐，见下面两组）
  it('requiredConn：混合均值分母；solo=true 用低并发档基线', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)          // 低并发档 8Mbps
    feed(bw, 2e6, 6)          // 混合均值被拉低
    bw.sampleBitrate(1_000_000, 1)   // 码率 8Mbps
    expect(bw.requiredConn(1, 1)).toBe(2)      // 混合均值 6.2Mbps → ceil(8/6.2)
    expect(bw.requiredConn(1, 1, true)).toBe(1) // 单条基线 8Mbps → 1
  })

  it('aggregateFeeds：峰值聚合 ≥ 码率×倍速×安全 → 够喂', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2); feed(bw, 3e6, 6)
    bw.sampleBitrate(1_000_000, 1)
    expect(bw.aggregateFeeds(1, 1.2)).toBe(true)    // 峰值 18Mbps ≥ 9.6
    expect(bw.aggregateFeeds(10, 1.2)).toBe(false)
  })
})

describe('noteFluentRate / windowedFluentRate：观察窗取最差值', () => {
  it('窗口内取 min；低样本滚出窗口后读数回升；窗口长度由调用方给（=预加载时长）', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const bw = useBandwidthModel()
    bw.noteFluentRate(4, 60)
    bw.noteFluentRate(3, 60)
    bw.noteFluentRate(3.5, 60)
    expect(bw.windowedFluentRate()).toBe(3)          // 3 还在窗内 → 承诺 3
    clock += 61_000                                   // 3 滚出去（窗口 60s）
    bw.noteFluentRate(3.5, 60)
    expect(bw.windowedFluentRate()).toBe(3.5)
  })

  it('窗口变短时按新窗口裁旧样本', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const bw = useBandwidthModel()
    bw.noteFluentRate(2, 600)
    clock += 100_000
    bw.noteFluentRate(5, 30)                          // 窗口缩到 30s → 100s 前的 2 出窗
    expect(bw.windowedFluentRate()).toBe(5)
  })
})

describe('deliveredBps / lastPositiveDelivered：实测交付吞吐（1 秒桶）', () => {
  it('sampleSpeed 的字节按桶累计，读时结算为 bps', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const bw = useBandwidthModel()
    bw.sampleSpeed(1_000_000, 500, 1, 0)   // 1MB 过门槛（≥100KB、≥50ms）
    expect(bw.deliveredBps()).toBe(0)       // 第一桶还没到期（bucket 从首片起算）
    clock += 1000
    expect(bw.deliveredBps()).toBe(8_000_000)   // 1MB/1s = 8Mbps
  })

  it('空桶（一片没下）→ 0；最近正读数由 lastPositiveDelivered 记住', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const bw = useBandwidthModel()
    bw.sampleSpeed(500_000, 500, 1, 0)
    clock += 1000
    expect(bw.deliveredBps()).toBe(4_000_000)
    clock += 1000                            // 这一秒什么都没下
    expect(bw.deliveredBps()).toBe(0)
    expect(bw.lastPositiveDelivered()).toBe(4_000_000)
  })

  it('缓存命中类的假字节（<100KB / >500Mbps）不进交付', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const bw = useBandwidthModel()
    bw.sampleSpeed(500, 500, 1, 0)
    bw.sampleSpeed(1e12, 100, 1, 0)
    clock += 1000
    expect(bw.deliveredBps()).toBe(0)
  })
})
