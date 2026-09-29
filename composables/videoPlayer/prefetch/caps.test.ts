/**
 * 并发帽子模块（caps.ts）的行为钉子——直接调 `useConcurrencyCaps`，不经 `useConcurrencyStrategy`。
 *
 * `strategy.test.ts` 已经通过整条调度链间接覆盖了这些帽子；这里下沉到单元级别，
 * 好把迟滞、各种「不咬人」的短路分支、以及帽子之间 `max(..., catchUpFloor())` 的兜底关系
 * 逐条钉死——那条链路里任何一步失手，责任都能直接落到某一个函数头上。
 *
 * 带宽模型用桩（完全可控，拷贝自 strategy.test.ts 的 `makeBw`，caps 与 strategy 共用同一份
 * `BandwidthModel` 接口，见 ./bandwidth.ts）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { TierParams } from '../../videoSiteRules'
import type { BandwidthModel } from './bandwidth'
import { useConcurrencyCaps, type ConcurrencyCapsDeps } from './caps'
import { FAST_SOLO_KBPS, FAST_SOLO_CONN_STEPS, DILUTION_RETAIN_STEPS, STALL_WINDOW_MS } from './tuning'

interface BwKnobs {
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

// 拷贝自 strategy.test.ts：caps 与 strategy 吃同一个 BandwidthModel 接口，桩逻辑原样复用。
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
    maxFluentRate: () => 1,
    getAggregateScales: () => true,
    markConcChange: () => {},
  }
  return stub as unknown as BandwidthModel
}

const TIER = { safety: 1, panicSecs: 3, lowSecs: 8 } as unknown as TierParams

interface SetupOpts {
  bw: BwKnobs
  rate?: number
  safeWall?: number
  coldStartConn?: number
  stallAt?: number
  hostCap?: number
  segDur?: number
}

function setup(o: SetupOpts) {
  const runtime = { hostConcurrencyCap: o.hostCap ?? 6, segDurSecs: o.segDur ?? 10 }
  const deps: ConcurrencyCapsDeps = {
    bw: makeBw(o.bw),
    runtime,
    tier: () => TIER,
    getPlaybackRate: () => o.rate ?? 1,
    getSafeWallSecs: () => o.safeWall ?? 5,
    getColdStartConn: () => o.coldStartConn ?? 0,
    getLastStallAt: () => o.stallAt ?? 0,
  }
  return { caps: useConcurrencyCaps(deps), runtime }
}

afterEach(() => { vi.restoreAllMocks() })

describe('wallConnCap：存货阶梯 + 放开方向迟滞', () => {
  it('迟滞：越过原始阈值但没越过「当前档线 ×(1+HYST)」→ 不升档', () => {
    const { caps } = setup({ bw: { hasSamples: true, required: 1, aggFeeds: true } })
    // safe=5：第一次调用，wall=3（< 5*1.0=5，落在 [1.0,3) 档 → step=1，cap 表值 3）。wallStep 现在钉在 1。
    expect(caps.wallConnCap(3, 5)).toBe(3)
    // 想从 step1 升到 step2：原始阈值是 safe*WALL_CONN_STEPS[2][0]=7.5，但迟滞判据用的是
    // **当前档（wallStep=1）自己的线** × (1+HYST) = safe*1.0*1.25 = 6.25。
    // wall=6：越过了升档的原始阈值(5)但没越过迟滞阈值(6.25) → 应仍钉在 step=1（cap 3）
    expect(caps.wallConnCap(6, 5)).toBe(3)
    // wall=6.3（越过迟滞阈值 6.25）→ 升档到 step=2（cap 4）
    expect(caps.wallConnCap(6.3, 5)).toBe(4)
  })

  it('降档没有迟滞：立即生效', () => {
    const { caps } = setup({ bw: { hasSamples: true, required: 1, aggFeeds: true } })
    // 先升到放开档（wall 远超所有阈值）
    expect(caps.wallConnCap(100, 5)).toBe(6)
    // 立刻给一个很低的 wall：降档不受迟滞影响，直接落到 step=0（濒卡，cap 2）
    expect(caps.wallConnCap(1, 5)).toBe(2)
  })

  it('safe<=0 → 无条件返回 hostCap，并把 wallStep 重置为放开档', () => {
    const { caps } = setup({ bw: { hasSamples: true, required: 1, aggFeeds: true }, hostCap: 6 })
    // 先把 wallStep 压到很低的一档
    expect(caps.wallConnCap(1, 5)).toBe(2)
    // safe<=0：关闸，返回 hostCap，且重置 wallStep
    expect(caps.wallConnCap(1, 0)).toBe(6)
    // 重置后再给一个低 wall + 合法 safe：不应被之前的低档「残留」按住，按新一轮阶梯正常判定
    expect(caps.wallConnCap(1, 5)).toBe(2)
  })

  it('饿区（step0）+ 单条够快 → 恒定返回 1，压过 catchUpFloor', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 10, aggFeeds: true, soloKBps: FAST_SOLO_KBPS * 2 },
    })
    expect(caps.wallConnCap(1, 5)).toBe(1)
  })

  it('stuck=true：放开一档 + 让 catchUpFloor 跳过聚合闸（force 被真正传入）', () => {
    // aggFeeds=true → catchUpFloor(false) 会被聚合闸压成 0；catchUpFloor(true) 应绕开这道闸，非零。
    const { caps } = setup({
      bw: { hasSamples: true, required: 6, aggFeeds: true, satConn: 20 },
      hostCap: 12,
    })
    // 先落到某个非放开档：wall=1, safe=5 → step=0（濒卡）
    const notStuck = caps.wallConnCap(1, 5, false)
    // 不 stuck 时，catchUpFloor(false) 因聚合闸被压 0，wallStep 表值 2 胜出
    expect(notStuck).toBe(2)
    // stuck=true：nextCap = step(0)+1 对应表值 3；catchUpFloor(true) 绕开聚合闸 = min(satLimit, required*2=12)
    const stuck = caps.wallConnCap(1, 5, true)
    expect(stuck).toBe(Math.max(3, caps.catchUpFloor(true)))
    expect(caps.catchUpFloor(true)).toBeGreaterThan(0)
  })
})

describe('catchUpFloor：地板', () => {
  it('无样本 → min(hostCap, max(0, coldStartConn))', () => {
    const { caps: capsUnderCap } = setup({ bw: { hasSamples: false }, hostCap: 6, coldStartConn: 4 })
    expect(capsUnderCap.catchUpFloor()).toBe(4)
    const { caps: capsFloored } = setup({ bw: { hasSamples: false }, hostCap: 6, coldStartConn: -3 })
    expect(capsFloored.catchUpFloor()).toBe(0)
  })

  it('聚合喂得动闸：force=false 时恒为 0，force=true 时绕开闸门', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 100, aggFeeds: true, satConn: 20 },
      hostCap: 12,
    })
    expect(caps.catchUpFloor(false)).toBe(0)
    // force=true：min(saturationLimit()=min(hostCap,satConn)=12, required*2=200) = 12
    expect(caps.catchUpFloor(true)).toBe(12)
  })

  it('饱和上限：cap 在 saturationConn，不是原始 required*2', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 10, aggFeeds: false, satConn: 5 },
      hostCap: 12,
    })
    // required*2=20，远超 satConn=5 → 封在 min(hostCap=12, satConn=5)=5
    expect(caps.catchUpFloor()).toBe(5)
  })

  it('saturationConn 未测出（<=0）→ 只用 hostCap 兜底', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 100, aggFeeds: false, satConn: 0 },
      hostCap: 12,
    })
    expect(caps.catchUpFloor()).toBe(12)
  })
})

describe('stallGuard：卡顿守卫', () => {
  it('非近期卡顿 → 闭嘴（cap=hostCap, floor=0）', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const { caps } = setup({ bw: {}, stallAt: 100_000 - STALL_WINDOW_MS - 1, hostCap: 6 })
    expect(caps.stallGuard()).toEqual({ cap: 6, floor: 0 })
  })

  it('近期卡顿但无样本 → 闭嘴', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const { caps } = setup({ bw: { hasSamples: false }, stallAt: 100_000 - 1000, hostCap: 6 })
    expect(caps.stallGuard()).toEqual({ cap: 6, floor: 0 })
  })

  it('peakAgg<=0 → 必须闭嘴（不许落进「真慢型」把地板顶穿）', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const { caps } = setup({
      bw: { hasSamples: true, peakAgg: 0, aggFeeds: false, retain: 0, satConn: 20 },
      stallAt: 100_000 - 1000,
      hostCap: 12,
    })
    expect(caps.stallGuard()).toEqual({ cap: 12, floor: 0 })
  })

  it('真慢型：peakAgg>0 且聚合喂不动、单条没被摊薄 → 地板抬到饱和并发', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const { caps } = setup({
      bw: { hasSamples: true, peakAgg: 1, aggFeeds: false, retain: 1, satConn: 4 },
      stallAt: 100_000 - 1000,
      hostCap: 12,
    })
    expect(caps.stallGuard()).toEqual({ cap: 12, floor: 4 })
  })

  it('摊薄型（经 aggregateFeeds）：聚合够喂却还卡 → 收到 3', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const { caps } = setup({
      bw: { hasSamples: true, peakAgg: 1, aggFeeds: true, retain: 1 },
      stallAt: 100_000 - 1000,
    })
    expect(caps.stallGuard()).toEqual({ cap: 3, floor: 0 })
  })

  it('摊薄型（经 retain）：单条速度优先于聚合——聚合喂不动但单条已摊薄仍判摊薄型', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100_000)
    const dilutedRetain = DILUTION_RETAIN_STEPS[1]![0] - 0.01
    const { caps } = setup({
      bw: { hasSamples: true, peakAgg: 1, aggFeeds: false, retain: dilutedRetain, satConn: 4 },
      stallAt: 100_000 - 1000,
    })
    expect(caps.stallGuard()).toEqual({ cap: 3, floor: 0 })
  })
})

describe('dilutionCap：摊薄帽，两判据取紧，不低于 catchUpFloor', () => {
  it('仅 saturationConn 生效（retain 未摊薄）→ 封在 saturationConn', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 1, aggFeeds: true, satConn: 3, retain: 0.95 },
      hostCap: 6,
    })
    expect(caps.dilutionCap()).toBe(3)
  })

  it('仅 retain 生效（saturationConn 未测出）→ 按 DILUTION_RETAIN_STEPS 封顶', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 1, aggFeeds: true, satConn: 0, retain: 0.6 },
      hostCap: 6,
    })
    // retain=0.6 < 0.70 门槛 → 对应 cap 3
    expect(caps.dilutionCap()).toBe(3)
  })

  it('两者都生效 → 取更紧的那个', () => {
    const { caps } = setup({
      bw: { hasSamples: true, required: 1, aggFeeds: true, satConn: 5, retain: 0.4 },
      hostCap: 6,
    })
    // saturationConn=5，retain=0.4<0.45 → 对应 cap 2；取紧的 2
    expect(caps.dilutionCap()).toBe(2)
  })

  it('不低于 catchUpFloor：原始摊薄帽比地板还紧时，被地板顶回来', () => {
    const { caps } = setup({
      // satConn=10 让 saturationLimit（catchUpFloor 用）足够宽松；retain=0.3 单独把 dilutionCap 的
      // 原始值压到 2；required=10 让 catchUpFloor 的 required*2=20 超过 saturationLimit，
      // 于是 catchUpFloor 被钉在 saturationLimit=10，远高于 dilutionCap 的原始值 2。
      bw: { hasSamples: true, required: 10, aggFeeds: false, satConn: 10, retain: 0.3 },
      hostCap: 12,
    })
    const floor = caps.catchUpFloor()
    expect(floor).toBe(10)
    expect(caps.dilutionCap()).toBe(floor)
  })
})

describe('soloFastCap：单连接够快帽', () => {
  it('存货未过放开线（wall < safe*2）→ 不参与，返回 hostCap', () => {
    const { caps } = setup({
      bw: { hasSamples: true, soloKBps: 99999, required: 1 },
      hostCap: 6,
      safeWall: 5,
    })
    expect(caps.soloFastCap(9)).toBe(6)   // 9 < 5*2=10
  })

  it('门槛按倍速放大：1x 下命中 FAST_SOLO_CONN_STEPS，3x 下同一 solo 值不再命中该档', () => {
    const soloKBps = FAST_SOLO_KBPS * 1.5   // 750：1x 下命中「≥500」档(cap 3)，3x 下需要 ≥1500 才命中
    const { caps: at1x } = setup({ bw: { hasSamples: true, soloKBps, required: 1 }, hostCap: 6, rate: 1, safeWall: 5 })
    expect(at1x.soloFastCap(20)).toBe(3)
    const { caps: at3x } = setup({ bw: { hasSamples: true, soloKBps, required: 1 }, hostCap: 6, rate: 3, safeWall: 5 })
    expect(at3x.soloFastCap(20)).toBe(6)   // 未命中任何档 → 不咬人
  })

  it('不低于 catchUpFloor', () => {
    const { caps } = setup({
      bw: { hasSamples: true, soloKBps: FAST_SOLO_CONN_STEPS[0]![0] * 2, required: 10, aggFeeds: false, satConn: 20 },
      hostCap: 12,
      safeWall: 5,
    })
    // 表值命中最高档 cap=2；catchUpFloor（聚合喂不动，required*2=20 封在 satLimit=12）远大于 2
    const floor = caps.catchUpFloor()
    expect(floor).toBeGreaterThan(2)
    expect(caps.soloFastCap(20)).toBe(floor)
  })

  it('solo=0（未测到）→ 不咬人，返回 hostCap', () => {
    const { caps } = setup({ bw: { hasSamples: true, soloKBps: 0, required: 1 }, hostCap: 6, safeWall: 5 })
    expect(caps.soloFastCap(20)).toBe(6)
  })
})

describe('aggregateKneeCap：聚合拐点帽', () => {
  it('找到拐点 → min(hostCap, knee+1)', () => {
    const { caps } = setup({ bw: { kneeConn: 4 }, hostCap: 12 })
    expect(caps.aggregateKneeCap()).toBe(5)
  })
  it('未找到拐点（<=0）→ hostCap', () => {
    const { caps } = setup({ bw: { kneeConn: 0 }, hostCap: 12 })
    expect(caps.aggregateKneeCap()).toBe(12)
  })
})

describe('reset：清掉存货阶梯的迟滞记忆', () => {
  it('reset 后再调用不受此前迟滞状态影响', () => {
    const { caps } = setup({ bw: { hasSamples: true, required: 1, aggFeeds: true } })
    // 先落到 step=1（cap 表值 3），wallStep 钉在 1
    expect(caps.wallConnCap(3, 5)).toBe(3)
    // 未 reset 时，wall=6 被迟滞钉住在 step=1（同「迟滞」用例：阈值是 safe*1.0*1.25=6.25，6<6.25）
    expect(caps.wallConnCap(6, 5)).toBe(3)
    caps.reset()
    // reset 后 wallStep 回到放开档（length=4），迟滞记忆清空：同样的 wall=6 直接按原始阶梯判定
    // safe=5：6 < 5*1.5=7.5 → 落在 step=2，表值 4（不再被此前的 step=1 记忆钉住）
    expect(caps.wallConnCap(6, 5)).toBe(4)
  })
})
