/**
 * 起播预缓冲（从 useVideoEvents.ts 下沉）：缓冲够了就起播，剩下的交给并行预取在播放中补齐。
 *
 * 与事件处理分开的理由：这块是「什么时候开始播」的独立闭环（门槛随卡顿递增、随连续流畅归零），
 * 而事件处理是「播起来之后每个事件做什么」。`scheduleAutoPlay` / `refreshStallEscalation` 还被
 * `onWaiting` 复用（连续卡顿主动缓冲），所以由这里返回给调用方。
 */
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoEngine } from '../useVideoEngine'

/**
 * 起播预缓冲：缓冲够了就起播，剩下的交给并行预取在播放中补齐；
 * 慢站最多等 AUTOPLAY_MAX_WAIT_MS 兜底避免卡死。非 HLS 固定等 2s。
 *
 * **`PLAYABLE_SECS` 是这一块唯一的秒数常量，单位是「能播多少秒」不是「缓冲多少秒」**
 * ——两者差一个倍速，所以用它的地方一律 × 倍速。3x 下缓冲 6 秒只够播 2 秒；
 * 拿固定秒数当门槛等于高倍速下过早起播（马上再卡）、1x 下过晚起播（干等）。
 *
 * 起播门槛的两档只差一个倍数：
 * · 定位类起播（切集 / 拖进度 / 重载）—— 画面停着，每多一秒都在盯转圈 → 够播 2 秒就走，
 *   后面由预取追；真追不上还有抗卡环兜。
 * · 首次冷启动（刚点开页面，人还在看别的）—— 多等一会儿攒厚一点划算 → 翻倍，够播 4 秒。
 *
 * 实测这两档配合「存货不够就少开线程」（见 useHlsPrefetch 的 SAFE_WALL_SECS）才有意义：
 * 不收窄并发的话，门槛要的这点量本身就被 6~12 条并行下载拖慢了。
 */
const PLAYABLE_SECS = 2               // 「够播几秒」：起播门槛与卡顿归零窗口共用
const AUTOPLAY_MAX_WAIT_MS = 8000

/**
 * 卡一次，下一次起播的门槛就翻一倍（封顶 ×8）。
 *
 * 治的是**慢源上「多次短频卡顿」**——尤其拖完进度那一下：缓冲清零后按「够播 2 秒」就出画面，
 * 而慢源两秒后供给还没跟上，于是又卡；浏览器只要拿到一帧就继续播，于是卡→播→卡→播 抖成锯齿。
 * 用户感受上，**五次一秒的卡远比一次四秒的等难受**（每一次都要重新对焦画面和声音）。
 *
 * 所以门槛不是常量而是「这条源最近有多不争气」的函数：连着卡就多攒一点再出画面，
 * 连续流畅一段时间后自动归零（见 recentStalls）。翻倍而不是线性加：
 * 真慢的源线性爬要卡七八次才够，指数两三次就到位。
 */
const STALL_ESCALATION_CAP = 8
/**
 * 门槛归零要的「连续流畅」墙钟秒数，同样是 `PLAYABLE_SECS` × 倍速（`smoothSecs` 是墙钟）：
 * 1x 要顺畅播过 2 秒，3x 要 6 秒。倍速越高，源要供上的吞吐越高、缓冲消耗得越快，
 * **「刚好喘匀这几秒」的偶然性越大，免罪就该越难拿**。
 *
 * **原来是固定 20s，太长了**：断网 / 换 Wi-Fi 必然制造卡顿，而那些卡顿**不是这条源不争气**，
 * 却一样把门槛翻上去。于是网络一恢复，`onWaiting` 就主动 pause 去攒 `2^stalls` 的门槛
 * ——1x 下 stalls=2 就是 24s，实际必然吃满 `AUTOPLAY_MAX_WAIT_MS` 的 8s 封顶。
 * 也就是说**网络早通了，画面还要再等 8 秒**，而 20s 的下坡路让这个惩罚在整段恢复期里一直挂着。
 *
 * 倍速夹在 1~3x：慢放不缩短（0.5x 本来就不卡，没理由更容易免罪），超快倍速（3.5~5x）不加码
 * ——那一档本来就必卡（多数浏览器 4x 往上还直接静音），让它把归零线拉到 10s 只是把
 * 「网络早通了还在等」重演一遍，而那正是这条归零线存在的理由。
 */
const stallDecaySmoothSecs = (rate: number) =>
  PLAYABLE_SECS * Math.min(3, Math.max(1, rate))

/** 起播门槛（秒缓冲）。relocating = 切集/拖进度/重载那一档；stalls = 近期卡顿次数 */
const autoPlayTarget = (rate: number, relocating: boolean, stalls = 0): number => {
  const byRate = PLAYABLE_SECS * Math.max(1, rate)
  const base = relocating ? byRate : byRate * 2   // 冷启动攒厚一倍
  return base * Math.min(STALL_ESCALATION_CAP, 2 ** Math.max(0, stalls))
}
/**
 * 起播就绪的轮询间隔。原来是 300ms 固定轮询 + 起手先空等 500ms——
 * 那 500ms 是纯自造延迟（每次切集都赔一次），而 300ms 的粒度意味着「其实早就够了」
 * 还要再等最多 300ms。现在立刻跑第一拍，之后 100ms 一拍。
 * 每一拍只读 `video.buffered`（不发请求、不遍历分片表），加密到 100ms 也可忽略。
 */
const AUTOPLAY_POLL_MS = 100
export function useAutoplayScheduler(deps: { media: VideoMediaState; engine: VideoEngine }) {
  const { media, engine } = deps
  const { videoEl, isHls, isBuffering, playbackRate, isMuted } = media

  let delayedPlayTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 起播这一发 play()。失败分两类，处理完全不同——早先一律按「被浏览器拦了」处理，
   * 于是自动跳集时表现成「跳过去了但停在暂停，还得自己点一下」：
   *
   * · `NotAllowedError` = 真的被自动播放策略拦了（安卓上「点选集 → 几秒后才 play()」，
   *   用户手势的有效期早过了）。改静音重播一次——宁可先出画面，声音等用户下次触碰时恢复
   *  （`useVideoUiControls.restoreSound`，任何点按都解除）。
   * · 其余（**主要是 `AbortError`**）= 这一发被新的 load 请求打断了。切集时 `videoKey++` 重建
   *   `<video>`、hls.js 紧接着 attach + startLoad，play() 撞上去就是这个。它跟权限毫无关系，
   *   静音重播照样会被打断，然后旧代码就彻底放弃了。这种只需要过一会儿再试。
   */
  const attemptPlay = async (tries: number): Promise<void> => {
    const video = videoEl.value
    if (!video) return
    try {
      await video.play()
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        if (media.autoMuted.value) {                  // 静音也不行 = 真没辙，把静音还回去
          console.log('自动播放被阻止（静音也不行）:', e.message)
          video.muted = isMuted.value = media.autoMuted.value = false
          return
        }
        video.muted = true
        media.autoMuted.value = true
        isMuted.value = true
        return await attemptPlay(tries)
      }
      if (tries >= 3) {
        console.log('自动播放放弃（重试 3 次仍被打断）:', e?.name, e?.message)
        return
      }
      console.log(`自动播放被打断（${e?.name}），400ms 后重试`)
      await new Promise(r => setTimeout(r, 400))
      return await attemptPlay(tries + 1)
    }
  }

  // ── 起播预缓冲 ──
  /**
   * 近期卡顿次数（供门槛递增用）。**连续流畅够 `stallDecaySmoothSecs()` 秒就清零**——门槛涨上去容易，
   * 不给它一条下坡路的话，源恢复正常之后每次拖进度还得干等十几秒（比卡顿更烦）。
   * 计数只认 stallTracker 的真实停顿（排除 seek 与用户 pause），不认我们自己的加载等待。
   */
  let recentStalls = 0
  let lastSeenStallCount = 0
  const refreshStallEscalation = () => {
    const n = engine.stall.stallCount.value
    if (n > lastSeenStallCount) { recentStalls += n - lastSeenStallCount; lastSeenStallCount = n }
    // 倍速现读：自动最佳倍速会在播放中改它，用起播那一刻的值会算错归零时机
    if (engine.stall.smoothSecs.value >= stallDecaySmoothSecs(playbackRate.value)) recentStalls = 0
    return recentStalls
  }
  engine.registerTickHook(refreshStallEscalation)   // 每秒心跳刷新一次

  const scheduleAutoPlay = () => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
    isBuffering.value = true
    const startTs = performance.now()
    // 定位类起播（切集/拖进度/重载）走低门槛。engine 在 loadVideo 里置位，这里只读一次：
    // 起播成功后 clearRelocating 会把它清掉，读晚了会退回冷启动那一档
    const relocating = engine.isRelocatingStart()

    const tryPlay = () => {
      const video = videoEl.value
      if (!video) { delayedPlayTimer = null; return }
      const ahead = engine.getAheadBuffered(video)
      const waited = performance.now() - startTs
      // 门槛每一拍现算：倍速可能在等待期间被自愈环改掉（尤其「自动最佳倍速」刚测出带宽那一下）
      const target = autoPlayTarget(playbackRate.value, relocating, recentStalls)
      // FLV（直播）不能干等这 2 秒：`liveBufferLatencyChasing` 就是要贴着缓冲边缘播，
      // 存货永远攒不厚，等满 2s 只是白盖 2 秒转圈 → 能播就播
      const ready = media.isFlv.value
        ? video.readyState >= 3 || waited >= 2000
        : !isHls.value
          ? waited >= 2000
          : ahead >= target || waited >= AUTOPLAY_MAX_WAIT_MS
      if (!ready) {
        delayedPlayTimer = setTimeout(tryPlay, AUTOPLAY_POLL_MS)
        return
      }
      delayedPlayTimer = null
      console.log(`开始自动播放（预缓冲 ${ahead.toFixed(1)}s / 门槛 ${target.toFixed(1)}s @${playbackRate.value}x`
        + `，等待 ${(waited / 1000).toFixed(1)}s${recentStalls ? `，近期卡顿 ${recentStalls} 次已抬高门槛` : ''}）`)
      engine.clearRelocating()
      isBuffering.value = false
      void attemptPlay(0)
    }

    // 立刻跑第一拍。原来起手 setTimeout(…, 500) 是无条件的自造延迟：
    // 预热命中、分片已在缓存里时，这 500ms 就是全部的等待时间
    tryPlay()
  }

  /** 这一次加载有没有挂过起播（非 HLS 那条路走 canplay，而它会反复触发） */
  let autoPlayArmed = false

  // HLS 走 MANIFEST_PARSED 触发起播；destroyHls 时要清掉在飞的定时器
  engine.registerAutoPlayHook(scheduleAutoPlay)
  engine.registerDestroyHook(() => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
    autoPlayArmed = false   // loadVideo 一律先 destroyHls，正好当「换了一条流」的信号
  })

  /** 非 HLS 那条路 canplay 会反复触发：只许挂一发起播。返回 true 表示这一发该起播 */
  const armCanPlayOnce = (): boolean => {
    if (autoPlayArmed) return false
    autoPlayArmed = true
    scheduleAutoPlay()
    return true
  }

  /** 页面卸载时清掉在飞的定时器（原来在 useVideoEvents.disposeEvents 里） */
  const disposeAutoplay = () => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
  }

  return { scheduleAutoPlay, refreshStallEscalation, getRecentStalls: () => recentStalls, armCanPlayOnce, disposeAutoplay }
}
