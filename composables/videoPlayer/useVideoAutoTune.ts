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

// 自动最佳倍速：每步最大幅度与两次调整的最小间隔（避免频繁抖动来回调）
const RATE_STEP = 0.25
const RATE_COOLDOWN_MS = 10000
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

  let lastAutoRateAt = 0

  /**
   * 计算并应用「实际生效倍速」：
   *  - 自动最佳倍速开启：在 [1, 用户选择倍速] 内朝「带宽可持续上限」逼近，但每次最多迈一个
   *    0.25x 台阶（升/降都是），且两次调整间隔必须 ≥10s。
   *  - 关闭：完全用用户选择倍速（可 <1 手动慢放），立即生效。
   */
  const applyEffectiveRate = () => {
    const guard = tier.guardRateCeiling.value   // 抗卡守卫上限（PANIC=1，否则 Infinity）
    // 抗卡阶梯第一步「先降速」：生效倍速高于守卫上限时立即压下（绕过冷却/步进，保命优先）
    if (isHls.value && guard < playbackRate.value - 1e-6) {
      const g = Math.max(1, guard)
      playbackRate.value = g
      if (videoEl.value) videoEl.value.playbackRate = g
      return
    }
    if (autoBestRate.value && isHls.value) {
      // 目标倍速 = min(所选, 可持续, 守卫上限)，≥1，对齐到 0.25 台阶
      const max = strategy.value.maxFluentRate
      const rawCeil = Math.min(desiredRate.value, max > 0 ? max : desiredRate.value, guard)
      const target = Math.max(1, Math.round(rawCeil / RATE_STEP) * RATE_STEP)
      const cur = playbackRate.value
      if (Math.abs(target - cur) < 1e-6) return           // 已到位
      const now = performance.now()
      if (now - lastAutoRateAt < RATE_COOLDOWN_MS) return // 冷却中：本次不动
      const next = target > cur ? Math.min(target, cur + RATE_STEP) : Math.max(target, cur - RATE_STEP)
      lastAutoRateAt = now
      playbackRate.value = next
      if (videoEl.value) videoEl.value.playbackRate = next
    } else {
      const eff = Math.min(desiredRate.value, guard)      // 手动：听用户，但仍受抗卡守卫钳制
      if (eff !== playbackRate.value) {
        playbackRate.value = eff
        if (videoEl.value) videoEl.value.playbackRate = eff
      }
    }
  }

  /** 用户主动改目标倍速：允许立即迈一步（仍是 0.25 台阶，之后继续按 10s 节奏逼近） */
  const resetRateCooldown = () => { lastAutoRateAt = 0 }

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

  return { applyEffectiveRate, resetRateCooldown, selfHeal }
}

export type VideoAutoTune = ReturnType<typeof useVideoAutoTune>
