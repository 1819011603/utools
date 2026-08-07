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
// 倍速取值的对齐粒度（0.25 的整数倍，避免出现 1.37x 这种数）。
// 注意它**不再是每次调整的步长上限**：早先每次只挪一个台阶，从 1x 爬到 3x 要 8 次 × 25s 惰性期
// ≈ 200 秒，慢到用户以为没生效。现在算出目标就直接给到，惰性期只管「多久才允许再调一次」。
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
  let nudgePending = false   // 用户刚改上限：下一次提速可跳过台阶与「连续流畅」门槛（点了要有反应）

  // 长按倍速（手势层的「按住加速」）。它是**临时叠加**，不写进 playbackRate——
  // 后者是闭环算出来的稳态值，被临时值污染的话松手后自愈环会以为用户改了倍速。
  // 于是这里只改 <video> 元素本身，闭环照常跑，setRate 每次都把叠加重新贴上去。
  const boostActive = ref(false)
  const BOOST_RATE = 2

  /**
   * 自动模式的倍速上限：默认 2x；用户在倍速菜单里选了更高的档位就以那个为准。
   * 选 ≤1 的档位（0.5x 之类）不参与——自动模式只在 ≥1 里取值，想慢放请关掉自动。
   */
  const autoRateCap = computed(() => Math.max(AUTO_RATE_CEILING, desiredRate.value))

  const setRate = (r: number) => {
    playbackRate.value = r
    if (videoEl.value) videoEl.value.playbackRate = boostActive.value ? Math.max(BOOST_RATE, r) : r
  }

  /** 长按加速的开关。松手立刻回到闭环当前认定的倍速（而不是回到 1x） */
  const setBoost = (on: boolean) => {
    if (boostActive.value === on) return
    boostActive.value = on
    if (videoEl.value) {
      videoEl.value.playbackRate = on ? Math.max(BOOST_RATE, playbackRate.value) : playbackRate.value
    }
  }

  /** 长按期间实际生效的倍速（HUD 上要显示真实值，用户可能本来就在 3x） */
  const boostRate = computed(() => Math.max(BOOST_RATE, playbackRate.value))

  /**
   * 计算并应用「实际生效倍速」：
   *  - 自动最佳倍速开启：在 [1, autoRateCap] 内取可持续上限，**一次到位**（不走 0.25x 台阶）。
   *    上限取「带宽模型」与「缓冲实况」两者中更宽松的那个：缓冲已经很深（≥2×吃紧阈值且没在卡）
   *    就直接按 autoRateCap 走——深缓冲是比带宽估算更硬的证据，估算保守时不该拖着不提速。
   *    提速还要缓冲健康 + 已连续流畅 20s（缓冲很深时免掉流畅时长这一条，见 bufferRich）；
   *    降速只要目标持续低于当前 8s。
   *    节流全部交给 25s 惰性期（`RATE_HOLD_MS`）——它管「多久允许再调一次」，
   *    幅度不再另行设限：爬台阶的做法从 1x 到 3x 要 200 秒，慢到像是没生效。
   *  - 用户刚勾上开关 / 刚改上限（nudge 待兑现）：跳过惰性期与流畅时长门槛立刻给到目标值。
   *    这是明确的用户动作，必须立刻有反应；后续再由闭环按缓冲实况上下调。
   *  - 关闭：完全用用户选择倍速（可 <1 手动慢放），立即生效。
   */
  const applyEffectiveRate = () => {
    const guard = tier.guardRateCeiling.value   // 抗卡守卫上限（PANIC=1，否则 Infinity）
    // 抗卡阶梯第一步「先降速」：生效倍速高于守卫上限时立即压下（绕过惰性期与确认期，保命优先）
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
    const s = strategy.value
    // 缓冲实况：有效可播（MSE + 预取缓存）已远超吃紧阈值且没在卡 → 供给明显充裕，
    // 带宽模型（实测每连接速度 × 并发 ÷ 码率）在预取已经吃饱、采样变稀时会偏保守，这时以实况为准。
    const bufferRich = s.playableSecs >= Math.max(tier.effectiveTierParams.value.lowSecs * 2, 60)
      && !stall.isStalling.value
    const modelCeil = s.maxFluentRate > 0 ? s.maxFluentRate : 1
    // 目标 = min(自动上限, 上限证据, 守卫上限)，≥1，向下对齐到 0.25 的整数倍
    const rawCeil = Math.min(autoRateCap.value, bufferRich ? autoRateCap.value : modelCeil, guard)
    const target = Math.max(1, Math.floor(rawCeil / RATE_STEP + 1e-6) * RATE_STEP)

    if (target < cur - 1e-6) {
      // 降速：先确认这不是一瞬间的掉速
      if (!downSince) downSince = now
      if (now - downSince < RATE_DOWN_CONFIRM_MS) return
      downSince = 0
      lastAutoRateAt = now
      setRate(target)          // 一次降到位：慢慢往下挪只是让卡顿多持续几十秒
      return
    }
    downSince = 0
    if (target < cur + 1e-6) return                        // 已到位
    // 用户刚勾开关/刚改上限：不看惰性期也不等流畅时长，立刻给到目标值（点了必须马上有反应）。
    // 额度按「兑现」清而不按时间过期：点击那一刻带宽模型可能还没采到样（maxFluentRate=0）→ target 就是 1，
    // 分支根本走不到；旧实现给的 5s 墙钟一过额度就作废，之后只能干等下一次惰性期（踩过）。
    if (nudgePending) {
      nudgePending = false
      lastAutoRateAt = now
      setRate(target)
      return
    }
    // 自动提速：惰性期内不动；缓冲不健康就别提（带宽模型看不到 append/解码这一段）
    if (now - lastAutoRateAt < RATE_HOLD_MS) return
    if (s.healthZone !== 'healthy') return
    // 缓冲很深就不必等「连续流畅」：该计时器在暂停时恒为 0（见 useStallTracker.onPause），
    // 起播被浏览器拦截 / 用户手动暂停期间它永远攒不够 20s，会把提速彻底锁死（踩过）。
    if (!bufferRich && stall.getSmoothSecs() < RATE_UP_SMOOTH_SECS) return
    lastAutoRateAt = now
    setRate(target)            // 一次提到位；撑不住会在 8s 确认期后自动降回来
  }

  /** 用户主动改上限 / 刚勾上开关：解除惰性期，并挂一次「立刻跳到目标」的额度 */
  const resetRateCooldown = () => {
    lastAutoRateAt = 0
    downSince = 0
    // 挂着不过期：条件一满足就兑现（多半就在同一次调用里），兑现即清。
    // 关掉自动会走手动分支，这张额度到下次开启前都不会被用到，不存在「日后突然提速」。
    nudgePending = true
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
  // 勾选/取消「自动最佳倍速」是用户动作，必须立刻生效：走 nudge 通道直接跳到目标，
  // 否则要等惰性期 + 连续流畅 20s 才动第一步，看着就像勾了没反应。
  watch(autoBestRate, () => { resetRateCooldown(); applyEffectiveRate() })
  // 带宽实测 / 缓冲实况 / 抗卡守卫变化时，重新评估生效倍速（每秒心跳都会刷新 strategy）
  watch([strategy, tier.guardRateCeiling], () => applyEffectiveRate())

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

  return { applyEffectiveRate, resetRateCooldown, autoRateCap, selfHeal, boostActive, boostRate, setBoost }
}

export type VideoAutoTune = ReturnType<typeof useVideoAutoTune>
