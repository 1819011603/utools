/**
 * 带宽模型的行为钉子。
 *
 * 文档里「最容易改一个数把别处顶穿」的就是这块：EWMA 分档、饱和并发、聚合拐点。
 * 全部喂确定的样本（`bps` 反推 bytes），断言可手算的读数。
 */
import { describe, it, expect } from 'vitest'
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

describe('requiredConn / aggregateFeeds / maxFluentRate', () => {
  it('requiredConn = ceil(码率×倍速×安全 ÷ 每连接)；solo 用单条基线', () => {
    const bw = useBandwidthModel()
    bw.sampleBitrate(1_000_000, 1)   // 码率 8e6 bps
    feed(bw, 4e6, 2)                 // 单条基线 4e6；混合均值 4e6
    feed(bw, 1e6, 6)                 // 混合均值 → 3.1e6
    expect(bw.requiredConn(1, 1)).toBe(3)        // ceil(8e6/3.1e6)
    expect(bw.requiredConn(1, 1, true)).toBe(2)  // ceil(8e6/4e6)
  })

  it('aggregateFeeds：峰值聚合 ≥ 码率×倍速×安全', () => {
    const bw = useBandwidthModel()
    bw.sampleBitrate(1_000_000, 1)   // 8e6
    feed(bw, 8e6, 2)                 // aggByConn[2]=16e6
    expect(bw.aggregateFeeds(1, 1)).toBe(true)   // 16e6 >= 8e6
    expect(bw.aggregateFeeds(3, 1)).toBe(false)  // 16e6 < 24e6
  })

  it('maxFluentRate：无样本按当前倍速取 0.25 档；有样本按 满并发聚合 ÷ (码率×安全)', () => {
    const bw = useBandwidthModel()
    expect(bw.maxFluentRate(6, 1, 1.3)).toBe(1.25)   // round(1.3/0.25)=5 → 1.25

    bw.sampleBitrate(1_000_000, 1)   // 8e6
    feed(bw, 8e6, 2)                 // perConnBps=8e6
    expect(bw.maxFluentRate(6, 1, 1)).toBe(6)   // floor(8e6*6/(8e6*1)/0.25)*0.25 = 6
  })
})

describe('soloRetainRatio / hasSamples / resetSamples', () => {
  it('保有率 = 当前每连接 ÷ 单条基线；没基线时 0', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)                 // 低并发档 8e6
    feed(bw, 1e6, 6)                 // 混合均值 → 5.9e6
    expect(bw.soloRetainRatio()).toBeCloseTo(0.7375, 6)

    const bw2 = useBandwidthModel()
    feed(bw2, 8e6, 6)                // 只在高并发档 → 没单条基线
    expect(bw2.soloRetainRatio()).toBe(0)
  })

  it('hasSamples 要「每连接速度 + 码率」都有', () => {
    const bw = useBandwidthModel()
    feed(bw, 8e6, 2)
    expect(bw.hasSamples()).toBe(false)
    bw.sampleBitrate(1_000_000, 1)
    expect(bw.hasSamples()).toBe(true)
  })

  it('resetSamples 清空全部', () => {
    const bw = useBandwidthModel()
    bw.sampleBitrate(1_000_000, 1)
    feed(bw, 8e6, 2)
    bw.resetSamples()
    expect(bw.hasSamples()).toBe(false)
    expect(bw.perConnKBps()).toBe(0)
    expect(bw.soloConnKBps()).toBe(0)
    expect(bw.peakAggBps()).toBe(0)
  })
})
