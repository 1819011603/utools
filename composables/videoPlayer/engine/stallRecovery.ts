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
/** 阶梯第 ③ 级的微跳距离（秒）：要够跨过被标成 `gap` 的那一片的开头，又不至于丢掉一句台词 */
const NUDGE_SEC = 0.5

export interface StallRecoveryDeps {
  getVideoEl: () => HTMLVideoElement | undefined
  getHls: () => any
  /** MSE 前向：播放头所在那段缓冲的剩余秒数（0 = 播放头处就是空的） */
  getAheadBuffered: (v: HTMLVideoElement) => number
  /** 有效可播：MSE + JS 预取缓存。>0 说明数据在手上，卡的不是网络 */
  getCachedAhead: (v: HTMLVideoElement) => number
  /** 四级自救全部无效：把话说清楚（写 errorMessage），别让用户对着冻住的画面猜 */
  onGiveUp?: () => void
  /** fLoader 的活动记录：hls.js 最近一次跟我们要片/我们最近一次交货是什么时候 */
  getLoaderActivity?: () => { lastLoadAt: number; lastServedAt: number; lastSn: unknown; lastUrl: string }
  /** 这一片在不在 JS 预取缓存里 */
  isSegCached?: (url: string) => boolean
}

export function useStallRecovery(deps: StallRecoveryDeps) {
  let lastFixAt = 0
  let lastTime = -1
  let lastMoveAt = 0
  let step = 0        // 自救阶梯的进度，播放头一动就归零

  /** 播放头后面最近一段缓冲的起点（没有就返回 null） */
  const nextBufferedStart = (v: HTMLVideoElement): number | null => {
    for (let i = 0; i < v.buffered.length; i++) {
      const s = v.buffered.start(i)
      if (s > v.currentTime + 0.1) return s
    }
    return null
  }

  /**
   * 同一招重复十次无效就该换招（实测日志：`startLoad(1987.3)` 连打 10 次，播放头一动不动）。
   * 所以按**阶梯**升级，每一级只用一次，播放头一动就整份归零：
   *   ① 跳空洞——洞小的话这一下就好了，代价最小
   *   ② `startLoad(currentTime)`——让 streamController 从播放头重排一次
   *   ③ 微跳 0.5s——跨过被 hls.js 标成 `gap` 的那一片（标了 gap 的片它不会再取，只能绕过去）
   *   ④ `recoverMediaError()`——重建 MediaSource。append 通道本身坏了时这是唯一的出路，
   *      也是最后一手：它会重新 attach，代价是画面黑一下
   * 四级都过不去就**停手并说明白**：继续原地打转只是把控制台刷满，而画面早就冻住了，
   * 用户需要的是「换条线路试试」这句话。
   */
  /**
   * 冻屏现场一次打全。**这一幕靠单个读数永远查不出来**（「缓冲 305s」既可能是 MSE 也可能全是
   * JS 缓存，「0 线程/0 KB/s」在全命中缓存时是正常的），所以把分岔口需要的量一起打出来：
   *
   *   · `askedAgoMs` 小 = hls.js 还在跟我们要片 → 卡在我们这边（取不到 / 交不出去）；
   *     很大 = **它压根没在要** → 问题在 hls.js 侧（认为缓冲够了、或那一片被记成已缓冲/gap），
   *     这时改预取毫无用处，只能逼它重排（阶梯 ①②③）。
   *   · `frag.gap` 为真 = hls.js 已经把那一片判成空洞，它**再也不会去取**，只能绕过去（阶梯 ②）。
   *   · `ranges` 为空而 `cached` 很大 = 数据全在 JS 缓存、一个字节都没进 MSE（append 通道的问题）。
   */
  const snapshot = (v: HTMLVideoElement, hls: any) => {
    const ct = v.currentTime
    const ranges: string[] = []
    for (let i = 0; i < v.buffered.length; i++) ranges.push(`${v.buffered.start(i).toFixed(1)}~${v.buffered.end(i).toFixed(1)}`)
    const level = hls?.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = hls?.levels?.[level]?.details?.fragments ?? []
    const cur = frags.find(f => f.start <= ct + 0.1 && ct < f.end + 0.1)
    const act = deps.getLoaderActivity?.()
    const now = Date.now()
    console.warn('[stall] 现场', {
      at: +ct.toFixed(2),
      readyState: v.readyState,
      rate: v.playbackRate,
      mseAhead: +deps.getAheadBuffered(v).toFixed(2),
      cached: +deps.getCachedAhead(v).toFixed(1),
      ranges: ranges.length ? ranges.join(' , ') : '(MSE 全空)',
      hlsState: hls?.streamController?.state ?? '?',
      frag: cur ? `sn=${cur.sn} ${cur.start.toFixed(1)}~${cur.end.toFixed(1)}${cur.gap ? ' gap!' : ''}` : '(播放头不在任何分片里)',
      fragCached: cur ? deps.isSegCached?.(cur.url) : null,
      askedAgoMs: act?.lastLoadAt ? now - act.lastLoadAt : null,
      servedAgoMs: act?.lastServedAt ? now - act.lastServedAt : null,
      askedSn: act?.lastSn ?? null,
    })
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
    snapshot(v, hls)   // 动手之前先留一份现场：动过之后就分不清是谁的因果了

    const at = v.currentTime
    const next = nextBufferedStart(v)
    // ① 洞小就直接跳过去（等于临时放大 maxBufferHole）。这一级不占阶梯——它每次都值得先试
    if (next !== null && next - at <= HOLE_JUMP_MAX) {
      console.warn(`[stall] ${reason}：MSE 在 ${at.toFixed(1)}s 处有个 ${(next - at).toFixed(2)}s 的空洞，跳到 ${next.toFixed(1)}s`)
      v.currentTime = next + 0.05
      return
    }

    step++
    if (step === 1) {
      console.warn(`[stall] ${reason}：播放头前方 MSE 为空而预取缓存有货，从 ${at.toFixed(1)}s 重新加载`)
      try { hls.startLoad(at) } catch {}
    } else if (step === 2) {
      console.warn(`[stall] ${reason}：重新加载无效，微跳 ${NUDGE_SEC}s 绕过可能被标记为 gap 的那一片`)
      v.currentTime = at + NUDGE_SEC
    } else if (step === 3) {
      console.warn(`[stall] ${reason}：仍然冻住，重建 MediaSource（recoverMediaError）`)
      try { hls.recoverMediaError() } catch {}
    } else {
      console.error(`[stall] ${reason}：四级自救全部无效，停在 ${at.toFixed(1)}s。这一条源大概率喂不进解码器，换条线路试试`)
      deps.onGiveUp?.()
    }
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
      step = 0          // 又在往前播了 → 阶梯归零，下次卡顿重新从最轻的那一级开始
      return
    }
    if (now - lastMoveAt >= FROZEN_MS) attempt('心跳发现播放头冻住')
  }

  /** 换流/切集时清掉采样，否则上一集的时间点会被当成「冻住」 */
  const reset = () => { lastTime = -1; lastFixAt = 0; step = 0 }

  return { onBufferStalled, tick, reset }
}
