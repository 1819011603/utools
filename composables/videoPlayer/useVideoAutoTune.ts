/**
 * 自愈调参环：以「真实卡顿 + 缓冲健康区」为反馈，自动分档、走抗卡阶梯、按 host 记忆最优起点，
 * 并据带宽实测算出「实际生效倍速」。
 *
 * 与引擎分开的理由：引擎负责「把流放起来」，这里负责「放起来之后不断往好的方向调」——
 * 前者是一次性流程，后者是每秒跑一次的闭环，混在一起两边都难读。
 * 引擎的心跳会调 selfHeal（由装配层登记，见 registerTickHook）。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoServerTier } from './useVideoServerTier'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoEngine } from './useVideoEngine'

// ── 自动最佳倍速的调参常数 ──
const RATE_STEP = 0.25
// 自动模式默认最高提到 2x。倍速菜单里选了更高的档位就以那个为上限（见 autoRateCap）——
// 「自动」的语义是「在 [1, 上限] 内按带宽取值」，而 desiredRate 默认是 1，
// 若直接拿它当上限，上限就恒等于 1，勾选框看着有效实际一步都迈不出去（这就是原来「失效」的原因）。
const AUTO_RATE_CEILING = 2
// 惰性期：任何一次自动调整后至少保持这么久再考虑下一次，避免倍速被实测带宽抖动带着来回蹭
const RATE_HOLD_MS = 25000
// 提速的附加门槛：必须已经连续流畅这么久（真实无停顿）。带宽算得出来 ≠ 播得稳
const RATE_UP_SMOOTH_SECS = 20
// 降速确认期：带宽算出「撑不住当前倍速」要连续这么久才真降（瞬时掉速不动，等它自己回来）
const RATE_DOWN_CONFIRM_MS = 8000

const SMOOTH_RELAX_SECS = 30   // 连续流畅超此秒数 → 放松（解除降速守卫、可回收资源）

export interface VideoAutoTuneDeps {
  media: VideoMediaState
  tier: VideoServerTier
  conn: VideoConnStrategy
  engine: VideoEngine
}

export function useVideoAutoTune(deps: VideoAutoTuneDeps) {
  const { media, tier, conn, engine } = deps
  const { isHls, videoEl, playbackRate, desiredRate, autoBestRate } = media
  const { strategy, stall } = engine

  let lastAutoRateAt = 0     // 上次自动调整时刻（惰性期起点）
  let downSince = 0          // 「带宽撑不住」持续起点（0=当前撑得住）
  let nudgeUntil = 0         // 用户刚改上限：这之前的一次提速可跳过「连续流畅」门槛（点了要有反应）

  /**
   * 自动模式的倍速上限：默认 2x；用户在倍速菜单里选了更高的档位就以那个为准。
   * 选 ≤1 的档位（0.5x 之类）不参与——自动模式只在 ≥1 里取值，想慢放请关掉自动。
   */
  const autoRateCap = computed(() => Math.max(AUTO_RATE_CEILING, desiredRate.value))

  const setRate = (r: number) => {
    playbackRate.value = r
    if (videoEl.value) videoEl.value.playbackRate = r
  }

  /**
   * 计算并应用「实际生效倍速」：
   *  - 自动最佳倍速开启：在 [1, autoRateCap] 内朝「带宽可持续上限」逼近，每次一个 0.25x 台阶。
   *    提速要三个条件同时成立（带宽够 + 缓冲健康 + 已连续流畅 20s），降速只要带宽持续不够 8s。
   *    任何一次调整后进入 25s 惰性期——不停微调比慢一点更难受，且倍速一变就要重排预取节奏。
   *  - 关闭：完全用用户选择倍速（可 <1 手动慢放），立即生效。
   */
  const applyEffectiveRate = () => {
    const guard = tier.guardRateCeiling.value   // 抗卡守卫上限（PANIC=1，否则 Infinity）
    // 抗卡阶梯第一步「先降速」：生效倍速高于守卫上限时立即压下（绕过惰性期/步进，保命优先）
    if (isHls.value && guard < playbackRate.value - 1e-6) {
      setRate(Math.max(1, guard))
      lastAutoRateAt = performance.now()
      downSince = 0
      return
    }
    if (!autoBestRate.value || !isHls.value) {
      const eff = Math.min(desiredRate.value, guard)      // 手动：听用户，但仍受抗卡守卫钳制
      if (eff !== playbackRate.value) setRate(eff)
      return
    }

    const now = performance.now()
    const cur = playbackRate.value
    // 目标 = min(自动上限, 带宽可持续, 守卫上限)，≥1，向下对齐 0.25 台阶（不过度承诺）
    const max = strategy.value.maxFluentRate
    const rawCeil = Math.min(autoRateCap.value, max > 0 ? max : 1, guard)
    const target = Math.max(1, Math.floor(rawCeil / RATE_STEP + 1e-6) * RATE_STEP)

    if (target < cur - 1e-6) {
      // 降速：先确认这不是一瞬间的掉速
      if (!downSince) downSince = now
      if (now - downSince < RATE_DOWN_CONFIRM_MS) return
      downSince = 0
      lastAutoRateAt = now
      setRate(Math.max(target, cur - RATE_STEP))
      return
    }
    downSince = 0
    if (target < cur + 1e-6) return                        // 已到位
    // 提速：惰性期内不动；缓冲不健康就别提（带宽模型只看得到下载，看不到 append/解码）
    if (now - lastAutoRateAt < RATE_HOLD_MS) return
    if (strategy.value.healthZone !== 'healthy') return
    // 连续流畅够久才提；用户刚手动抬上限则给一次「立刻迈一步」的额度
    if (stall.getSmoothSecs() < RATE_UP_SMOOTH_SECS && now > nudgeUntil) return
    nudgeUntil = 0
    lastAutoRateAt = now
    setRate(Math.min(target, cur + RATE_STEP))
  }

  /** 用户主动改目标倍速：解除惰性期，允许立即迈一步（之后继续按 25s 节奏逼近） */
  const resetRateCooldown = () => {
    lastAutoRateAt = 0
    downSince = 0
    nudgeUntil = performance.now() + 5000   // 只给 5s 额度，用不上就作废，别留着日后突然提速
  }

  // 倍速变化：立即顶格补取；若超出当前带宽可流畅倍速，提示（不拦截）
  watch(playbackRate, (rate) => {
    if (isHls.value) engine.startOnePrefetch()
    if (autoBestRate.value) return  // 自动模式下不弹提示（本就按带宽取值）
    const max = strategy.value.maxFluentRate
    if (max > 0 && rate > max + 0.05) {
      useToast().add({ title: `当前带宽最高流畅约 ${max}x，${rate}x 可能卡顿`, color: 'amber', timeout: 3000 })
    }
  })
  // 带宽实测变化 / 开关切换 / 抗卡守卫变化 时，重新评估生效倍速
  watch([strategy, autoBestRate, tier.guardRateCeiling], () => applyEffectiveRate())

  let lastLearnSaveAt = 0

  /** 每秒跑一次（引擎心跳里调） */
  const selfHeal = () => {
    if (!isHls.value) return
    const s = strategy.value
    const params = tier.effectiveTierParams.value

    // 1) 自动分档（仅 auto 模式）：实测 + 聚合可并行 → classifyTier；真实卡顿则强制降档
    if (tier.tierIsAuto.value) {
      const perBps = s.perConnKBps * 8 * 1024
      const segBps = s.segMbps * 1e6
      let t = classifyTier(perBps, segBps, s.aggregateScales, playbackRate.value, params.maxConn)
      const recentStalls = stall.stallCountInWindow(60000)   // 近 1 分钟真实卡顿次数
      if (recentStalls >= 2) t = 'bad'
      else if (recentStalls >= 1 && t === 'good') t = 'medium'
      tier.autoTier.value = t
    }

    // 2a) 差档濒卡 → 自动开双通道换出口（属连接策略，与倍速无关，手动/自动模式都可）
    if (s.healthZone === 'panic' && params.dualChannelAuto
        && !conn.dualChannel.value && !conn.dualChannelUnavailable.value) {
      conn.dualChannel.value = true
    }

    // 2b) 先降速：仅「自动最佳倍速」开启时生效——用户手动锁定倍速则尊重其选择，绝不强制降速
    //     （手动模式下应急完全交给跳片，见 skipSegment：倍速>1 时仅在几乎冻结才跳）。
    //     迟滞防抖：濒卡(panic)才压到 1x，恢复到健康(healthy)才放回，中间(low)保持不动。
    if (autoBestRate.value) {
      if (s.healthZone === 'panic') tier.guardRateCeiling.value = 1
      else if (s.healthZone === 'healthy' && tier.guardRateCeiling.value !== Infinity) {
        tier.guardRateCeiling.value = Infinity
      }
    } else if (tier.guardRateCeiling.value !== Infinity) {
      tier.guardRateCeiling.value = Infinity   // 手动模式：确保降速守卫不残留，倍速立即听用户
    }

    // 3) 按 host 记忆：连续流畅够久，把当前档位/双通道效果学到 host（下次同站直接从最优起步）
    const now = performance.now()
    if (tier.currentHost.value && stall.getSmoothSecs() > SMOOTH_RELAX_SECS && now - lastLearnSaveAt > 30000) {
      lastLearnSaveAt = now
      saveLearnedProfile(tier.currentHost.value, {
        learnedTier: tier.effectiveTierName.value,
        bestConcurrency: s.targetConn,
        dualChannelHelped: conn.dualChannel.value,
      })
    }
  }

  return { applyEffectiveRate, resetRateCooldown, autoRateCap, selfHeal }
}

export type VideoAutoTune = ReturnType<typeof useVideoAutoTune>
