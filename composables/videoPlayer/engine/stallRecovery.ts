/**
 * 「货在手上却播不动」的自救。
 *
 * 症状（实测截图）：徽标写着**缓冲 305.7s**、0 线程、0 KB/s，画面却盖着转圈遮罩不动，
 * 控制台每秒刷 `mediaError bufferStalledError fatal: false`。三个读数放在一起就能定位：
 *   · `缓冲 305.7s` 是**有效可播**（MSE + JS 预取缓存，见 bufferMeter.getCachedAhead）——数据确实在手上；
 *   · `0 线程 / 0 KB/s` 是**正常**的：缓存已到「预加载时长」，预取按设计停了，全命中缓存自然没有网速；
 *   · 真正的问题只有一个：**MSE 在播放头那一点是空的**，hls.js 卡在一个空洞前面。
 *
 * hls.js 自己的 gapController 只肯跨 `maxBufferHole`（我们给 0.5s）那么大的洞，
 * 再大就只能等 streamController 把那一段填上；而它若把该片记成 `gap`、或它认为
 * 「缓冲已经够了」（MSE 窗口里洞**后面**还有 30s），那一段就永远填不上——
 * 于是 `bufferStalledError` 每秒复发、nudge 0.2s 也跨不过去，画面就此冻住。
 * 这种局面下用户看到的是最难归因的一幕：**缓冲几百秒，却一直转圈**。
 *
 * 所以补一条我们自己的出路，两级，都要求「播放头处 MSE 为空」且「手上确实有货」：
 *   ① 洞不大（≤ HOLE_JUMP_MAX）→ 直接跳到洞后面那段的起点。等于把 maxBufferHole 临时放大，
 *      代价是丢掉最多几秒画面，比冻住强得多；
 *   ② 前方压根没有现成的缓冲段 → `hls.startLoad(currentTime)` 让它从播放头重新拉，
 *      要的那几片多半就在 JS 预取缓存里，`fLoader` 会同步喂回去（所以这一步通常是瞬间的）。
 *
 * **两条硬约束**（都是踩过的坑的反面）：
 *   · **播放头处 MSE 有货就一律不动手**——那时的卡顿是解码/GPU/倍速侧的事
 *     （判读看统计面板的掉帧），乱跳只会把正常播放打断；
 *   · **有冷却**（`FIX_COOLDOWN`）：hls.js 自己的 nudge 每秒都在动 currentTime，
 *     不设冷却就会两套恢复机制互相打断，表现成画面反复小跳。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/** 洞小于这个值就直接跳过去（秒）。再大就不跳了——那不像「一片没 append 上」，跳过去要丢的内容太多 */
const HOLE_JUMP_MAX = 3
/** 两次自救的最小间隔（ms）：别跟 hls.js 自己的 nudge 抢方向盘 */
const FIX_COOLDOWN_MS = 2000
/** 播放头冻住多久算真卡（ms）。心跳兜底那条用它——事件不一定每次都来 */
const FROZEN_MS = 2000

export interface StallRecoveryDeps {
  getVideoEl: () => HTMLVideoElement | undefined
  getHls: () => any
  /** MSE 前向：播放头所在那段缓冲的剩余秒数（0 = 播放头处就是空的） */
  getAheadBuffered: (v: HTMLVideoElement) => number
  /** 有效可播：MSE + JS 预取缓存。>0 说明数据在手上，卡的不是网络 */
  getCachedAhead: (v: HTMLVideoElement) => number
}

export function useStallRecovery(deps: StallRecoveryDeps) {
  let lastFixAt = 0
  let lastTime = -1
  let lastMoveAt = 0

  /** 播放头后面最近一段缓冲的起点（没有就返回 null） */
  const nextBufferedStart = (v: HTMLVideoElement): number | null => {
    for (let i = 0; i < v.buffered.length; i++) {
      const s = v.buffered.start(i)
      if (s > v.currentTime + 0.1) return s
    }
    return null
  }

  const attempt = (reason: string) => {
    const v = deps.getVideoEl()
    const hls = deps.getHls()
    if (!v || !hls || v.paused || v.seeking) return
    // 播放头处有货 → 不是空洞问题（解码/GPU/倍速侧），绝不动手
    if (deps.getAheadBuffered(v) > 0.5) return
    // 手上一点货都没有 → 这是网络问题，交给预取/重试那套，别在这儿瞎跳
    if (deps.getCachedAhead(v) < 1) return
    if (Date.now() - lastFixAt < FIX_COOLDOWN_MS) return
    lastFixAt = Date.now()

    const next = nextBufferedStart(v)
    if (next !== null && next - v.currentTime <= HOLE_JUMP_MAX) {
      console.warn(`[stall] ${reason}：MSE 在 ${v.currentTime.toFixed(1)}s 处有个 ${(next - v.currentTime).toFixed(2)}s 的空洞，跳到 ${next.toFixed(1)}s`)
      v.currentTime = next + 0.05
      return
    }
    console.warn(`[stall] ${reason}：播放头前方 MSE 为空而预取缓存有货，从 ${v.currentTime.toFixed(1)}s 重新加载`)
    try { hls.startLoad(v.currentTime) } catch {}
  }

  /** hls.js 报了非致命 bufferStalledError（每秒复发那个）。这是最准的入口 */
  const onBufferStalled = () => attempt('hls.js 报缓冲停滞')

  /**
   * 心跳兜底：`bufferStalledError` 并非每次冻结都发（同 stallTracker 那条
   * 「事件之外还要位置采样兜底」的理由）。自己每秒比一次播放头。
   */
  const tick = () => {
    const v = deps.getVideoEl()
    if (!v || v.paused || v.seeking) { lastTime = -1; return }
    const now = Date.now()
    if (lastTime < 0 || Math.abs(v.currentTime - lastTime) > 0.05) {
      lastTime = v.currentTime
      lastMoveAt = now
      return
    }
    if (now - lastMoveAt >= FROZEN_MS) attempt('心跳发现播放头冻住')
  }

  /** 换流/切集时清掉采样，否则上一集的时间点会被当成「冻住」 */
  const reset = () => { lastTime = -1; lastFixAt = 0 }

  return { onBufferStalled, tick, reset }
}
