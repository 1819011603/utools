/**
 * 自愈调参环（useVideoAutoTune）的行为钉子——重点是 `applyEffectiveRate`（实际生效倍速的计算）。
 *
 * `docs/player.md`「自动最佳倍速」那条钉的四条规则都在这：
 *   autoRateCap = max(2, desiredRate)；bufferRich 免掉 20s 流畅门槛；
 *   算出目标一次到位（不再按 0.25x 步长爬）；turbo 3.5~5x 默认关闭（不在本模块——见测试 1 的注记）。
 *
 * 只调 `applyEffectiveRate()` / `resetRateCooldown()` / `setBoost()` 这几个函数本身，
 * 不触发 `watch(playbackRate,...)` / `watch(autoBestRate,...)` / `watch([strategy,...],...)`
 * 那几条响应式监听（默认非 immediate、post-flush，光调用 `useVideoAutoTune(deps)` 不会同步触发它们）。
 * 这样可以完全避开 `useToast()`（Nuxt UI 自动导入）与 `classifyTier`/`saveLearnedProfile`
 * （composables/videoSiteRules.ts 自动导入，只在 `selfHeal` 里用）——两者都不 stub，测试面保持窄。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, computed } from 'vue'
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoServerTier } from './useVideoServerTier'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoEngine } from './useVideoEngine'
import type { TierParams } from '../videoSiteRules'
import { useVideoAutoTune, type VideoAutoTuneDeps } from './useVideoAutoTune'

const RATE_HOLD_MS = 25000
const RATE_UP_SMOOTH_SECS = 20
const RATE_DOWN_CONFIRM_MS = 8000

/**
 * `applyEffectiveRate` 的惰性/确认期判据全部读 `performance.now()`，且 `lastAutoRateAt` 初值是 0——
 * 也就是说**第一次调用**的惰性期判定也是「真实 now() − 0」。不全局 mock 掉的话，第一次调用是否
 * 越过 25s 惰性期就取决于进程已经跑了多久，非确定。所以整份文件统一用一个可控时钟，
 * 默认给一个足够大的初值（让「首次调用」总能越过惰性期），需要精确控制间隔的用例再改 `mockNow`。
 */
let mockNow = 1_000_000

/**
 * 同样出于「异步 watch 副作用」的原因 stub 掉 useToast：手动模式下 `setRate()` 改了
 * playbackRate.value，下一 tick 会触发 `watch(playbackRate,...)`，autoBestRate=false 时
 * 它会在 rate 超过 maxFluentRate 时调 `useToast()`（Nuxt UI 自动导入，测试环境里未定义）。
 * 我们不测 toast 文案本身（那需要专门 await nextTick 才能可靠断言），只静音掉避免未处理异常。
 */
vi.stubGlobal('useToast', () => ({ add: vi.fn() }))

interface StrategyKnobs {
  playableSecs?: number
  maxFluentRate?: number
  healthZone?: 'panic' | 'low' | 'healthy'
  targetConn?: number
  aggregateScales?: boolean
  perConnKBps?: number
  segMbps?: number
}

interface FakeSetupOpts {
  playbackRate?: number
  desiredRate?: number
  autoBestRate?: boolean
  boostRatePref?: number
  guardRateCeiling?: number
  isHls?: boolean
  lowSecs?: number
  strategy?: StrategyKnobs
  smoothSecs?: number
  isStalling?: boolean
}

function setup(o: FakeSetupOpts = {}) {
  const media = {
    isHls: ref(o.isHls ?? true),
    videoEl: ref<{ playbackRate: number }>({ playbackRate: o.playbackRate ?? 1 }),
    playbackRate: ref(o.playbackRate ?? 1),
    desiredRate: ref(o.desiredRate ?? 1),
    autoBestRate: ref(o.autoBestRate ?? true),
    boostRatePref: ref(o.boostRatePref ?? 2),
  } as unknown as VideoMediaState

  const tier = {
    guardRateCeiling: ref(o.guardRateCeiling ?? Infinity),
    effectiveTierParams: computed(() => ({ lowSecs: o.lowSecs ?? 8 } as unknown as TierParams)),
  } as unknown as VideoServerTier

  const conn = {
    dualChannel: ref(false),
    dualChannelUnavailable: computed(() => false),
  } as unknown as VideoConnStrategy

  const sk = o.strategy ?? {}
  const engine = {
    strategy: ref({
      playableSecs: sk.playableSecs ?? 0,
      maxFluentRate: sk.maxFluentRate ?? 1,
      healthZone: sk.healthZone ?? 'healthy',
      targetConn: sk.targetConn ?? 4,
      aggregateScales: sk.aggregateScales ?? true,
      perConnKBps: sk.perConnKBps ?? 0,
      segMbps: sk.segMbps ?? 0,
    }),
    stall: {
      isStalling: ref(o.isStalling ?? false),
      getSmoothSecs: () => o.smoothSecs ?? RATE_UP_SMOOTH_SECS,
      stallCountInWindow: () => 0,
    },
    // 不是本文件要测的东西，但 `watch(playbackRate, ...)` 是 useVideoAutoTune 内部注册的、
    // 非 immediate/post-flush 的监听——我们在用例里直接改 media.playbackRate.value 时会异步
    // 触发它并调用 engine.primePrefetch()；不 stub 会在事件循环下一轮抛未处理 rejection
    // （TypeError: engine.primePrefetch is not a function），污染测试输出。给个 no-op 静音即可，
    // 这个调用本身不是本文件要断言的行为。
    primePrefetch: vi.fn(),
  } as unknown as VideoEngine

  const deps: VideoAutoTuneDeps = { media, tier, conn, engine }
  const tune = useVideoAutoTune(deps)
  return { tune, media, tier, conn, engine }
}

beforeEach(() => {
  mockNow = 1_000_000
  vi.spyOn(performance, 'now').mockImplementation(() => mockNow)
})
afterEach(() => { vi.restoreAllMocks() })

describe('autoRateCap：max(2, desiredRate)', () => {
  it('desiredRate=1 → 上限 2（默认档不参与放大）', () => {
    const { tune, media } = setup({ desiredRate: 1 })
    expect(tune.autoRateCap.value).toBe(2)
    media.desiredRate.value = 3.5
    expect(tune.autoRateCap.value).toBe(3.5)
  })
  // 注：turbo 3.5~5x「默认关闭」这条不在本模块——那个开关（turboRate）活在
  // useVideoMediaState.ts（ref(false)），菜单档位过滤活在 useVideoUiControls.ts；
  // 本模块只负责「喂给它高 desiredRate 时正确跟着放大上限」，这就是上面这条在测的。
})

describe('applyEffectiveRate：守卫上限优先，绕过一切其它判据', () => {
  it('guard 低于当前 playbackRate → 立即压到 max(1, guard)，不看 autoBestRate/健康区', () => {
    const { tune, media } = setup({ playbackRate: 2, guardRateCeiling: 1, autoBestRate: true })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)
  })
})

describe('applyEffectiveRate：手动模式（autoBestRate=false）只受 guard 钳制', () => {
  it('effective = min(desiredRate, guard)，不管带宽模型', () => {
    const { tune, media } = setup({
      autoBestRate: false, desiredRate: 2.5, guardRateCeiling: Infinity, playbackRate: 1,
      strategy: { maxFluentRate: 0.5 },   // 带宽模型认为撑不住，手动模式应无视它
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(2.5)
  })
  it('guard 比 desiredRate 更紧时被钳制', () => {
    const { tune, media } = setup({ autoBestRate: false, desiredRate: 3, guardRateCeiling: 1.5, playbackRate: 1 })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1.5)
  })
})

describe('applyEffectiveRate：一次到位（不设步长上限）', () => {
  it('算出的目标远高于当前值时一次调用直接跳过去，不逐 0.25 爬', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true,
      strategy: { maxFluentRate: 8, healthZone: 'healthy' },
      smoothSecs: RATE_UP_SMOOTH_SECS,   // 满足「已流畅 20s」
    })
    tune.applyEffectiveRate()
    // target = min(autoRateCap=max(2,8)=8, modelCeil=8, guard=Infinity) 向下对齐 0.25 = 8
    expect(media.playbackRate.value).toBe(8)
  })
})

describe('applyEffectiveRate：bufferRich 免掉 20s 流畅门槛', () => {
  it('playableSecs 达标（≥max(lowSecs*2,60)）+ 未卡顿 → 即使 smoothSecs=0 也照样提速', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true, lowSecs: 8,
      strategy: { maxFluentRate: 8, healthZone: 'healthy', playableSecs: 61 },   // max(16,60)=60，61 达标
      smoothSecs: 0, isStalling: false,
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(8)
  })

  it('对照组：playableSecs 不达标 + smoothSecs<20 → 不提速（证明 bufferRich 是特例豁免不是普遍绕过）', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true, lowSecs: 8,
      strategy: { maxFluentRate: 8, healthZone: 'healthy', playableSecs: 10 },   // 远不到 60
      smoothSecs: 0, isStalling: false,
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)
  })
})

describe('applyEffectiveRate：惰性期节流一般提速', () => {
  it('25s 惰性期内第二次调用不再提速，过了惰性期才生效', () => {
    const start = mockNow
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true,
      strategy: { maxFluentRate: 8, healthZone: 'healthy' },
      smoothSecs: RATE_UP_SMOOTH_SECS,
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(8)   // 首次：已到位

    // 构造第二次场景：先人为把 playbackRate 打回 1（模拟外部改动），惰性期内不该再动
    media.playbackRate.value = 1
    mockNow = start + RATE_HOLD_MS - 1
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)   // 惰性期内被挡住

    mockNow = start + RATE_HOLD_MS + 1
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(8)   // 惰性期过后，同样的目标生效
  })
})

describe('applyEffectiveRate：healthZone 非 healthy 时禁止提速', () => {
  it('panic 时即使目标更高也不动', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true,
      strategy: { maxFluentRate: 8, healthZone: 'panic' },
      smoothSecs: RATE_UP_SMOOTH_SECS,
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)
  })
  it('low 时同样不动', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true,
      strategy: { maxFluentRate: 8, healthZone: 'low' },
      smoothSecs: RATE_UP_SMOOTH_SECS,
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)
  })
})

describe('applyEffectiveRate：降速需 8s 确认期', () => {
  it('目标低于当前时不立即降，需持续 8s；期间维持，过后一次降到位', () => {
    const start = mockNow
    const { tune, media } = setup({
      playbackRate: 4, desiredRate: 4, autoBestRate: true,
      strategy: { maxFluentRate: 1, healthZone: 'healthy' },   // 目标被压到 1（远低于当前 4）
    })
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(4)   // 第一次：只是启动确认计时器，还不降

    mockNow = start + RATE_DOWN_CONFIRM_MS - 1
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(4)   // 未满 8s，仍不降

    mockNow = start + RATE_DOWN_CONFIRM_MS + 1
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)   // 满 8s 后一次降到位（不是逐步降）
  })
})

describe('applyEffectiveRate：nudgePending（resetRateCooldown）立即生效', () => {
  it('绕开惰性期与 20s 流畅门槛，立刻跳到目标；用后即清，不重复兑现', () => {
    const { tune, media } = setup({
      playbackRate: 1, desiredRate: 8, autoBestRate: true,
      strategy: { maxFluentRate: 8, healthZone: 'healthy' },
      smoothSecs: 0,   // 不满足「连续流畅 20s」——若无 nudge，本该被挡住（见「一般提速」用例组的等价条件）
    })
    tune.resetRateCooldown()
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(8)   // nudge 绕开了流畅门槛，立即到位

    // 第二次调用（未再调用 resetRateCooldown）：nudge 已经用掉，回到普通提速规则，
    // 此时刚设置过 lastAutoRateAt，仍在 25s 惰性期内，且 smoothSecs 仍是 0 —— 不会再变
    media.playbackRate.value = 1   // 模拟外部改动，验证第二次不会再"抢跑"
    mockNow += 100
    tune.applyEffectiveRate()
    expect(media.playbackRate.value).toBe(1)
  })
})

describe('setBoost / boostRate：长按叠加不进入闭环稳态值', () => {
  it('setBoost(true) 只改 videoEl.playbackRate，不改 media.playbackRate', () => {
    const { tune, media } = setup({ playbackRate: 1.5, boostRatePref: 3 })
    tune.setBoost(true)
    expect(media.videoEl.value!.playbackRate).toBe(3)   // max(boostRatePref=3, playbackRate=1.5)
    expect(media.playbackRate.value).toBe(1.5)          // 闭环稳态值不受影响
    expect(tune.boostActive.value).toBe(true)
  })

  it('setBoost(false) 把 videoEl.playbackRate 还原回 playbackRate（不是 boost 值）', () => {
    const { tune, media } = setup({ playbackRate: 1.5, boostRatePref: 3 })
    tune.setBoost(true)
    tune.setBoost(false)
    expect(media.videoEl.value!.playbackRate).toBe(1.5)
    expect(tune.boostActive.value).toBe(false)
  })

  it('boostRate 计算值与 boostActive 无关，恒为 max(boostRatePref||2, playbackRate)', () => {
    const { tune, media } = setup({ playbackRate: 1.5, boostRatePref: 3 })
    expect(tune.boostRate.value).toBe(3)
    media.playbackRate.value = 5
    expect(tune.boostRate.value).toBe(5)   // playbackRate 超过 boostRatePref 时以它为准
    // boostRatePref=0（未设置）时退回默认 2
    media.boostRatePref.value = 0
    media.playbackRate.value = 1
    expect(tune.boostRate.value).toBe(2)
  })
})
