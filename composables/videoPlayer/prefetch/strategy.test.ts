/**
 * 并发策略的行为钉子（回归护栏）。
 *
 * 这些用例把 `docs/player.md` §并发预取与抗卡 里那几条最容易「改一个数把别处顶穿」的规则
 * 钉成断言：冷启动帽、存货阶梯、摊薄帽、单条够快帽、卡顿守卫的两个分岔、爬升一档一档。
 * 带宽模型用桩（完全可控），这样每条用例只验一级、失败时能直接点名是哪一级。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { TierParams } from '../../videoSiteRules'
import type { BandwidthModel } from './bandwidth'
import { useConcurrencyStrategy } from './strategy'
import { COLD_START_CONN_CAP, FAST_SOLO_KBPS } from './tuning'

interface BwKnobs {
  maxRate?: number
  /** windowedFluentRate() 的返回值（0 = 没窗口，策略退回瞬时值） */
  windowed?: number
  hasSamples?: boolean
  soloKBps?: number
  retain?: number
  satConn?: number
  kneeConn?: number
  avgSegLoadMs?: number
  aggFeeds?: boolean
  /** requiredConn() 的返回值（与参数无关，够这些用例用） */
  required?: number
  peakAgg?: number
}

function makeBw(k: BwKnobs): BandwidthModel {
  const stub = {
    hasSamples: () => k.hasSamples ?? false,
    soloConnKBps: () => k.soloKBps ?? 0,
    soloRetainRatio: () => k.retain ?? 0,
    saturationConn: () => k.satConn ?? 0,
    bestAggConn: () => k.kneeConn ?? 0,
    avgSegLoadMs: () => k.avgSegLoadMs ?? 0,
    aggregateFeeds: () => k.aggFeeds ?? false,
    requiredConn: () => k.required ?? 1,
    peakAggBps: () => k.peakAgg ?? 0,
    perConnKBps: () => 0,
    segMbps: () => 0,
    maxFluentRate: () => k.maxRate ?? 1,
    getAggregateScales: () => true,
    markConcChange: () => {},
    noteFluentRate: () => {},
    windowedFluentRate: () => k.windowed ?? 0,   // 默认没窗口 → 退瞬时值，多数用例直接验 maxFluentRate 桩值
  }
  return stub as unknown as BandwidthModel
}

const TIER = { safety: 1, panicSecs: 3, lowSecs: 8 } as unknown as TierParams

interface SetupOpts {
  bw: BwKnobs
  targetSecs?: number
  rate?: number
  safeWall?: number
  coldStartConn?: number
  stallAt?: number
  hostCap?: number
  segDur?: number
}

function setup(o: SetupOpts) {
  const runtime = { hostConcurrencyCap: o.hostCap ?? 6, segDurSecs: o.segDur ?? 10 }
  const ctl = useConcurrencyStrategy({
    bw: makeBw(o.bw),
    runtime,
    tier: () => TIER,
    getPlaybackRate: () => o.rate ?? 1,
    getPrefetchTargetSecs: () => o.targetSecs ?? 100,
    getSafeWallSecs: () => o.safeWall ?? 5,
    getColdStartConn: () => o.coldStartConn ?? 0,
    getLastStallAt: () => o.stallAt ?? 0,
  })
  return { ctl, runtime }
}

afterEach(() => { vi.restoreAllMocks() })

describe('effectivePrefetchTarget：把「够播几秒」换算成视频秒', () => {
  it('按倍速放大（3x 下 100s → 300 视频秒）', () => {
    const { ctl } = setup({ bw: {}, targetSecs: 100, rate: 3 })
    expect(ctl.effectivePrefetchTarget()).toBe(300)
  })
  it('不限（Infinity）原样返回', () => {
    const { ctl } = setup({ bw: {}, targetSecs: Infinity })
    expect(ctl.effectivePrefetchTarget()).toBe(Infinity)
  })
})

describe('冷启动帽（① 无样本 ≤3）', () => {
  it('无论 hostCap 多大，无样本时封在 3', () => {
    const { ctl } = setup({ bw: { hasSamples: false, required: 9 }, hostCap: 12, coldStartConn: 4 })
    const n = ctl.getAdaptivePrefetchCount(50)
    expect(n).toBe(COLD_START_CONN_CAP)
    expect(n).toBeLessThanOrEqual(COLD_START_CONN_CAP)
  })
  it('无样本且没学过该 host → 地板 2（max(2, learned)）', () => {
    const { ctl } = setup({ bw: { hasSamples: false, required: 9 }, hostCap: 12, coldStartConn: 0 })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(2)
  })
  it('冷启动帽与「缺口装得下几片」取小', () => {
    const { ctl } = setup({ bw: { hasSamples: false }, targetSecs: 100, segDur: 10 })
    // gap = 100 - 80 = 20 → ceil(20/10) = 2 < 3
    expect(ctl.getAdaptivePrefetchCount(80)).toBe(2)
  })
})

describe('停取（缺口不足一片 → 0）', () => {
  it('已到预加载目标 → 0', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10 } })
    expect(ctl.getAdaptivePrefetchCount(100)).toBe(0)
  })
  it('不限预加载时不因缺口停取', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 2 }, targetSecs: Infinity, hostCap: 6 })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(6)
  })
})

describe('存货阶梯（② WALL_CONN_STEPS，快源只 2~6 条）', () => {
  // 样本齐、慢源(solo=0)、聚合喂得动(地板不抬)、requiredConn 够大(不让 desiredConn 成为瓶颈)
  const bw: BwKnobs = { hasSamples: true, required: 10, aggFeeds: true, soloKBps: 0 }
  it('存货 1s（< 保险线 40%）→ 2 条', () => {
    expect(setup({ bw }).ctl.getAdaptivePrefetchCount(1)).toBe(2)
  })
  it('存货 4s（< 保险线）→ 3 条', () => {
    expect(setup({ bw }).ctl.getAdaptivePrefetchCount(4)).toBe(3)
  })
  it('存货 6s（过保险线）→ 4 条', () => {
    expect(setup({ bw }).ctl.getAdaptivePrefetchCount(6)).toBe(4)
  })
  it('存货 8s（过 1.5 倍）→ 6 条', () => {
    expect(setup({ bw }).ctl.getAdaptivePrefetchCount(8)).toBe(6)
  })
  it('存货 12s（过 2 倍放开线）→ hostCap', () => {
    expect(setup({ bw }).ctl.getAdaptivePrefetchCount(12)).toBe(6)
  })
})

describe('饿区快源（② step0 + 单条够快 → 只留 1 条）', () => {
  it('存货濒卡且单条 ≥500KB/s → 1 条', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, aggFeeds: true, soloKBps: 2000 } })
    expect(ctl.getAdaptivePrefetchCount(1)).toBe(1)
  })
})

describe('摊薄帽（④ soloRetain → 3/2）', () => {
  const bw: BwKnobs = { hasSamples: true, required: 10, aggFeeds: true, soloKBps: 0 }
  it('保有率 0.4（<0.45）→ 收到 2 条', () => {
    expect(setup({ bw: { ...bw, retain: 0.4 } }).ctl.getAdaptivePrefetchCount(50)).toBe(2)
  })
  it('保有率 0.6（<0.70）→ 收到 3 条', () => {
    expect(setup({ bw: { ...bw, retain: 0.6 } }).ctl.getAdaptivePrefetchCount(50)).toBe(3)
  })
  it('保有率 0.9（没被摊薄）→ 不咬人', () => {
    expect(setup({ bw: { ...bw, retain: 0.9 } }).ctl.getAdaptivePrefetchCount(50)).toBe(6)
  })
})

describe('单连接够快帽（⑤ 门槛 × 倍速）', () => {
  it('1x 下单条 2000KB/s（≥1MB/s）→ 封 2 条', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, aggFeeds: true, soloKBps: 2000 } })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(2)
  })
  it('3x 下同一条 2000KB/s 只算「≥500KB/s」→ 封 3 条（门槛随倍速放大）', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, aggFeeds: true, soloKBps: 2000 }, rate: 3 })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(3)
  })
})

describe('卡顿守卫（③ 真慢型抬地板 / 摊薄型收紧）', () => {
  it('真慢型（聚合喂不动）→ 地板抬到饱和并发', () => {
    const { ctl } = setup({
      bw: { hasSamples: true, required: 1, aggFeeds: false, retain: 1, peakAgg: 1, satConn: 4 },
      stallAt: performance.now(),
    })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(4)
  })
  it('摊薄型（聚合够喂却还卡）→ 收到 3 条', () => {
    const { ctl } = setup({
      bw: { hasSamples: true, required: 10, aggFeeds: true, retain: 1, peakAgg: 1 },
      stallAt: performance.now(),
    })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(3)
  })
  it('没有聚合读数时闭嘴（不抬地板）', () => {
    const { ctl } = setup({
      bw: { hasSamples: true, required: 1, aggFeeds: false, retain: 1, peakAgg: 0 },
      stallAt: performance.now(),
    })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(1)
  })
})

describe('⑨ 爬升：一档一档来，不跳级', () => {
  it('刚上调那一拍不动；过了爬升间隔才 +1', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const { ctl } = setup({ bw: { hasSamples: true, required: 12, aggFeeds: true, soloKBps: 0 }, hostCap: 12 })

    // 第一拍：存货濒卡 → 目标 2，记下 connUpAt=1000
    expect(ctl.getAdaptivePrefetchCount(1)).toBe(2)
    // 100ms 后：上一档还没站稳 → 维持 2
    clock = 1100
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(2)
    // 2s 后（> CONN_RAMP_MS_SLOW）：只许 +1 → 3
    clock = 3000
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(3)
  })

  it('首拍直接给基值（不从 1 慢慢爬）', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 6, aggFeeds: true, soloKBps: 0 }, hostCap: 6 })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(6)
  })

  it('从 0 恢复（到目标停取后又掉下来）也一档一档，不跳回目标', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const { ctl } = setup({ bw: { hasSamples: true, required: 6, aggFeeds: true, soloKBps: 0 }, hostCap: 6 })
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(6)    // 首拍基值
    expect(ctl.getAdaptivePrefetchCount(100)).toBe(0)   // 到目标 → 停取（lastTargetConn 归 0）
    clock = 5000
    expect(ctl.getAdaptivePrefetchCount(80)).toBe(1)    // 恢复：从 0 只 +1，不是直接 6
    clock = 7000
    expect(ctl.getAdaptivePrefetchCount(80)).toBe(2)    // 再 +1
  })

  it('reset 后首拍又直接给基值（重新起算）', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 6, aggFeeds: true, soloKBps: 0 }, hostCap: 6 })
    ctl.getAdaptivePrefetchCount(50)
    ctl.reset()
    expect(ctl.getAdaptivePrefetchCount(50)).toBe(6)
  })
})

describe('健康区 / reset', () => {
  it('updateHealthZone 按有效可播分档，并在快照里体现', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10 } })
    ctl.updateHealthZone(1, 1)
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.healthZone).toBe('panic')
    ctl.updateHealthZone(5, 5)
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.healthZone).toBe('low')
    ctl.updateHealthZone(9, 9)
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.healthZone).toBe('healthy')
  })

  it('reset 后快照 targetConn 回到初值 4', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, aggFeeds: true } })
    ctl.getAdaptivePrefetchCount(1)
    expect(ctl.strategy.value.targetConn).not.toBe(4)
    ctl.reset()
    expect(ctl.strategy.value.targetConn).toBe(4)
  })
})

describe('「缓冲卡住」兜底（消费 ≈ 填充 → 死卡 4 条的自锁）', () => {
  it('观察窗内缓冲没涨 → 放开一档破自锁（再受爬升 +1 限制）', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const { ctl } = setup({ bw: { hasSamples: true, required: 8, aggFeeds: true, soloKBps: 0 }, hostCap: 6 })
    // 墙钟 6s → 存货阶梯第 2 档（上限 4）；模型想要 8，被阶梯压到 4
    expect(ctl.getAdaptivePrefetchCount(6)).toBe(4)
    clock = 6000                                     // 缓冲 5s 没涨 → 卡住
    expect(ctl.getAdaptivePrefetchCount(6)).toBe(5)  // 放开一档（再受爬升 +1）
    clock = 8000
    expect(ctl.getAdaptivePrefetchCount(6)).toBe(6)  // 再到 6
  })

  it('缓冲在涨 → 不触发兜底，阶梯照常生效', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const { ctl } = setup({ bw: { hasSamples: true, required: 8, aggFeeds: true, soloKBps: 0 }, hostCap: 6 })
    expect(ctl.getAdaptivePrefetchCount(5)).toBe(4)
    clock = 6000
    expect(ctl.getAdaptivePrefetchCount(6.5)).toBe(4)   // 一窗涨了 1.5s（≥1）→ 没卡住
  })
})

describe('sanity：FAST_SOLO_KBPS 与用例口径一致', () => {
  it('FAST_SOLO_KBPS=500', () => { expect(FAST_SOLO_KBPS).toBe(500) })
})

describe('maxFluentRate 窗口（展示窗口内最差时刻，不是瞬时值）', () => {
  it('窗口有数 → 用窗口最差值；窗口空 → 退瞬时值', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, maxRate: 4 } })
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.maxFluentRate).toBe(4)      // 桩窗口返回 0 → 退瞬时
    const { ctl: ctl2 } = setup({ bw: { hasSamples: true, required: 10, maxRate: 4, windowed: 2 } })
    ctl2.getAdaptivePrefetchCount(50)
    expect(ctl2.strategy.value.maxFluentRate).toBe(2)     // 窗口最差值优先于瞬时值
    expect(ctl2.strategy.value.fluentWindowSecs).toBeGreaterThan(0)
  })
})

describe('maxFluentRate 封顶（面板显示与「可能卡顿」提示共用这个数）', () => {
  it('带宽模型算出虚高（如 11.75x）→ 封在播放器最高档 5x', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, maxRate: 11.75 } })
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.maxFluentRate).toBe(5)
  })
  it('算出 3x → 原样展示，不受封顶影响', () => {
    const { ctl } = setup({ bw: { hasSamples: true, required: 10, maxRate: 3 } })
    ctl.getAdaptivePrefetchCount(50)
    expect(ctl.strategy.value.maxFluentRate).toBe(3)
  })
})
