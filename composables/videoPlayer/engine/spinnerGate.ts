/**
 * 转圈遮罩的延迟闸门 + FLV 兜底熄灯心跳。
 *
 * 从 `useVideoEngine` 拆出来：这一整套只跟「该不该亮转圈」有关，跟 hls.js 生命周期无关。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type { Ref } from 'vue'

export interface SpinnerGateDeps {
  getVideoEl: () => HTMLVideoElement | undefined
  isFlv: Ref<boolean>
  /** `isBuffering` 的唯一点亮/熄灭入口都在本模块（别再别处直接写它） */
  isBuffering: Ref<boolean>
  /** 仅 MSE 的前向秒数 */
  getAheadBuffered: (v: HTMLVideoElement) => number
  /** MSE + 预取缓存的有效可播秒数 */
  getCachedAhead: (v: HTMLVideoElement) => number
}

export function useSpinnerGate(deps: SpinnerGateDeps) {
  const { getVideoEl, isFlv, isBuffering, getAheadBuffered, getCachedAhead } = deps

  /**
   * 转圈遮罩的延迟闸门（`isBuffering` 的唯一点亮入口）。
   *
   * 治的是**拖进度时那一下 0~1s 的无意义转圈**（实测：徽标显示「缓冲 24.1s」还在转）。
   * 成因是**判据用错了量**：新位置的分片往往已经在预取缓存里，`fLoader` 同步就返回，
   * 但 hls.js 仍要 demux + append、浏览器还要解码，这几百毫秒 **MSE 前向确实是 0**
   * ——按 MSE 判就点亮转圈，几百毫秒后 FRAG_BUFFERED 又熄掉。那一圈不携带任何信息：
   * 数据一个字节都不缺，缺的只是 append。
   *
   * 所以闸门到点后按**两级判据**决定要不要亮：
   *  · 150ms：只有「**有效可播**（MSE + 预取缓存）也不足 2s」才亮——那才是真在等网络。
   *  · 800ms：货在手上却还没播起来 = 反常（曾经真出过：分片一个接一个 200、缓冲恒 0、
   *    一直转圈，pLoader 同步回调把 MediaSource 撞坏了）。这种必须让用户看见，否则
   *    画面冻住却什么提示都没有，更难归因。
   *
   * 两个定时器都**在到点时自检**（播放头已前进 / 已暂停 / 已 seek 走 → 直接放弃），
   * 因此不需要在 seeked/playing/canplaythrough 那一堆事件里逐个 cancel——漏一个就是长亮。
   */
  const SPINNER_SOFT_MS = 150   // 有货就先别喊
  const SPINNER_HARD_MS = 800   // 有货却还在等 → 无条件亮
  let spinnerSoftTimer: ReturnType<typeof setTimeout> | null = null
  let spinnerHardTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * FLV（尤其直播）**只认「播放头动没动」，不能拿存货秒数判**。
   *
   * `liveBufferLatencyChasing` 的本意就是贴着缓冲边缘播 → 前方存货天然长期不足 1s，
   * 于是 HLS 那套「不足 2s = 在等网络」在**正常播放时也恒成立**：每一发 `waiting`
   * 都把转圈点亮，而熄灯判据（ahead ≥ 1）又多半不成立 → 「画面在播，加载中一直闪」。
   *
   * 采样由 flvTick（250ms）和闸门共同推进；**必须真的观察到一次前进**才算在播，
   * 所以起播那一刻（还没动过）返回 false，转圈照亮。
   */
  const FLV_STALL_MS = 700
  let flvLastTime = -1
  let flvLastMoveAt = 0
  const flvAdvancing = (v: HTMLVideoElement): boolean => {
    const now = performance.now()
    const t = v.currentTime
    if (flvLastTime >= 0 && Math.abs(t - flvLastTime) > 0.01) flvLastMoveAt = now
    flvLastTime = t
    return flvLastMoveAt > 0 && now - flvLastMoveAt < FLV_STALL_MS
  }

  /** 到点时还在等吗：暂停/正在 seek/前方已有 MSE 存货 → 都不算 */
  const stillStalled = (): HTMLVideoElement | null => {
    const v = getVideoEl()
    if (!v || v.paused || v.seeking) return null
    if (isFlv.value) return flvAdvancing(v) ? null : v
    return getAheadBuffered(v) < 2 ? v : null
  }
  const armBufferingGate = () => {
    if (!spinnerSoftTimer) spinnerSoftTimer = setTimeout(() => {
      spinnerSoftTimer = null
      const v = stillStalled()
      if (v && getCachedAhead(v) < 2) isBuffering.value = true   // 连预取缓存都没货 = 真在等网络
    }, SPINNER_SOFT_MS)
    if (!spinnerHardTimer) spinnerHardTimer = setTimeout(() => {
      spinnerHardTimer = null
      if (stillStalled()) isBuffering.value = true
    }, SPINNER_HARD_MS)
  }
  const cancelBufferingGate = () => {
    if (spinnerSoftTimer) { clearTimeout(spinnerSoftTimer); spinnerSoftTimer = null }
    if (spinnerHardTimer) { clearTimeout(spinnerHardTimer); spinnerHardTimer = null }
  }
  /**
   * 转圈的兜底熄灯：以「真的在播」为地面真值，不指望事件齐全。
   *
   * `isBuffering` 只由 playing/canplaythrough/seeked/FRAG_BUFFERED 熄，而**正播着的视频
   * 不会再补发 `playing`** —— 任何一次漏发都会让转圈一直盖在正常播放的画面上
   *（同 stallTracker 那条「事件之外还要位置采样兜底」的理由）。
   * 两条路都要跑：HLS 挂在 hlsTick 里，FLV 挂在 flvTick 里。
   */
  const dropSpinnerIfPlaying = () => {
    const v = getVideoEl()
    if (!v) return
    if (isFlv.value) {
      // 采样每拍都要做（不能只在亮着时做），否则 flvAdvancing 的基准是几秒前的旧值
      const moving = flvAdvancing(v)
      if (isBuffering.value && moving && !v.paused && !v.seeking && v.readyState >= 3) isBuffering.value = false
      return
    }
    if (isBuffering.value && !v.paused && !v.seeking && v.readyState >= 3 && getAheadBuffered(v) >= 1) {
      isBuffering.value = false
    }
  }

  /**
   * FLV 专属心跳：**只做兜底熄灯这一件事**。
   *
   * 不复用 HLS 那个心跳 —— 它里面全是预取/卡顿自愈/档位统计，对 FLV 一件都不适用。
   * 不做这一拍的表现就是「画面在播，转圈一直盖着」：直播流上 `waiting` 来得很勤
   *（`armBufferingGate` 因此点亮），而熄灯那几个事件一个都不会再来。
   */
  let flvTickTimer: ReturnType<typeof setInterval> | null = null
  const startFlvTick = () => {
    stopFlvTick()
    flvLastTime = -1
    flvLastMoveAt = 0
    // 250ms 而不是 1s：这一拍既是熄灯的唯一时机、也是「播放头动没动」的采样源，
    // 1s 一拍会让转圈在正常播放的画面上多盖将近一秒
    flvTickTimer = setInterval(dropSpinnerIfPlaying, 250)
  }
  const stopFlvTick = () => {
    if (flvTickTimer) { clearInterval(flvTickTimer); flvTickTimer = null }
  }

  return { armBufferingGate, cancelBufferingGate, dropSpinnerIfPlaying, startFlvTick, stopFlvTick }
}

export type SpinnerGate = ReturnType<typeof useSpinnerGate>
