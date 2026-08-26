/**
 * 播放引擎：hls.js 生命周期、预取/缓存/卡顿三件套的装配、实时心跳、自愈调参、加载超时。
 *
 * 依赖方向单向：engine → (media, conn, tier, playlist)。反向的「重载视频」是通过
 * 各模块 deps 里的 reload 回调回调进来的，不能在这里 import 它们。
 */
import type HlsType from 'hls.js'
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoServerTier } from './useVideoServerTier'
import { createPlaylistLoaderFactory } from './engine/playlistLoader'
import { useRecomposite } from './engine/recomposite'
import { buildHlsConfig } from './engine/hlsConfig'
import { useLoadTimeout } from './engine/loadTimeout'
import { useHlsErrorHandler, failMessageOf } from './engine/hlsErrors'
import { useStallRecovery } from './engine/stallRecovery'
import { probeMp4Head } from './engine/mp4Duration'
import { holdPiP, reclaimPiP, releasePiPHolder, isPiPHeld, startPiPTracking, resyncPiPAspect } from './engine/pipHandoff'
import { onNetChange, isRecovering } from './engine/netWatch'
import { clearDirectDead } from './probeStore'

export interface VideoEngineDeps {
  media: VideoMediaState
  conn: VideoConnStrategy
  tier: VideoServerTier
  /** 进度存取的稳定键（按需取址的站点真实地址每次都变，不能用 videoUrl） */
  progressKey: () => string
  getSavedProgress: (url: string) => number
  /**
   * 就地重新取一次播放地址并重载（按需取址的站点才做得到）。
   * true = 已换新地址，调用方别再报错。`silent` 见 useVideoPlaylistCtl.refetchCurrentUrl
   */
  refetchUrl: (silent?: boolean) => Promise<boolean>
}


// 动态导入 hls.js（避免 SSR 问题），模块级缓存一次
let Hls: typeof HlsType | null = null

export function useVideoEngine(deps: VideoEngineDeps) {
  const { media, conn, tier } = deps
  const {
    videoUrl, videoEl, isHls, isLoading, isBuffering, isPlaying, isVideoLoaded,
    errorMessage, currentTime, duration, bufferedPercent, videoKey,
    hlsConfig, hlsStats, playbackDiag, playbackRate, desiredRate, autoBestRate, volume, isMuted,
  } = media

  let hls: HlsType | null = null


  /**
   * 起播锚点：刷新/恢复进度起播时，播放头还停在 0、但要起播的位置在 pendingStartPos。
   * 预取以此为起点（见 useHlsPrefetch 的 getStartPosition）——起播即在正确位置全力并行预取，
   * 既不浪费带宽下开头，也不会退化成「只有 hls.js 串行下 1 片」。到位/用户跳转后清 0。
   */
  let pendingStartPos = 0
  let startAnchorActive = false
  const clearStartAnchor = () => { startAnchorActive = false; pendingStartPos = 0 }
  const isArrivingAtStart = (ct: number) => startAnchorActive && Math.abs(ct - pendingStartPos) < 3
  /**
   * 本次交给 hls.js `startPosition` 的位置。与 pendingStartPos 分开存：后者是预取锚点、
   * 到位就被 clearStartAnchor 清 0，而 useVideoEvents 在 loadedmetadata 里要知道
   * 「引擎到底把起播位置定在哪」才能判断还要不要补一次 seek（见那里的片尾区兜底）。
   */
  let appliedStartPos = 0
  const getAppliedStartPos = () => appliedStartPos

  /**
   * 本次起播是不是「定位类」（切集 / 重载 / 拖进度），供 useVideoEvents 选起播门槛：
   * 定位类只要「够播 2 秒」就出画面，首次冷启动仍要攒够 6 秒（两档都 × 倍速，
   * 见 useVideoEvents.autoPlayTarget）。
   *
   * 区别在于用户的预期：冷启动时他刚点开、还在看页面，多等两秒攒厚一点划算；
   * 而切集/拖进度时画面是停着的，每多一秒都在盯着转圈——那时「先出画面、边播边补」明显更好。
   */
  let isRelocating = false
  const isRelocatingStart = () => isRelocating
  const clearRelocating = () => { isRelocating = false }

  // ── 预取缓存 + 自适应预取 + 卡顿记录 ──
  const segmentCache = useSegmentCache({ getMaxBufferSizeMB: () => hlsConfig.value.maxBufferSizeMB })
  const {
    prefetchInfo, useCacheForVideo, abortAllPrefetches, startPrefetchCleanup, stopPrefetchCleanup,
    refreshCacheStats, stageSegments,
  } = segmentCache

  const prefetch = useHlsPrefetch({
    getHls: () => hls,
    getVideoEl: () => videoEl.value,
    getProxyUrl: conn.getProxyUrl,
    cache: segmentCache,
    getPlaybackRate: () => playbackRate.value,
    // 「预加载时长」= 往后预取多少秒就够了，到量即停（0/负数视为不限）
    getPrefetchTargetSecs: () => {
      const t = hlsConfig.value.maxBufferLength
      return t && t > 0 ? t : Infinity
    },
    // 起播锚点：定位未到位前，预取从 pendingStartPos 起（而非 currentTime=0）
    getStartPosition: () => (startAnchorActive ? pendingStartPos : 0),
    // 存货保险线：缓存够播的秒数低于它就按阶梯收敛并发（见 useHlsPrefetch 的 WALL_CONN_STEPS）
    getSafeWallSecs: () => hlsConfig.value.safeWallSecs,
    // 切集/换流会清掉实测样本，那一刻用按 host 学到的并发当阶梯地板（见 catchUpFloor）
    getColdStartConn: () => tier.learnedConcurrency.value,
    // 卡顿守卫的输入：真实停顿的时间戳（stall 在下面才声明，这里是惰性读取，调用时早已初始化）
    getLastStallAt: () => stall.lastStallAt.value,
    // 直连+代理双通道：仅在「开启 + 该分片直连可达」时加一条本站代理 lane（不同 origin → 各享 6 连接）。
    // 需注入头/走代理的源直连 lane 会 403，退回单 lane。
    getLaneUrls: (url: string) => {
      if (conn.dualChannel.value && conn.isDirectMode(url)) return [url, conn.getProxyPassthroughUrl(url)]
      return [conn.getProxyUrl(url)]
    },
    // 服务器档位参数（好/中/差预设 + 页面覆盖）：抗卡阈值/超时/安全系数/并发下限/预取深度全从这里读
    getTierParams: () => tier.effectiveTierParams.value,
  })
  const {
    getAheadBuffered, getCachedAhead, createHlsFragLoader, triggerAdaptivePrefetch,
    startOnePrefetch, strategy, resetStrategy, tick: prefetchTick, primePrefetch, getStuckSegment, laneDead,
    reviveLanes, purgePlayedSegments, getLoaderActivity, isSegCached, getSegBuf,
  } = prefetch

  // 双通道实际有没有跑起来：真实请求连续失败会把某条 lane 熔断（见 useHlsPrefetch 的 markLaneFail）。
  // 0 = 直连 lane，1 = 代理 lane（getLaneUrls 的顺序），供 UI 说明「为什么开着却只有一条在跑」。
  const deadLaneLabel = computed(() => {
    const dead = laneDead.value
    if (dead[0]) return '直连'
    if (dead[1]) return '代理'
    return ''
  })

  // 卡顿记录器：以 <video> 真实停顿为地面真值，喂给自愈调参环（selfHeal）
  const stall = useStallTracker(() => videoEl.value)

  /**
   * 「货在手上却播不动」的自救（实现见 ./engine/stallRecovery.ts）：
   * MSE 在播放头处是空的、而预取缓存里有货 → 跳过小空洞 / 从播放头重新加载。
   * 两个入口：hls.js 的非致命 `bufferStalledError`，以及心跳里的播放头冻结采样。
   */
  const stallRecovery = useStallRecovery({
    getVideoEl: () => videoEl.value,
    getHls: () => hls,
    getAheadBuffered,
    getCachedAhead,
    // 冻屏现场要打的两件事：hls.js 还在跟我们要片吗、那一片在缓存里吗
    getLoaderActivity,
    isSegCached,
    // 四级全过不去 → 明确报出来。转圈遮罩自己不会消失，不说话用户只能一直等
    onGiveUp: () => {
      isBuffering.value = false
      errorMessage.value = '画面卡住且四级自救均无效：取回的数据喂不进解码器，换一条线路试试'
    },
  })

  // 清单加载器：命中「探测刚下载过的同一份 m3u8」就省掉一次 RTT（实现见 ./engine/playlistLoader.ts）
  const createHlsPlaylistLoader = createPlaylistLoaderFactory(conn.takeSeededManifest)

  // 聚合下载速度（估算）= 单连接实测速度 × 当前并发。perConnKBps 是当前并发下的实测值，
  // 故乘积能反映「加并发到底换没换来更多总带宽」：双通道真生效则随 6→12 翻倍，被 per-IP 限死则基本不变。
  const aggregateKBps = computed(() => Math.round(strategy.value.perConnKBps * strategy.value.targetConn))
  const aggregateMbps = computed(() => Math.round((aggregateKBps.value * 8 / 1024) * 10) / 10)

  const failMessage = (fallback: string) => failMessageOf(conn.probeVerdict.value, fallback)

  // ── 加载超时（实现见 ./engine/loadTimeout.ts）──
  // 10s 没数据 → 静默重新取址（地址过期比通道判断错常见得多）；15s 还没有 → 报错收场
  const { clearLoadTimeout, startLoadTimeout, markDataReceived } = useLoadTimeout({
    isLoading: () => isLoading.value,
    refetchUrl: () => { void deps.refetchUrl(true) },
    onTimeout: () => {
      errorMessage.value = failMessage('加载超时，视频链接可能已过期或无法访问（403/404）')
      isLoading.value = false
      isBuffering.value = false
      isVideoLoaded.value = false
      destroyHls()
    },
  })

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
  /** 到点时还在等吗：暂停/正在 seek/前方已有 MSE 存货 → 都不算 */
  const stillStalled = (): HTMLVideoElement | null => {
    const v = videoEl.value
    if (!v || v.paused || v.seeking) return null
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

  // ── 实时心跳的外挂钩子 ──
  // 自愈调参环（useVideoAutoTune.selfHeal）、下一集预热（useVideoPrewarm.tick）都挂在这儿，
  // 引擎不反向依赖它们。多播而不是单槽：单槽时后登记的会把前一个静默顶掉
  const tickHooks: Array<() => void> = []
  const registerTickHook = (fn: () => void) => { tickHooks.push(fn) }

  /**
   * ── 网络变了（断网恢复 / 换 Wi-Fi / 切蜂窝 / 回前台发现换过网，见 engine/netWatch）──
   *
   * 这一刻要做四件事，少一件就是「网络明明好了，画面还一直转圈」：
   *   ① **lane 熔断记录整份作废**：出口 IP 一变，之前那些 403/超时的结论一条都不再成立
   *      （熔断本身还有 30s 观察期自愈，但这里能立刻恢复双通道，不用干等）；
   *   ② **可达性结论也一起作废**：`warmProbes` 和「直连是黑洞」都是**上一个网络**测出来的，
   *      换网之后它们不但过期，还会把本可直连的源按在代理上（或反过来）。这两份都只影响
   *      「等多久 / 用哪条」，清掉最多是多探一轮，留着却可能整轮判错；
   *   ③ **让 hls.js 从播放头重新开始加载**：断网期间它多半已经报过 fatal NETWORK_ERROR
   *      停在那儿了，`startLoad()` 是唯一能把它叫起来的动作。**必须带位置**——
   *      不带的话它按断网前的 `nextLoadPosition` 挑片，那个位置早就不是播放头了；
   *   ④ **重开预取**：预取失败不重排队，只靠心跳补——`primePrefetch()` 立刻满上，不等下一拍。
   *
   * 只在真的没在播时才 `startLoad()`：正常播着的流被 startLoad 打断会白丢一次缓冲
   * （回前台那条信号尤其要靠这个判断兜住，切走 30s 回来时缓冲往往是满的）。
   *
   * **一枪打不中就补枪**（`recoverShots`）：刚重连那一两秒请求常常还发不出去，
   * 老代码在这里只 `startLoad()` 一次，打空之后就再没人管，最终仍旧落回
   * 「重新取址 → 重探通道 → 销毁」那条慢路径。所以在恢复窗口里由心跳复查。
   *
   * 但**补枪必须以「一点进展都没有」为条件**：`startLoad(pos)` 会把在途的分片请求全丢掉重排，
   * 慢源上每秒补一枪等于永远下不完第一片——那是把「恢复慢」换成「恢复不了」。
   * 所以三道闩：至少隔 `RECOVER_SHOT_GAP_MS`、缓冲和播放头都没动过、总共不超过 4 枪。
   */
  let recoverShots = 0
  let lastShotAt = 0
  let lastShotAhead = -1
  let lastShotTime = -1
  /** 补枪次数上限：同一招重复十次无效就该换招（同 stallRecovery 的阶梯那条教训） */
  const MAX_RECOVER_SHOTS = 4
  /** 两枪之间至少隔这么久：给上一枪的请求留出真正跑完一片的时间 */
  const RECOVER_SHOT_GAP_MS = 2000
  const shootStartLoad = () => {
    const v = videoEl.value
    if (!v || !hls) return
    // 已经播起来了 → 别打断（正常播着的流被 startLoad 打断会白丢一次缓冲）
    if (!v.paused && v.readyState >= 3 && getAheadBuffered(v) > 0.5) return
    recoverShots++
    lastShotAt = Date.now()
    lastShotAhead = getAheadBuffered(v)
    lastShotTime = v.currentTime
    try { hls.startLoad(v.currentTime) } catch {}
  }
  const onNetChanged = () => {
    reviveLanes()
    conn.invalidateReachCache()
    try { clearDirectDead(new URL(videoUrl.value, location.href).hostname) } catch {}
    if (errorMessage.value.startsWith('网络已断开')) errorMessage.value = ''
    recoverShots = 0
    shootStartLoad()
    primePrefetch()
  }
  /** 心跳里的补枪：恢复窗口内**毫无进展**才再叫一次，见上面 recoverShots 那段 */
  const recoverTick = () => {
    if (!isRecovering() || recoverShots >= MAX_RECOVER_SHOTS) return
    if (Date.now() - lastShotAt < RECOVER_SHOT_GAP_MS) return
    const v = videoEl.value
    if (!v) return
    // 缓冲涨了、或播放头动了 = 上一枪正在见效，别打断它
    if (getAheadBuffered(v) > lastShotAhead + 0.05 || Math.abs(v.currentTime - lastShotTime) > 0.05) return
    shootStartLoad()
  }
  /** 断网时说一句话就够：重试逻辑那边一律等 netWatch，不在没网的时候烧额度（见 hlsErrors） */
  const onNetworkOffline = () => {
    if (!errorMessage.value) errorMessage.value = '网络已断开，恢复后会自动继续'
  }

  // ── 实时心跳：每秒刷新缓冲读数 + 跑闭环预取控制（不依赖 FRAG_BUFFERED，卡顿时也持续工作） ──
  /**
   * `<video>` 的固有尺寸变了（ABR 换到比例不同的画质档，或流里拼了不同分辨率的片段）。
   * 画中画小窗只会自己变大、不会自己变小 → 交给 resyncPiPAspect 重开一次（见那边的说明）。
   *
   * 挂在 `document` 捕获阶段：`resize` 不冒泡，而 `<video>` 会被 `videoKey++` 整个换掉。
   */
  const onIntrinsicResize = (e: Event) => {
    const v = e.target as HTMLVideoElement | null
    if (!v || !v.videoWidth || v !== videoEl.value) return
    void resyncPiPAspect(v)
  }

  let hlsTickTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribeNet: (() => void) | null = null
  let unsubscribePiP: (() => void) | null = null
  const startHlsTick = () => {
    if (hlsTickTimer) return
    document.addEventListener('visibilitychange', onVisibilityChange)
    // 「网络变了」的三个信号（断网恢复 / 换网 / 回前台）统一由 netWatch 归并成一个
    unsubscribeNet = onNetChange(onNetChanged)
    unsubscribePiP = startPiPTracking()   // 小窗尺寸只能在「进入那一刻」拿到，得先挂上
    document.addEventListener('resize', onIntrinsicResize, true)
    window.addEventListener('offline', onNetworkOffline)   // 断网只用来写那句提示，不是恢复动作
    hlsTickTimer = setInterval(() => {
      // 转圈的兜底熄灯：以「真的在播」为地面真值，不指望事件齐全。
      // `isBuffering` 只由 playing/canplaythrough/seeked/FRAG_BUFFERED 熄，而正播着的视频
      // **不会再补发 playing**——任何一次漏发都会让转圈一直盖在正常播放的画面上（同 stallTracker
      // 那条「事件之外还要位置采样兜底」的理由）
      const v = videoEl.value
      if (isBuffering.value && v && !v.paused && !v.seeking && v.readyState >= 3 && getAheadBuffered(v) >= 1) {
        isBuffering.value = false
      }
      stall.tick()   // 绑定/改绑卡顿监听（幂等）+ 刷新连续流畅读数
      recoverTick()   // 刚换过网/刚恢复而还没播起来 → 补一枪 startLoad（见 onNetChanged）
      stallRecovery.tick()   // 播放头冻住而手上有货 → 跳空洞 / 从播放头重拉（bufferStalledError 不一定每次都来）
      prefetchTick()
      refreshCacheStats()   // 面板上的「预取缓存 N 片 / X MB」
      updateHlsStats()
      tickHooks.forEach(fn => fn())
    }, 1000)
  }
  const stopHlsTick = () => {
    if (hlsTickTimer) { clearInterval(hlsTickTimer); hlsTickTimer = null }
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribeNet?.(); unsubscribeNet = null
    unsubscribePiP?.(); unsubscribePiP = null
    document.removeEventListener('resize', onIntrinsicResize, true)
    window.removeEventListener('offline', onNetworkOffline)
  }

  /**
   * 残影修复 + 回前台追赶（实现见 ./engine/recomposite.ts）。
   * 「切走再回来画面糊住 / 卡一下」那一档，跟 hls.js 的生命周期无关，只是共用同一个事件。
   */
  const { videoTransform, forceRecomposite, onVisibilityChange } = useRecomposite({
    isActive: () => !!hls,
    purgePlayed: () => purgePlayedSegments(),
    catchUp: () => {
      // 顺序有讲究：先作废卡顿采样基准，否则后台那几十秒会被回填成一次假卡顿，
      // 自愈环还会据此把倍速压回 1x
      stall.resetSampler()
      stall.tick()
      prefetchTick()
      primePrefetch()   // 不等并发一拍 +1 地爬，立刻按当前缓冲拉满补片
      refreshCacheStats()
      updateHlsStats()
    },
  })

  const updateHlsStats = () => {
    if (!hls || !videoEl.value) return
    const video = videoEl.value
    playbackDiag.value = describePlaybackState(video, getStuckSegment())
    // 掉帧只有 <video> 自己知道（解码器丢的帧不会体现在任何缓冲读数上）
    const q = video.getVideoPlaybackQuality?.()
    hlsStats.value = {
      buffered: getCachedAhead(video),   // 含预取缓存的有效已缓冲，不只 MSE 的 ~60s
      /*
       * 档位索引三级兜底：
       * · 只有一档时不存在「选哪档」的问题，直接就是它——不用等 currentLevel/loadLevel 落定，
       *   刚切集、一片都还没请求时（0 线程 0 KB/s）这两个都还是 -1，会晚好几拍才亮出清晰度
       * · `currentLevel` 只在切过档之后才有效，多档流没切过档时也是 -1
       * · `loadLevel` 是「正在下载/已下载的档」，比 currentLevel 更早有值
       */
      level: describeLevel(hls.levels[
        hls.levels.length === 1 ? 0 : hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel
      ]),
      dropped: q?.droppedVideoFrames ?? 0,
      total: q?.totalVideoFrames ?? 0,
    }
  }

  // ── 加载 / 销毁 ──

  // 销毁时要顺手清掉的外部资源（自动播放定时器、下载任务…）由使用方登记，
  // 避免引擎反向 import 事件/下载模块
  const onDestroyHooks: Array<() => void> = []
  const registerDestroyHook = (fn: () => void) => { onDestroyHooks.push(fn) }

  const destroyHls = () => {
    clearLoadTimeout()
    cancelBufferingGate()   // 别让上一个流的闸门在新流身上到点
    onDestroyHooks.forEach(fn => fn())
    if (hls) { hls.destroy(); hls = null }
    hlsStats.value = null
    // 取消正在跑的预取请求、停止清理定时器/心跳、重置策略实测（换流/换 CDN 重新测）。
    // 注意：不清空预取缓存——它是模块级单例，需跨换流/导航存活，让「点回去」命中内存缓存；
    // 键按分片 URL 隔离，不同视频不冲突，内存交给 TTL+LRU 兜底。
    stopHlsTick()
    stopPrefetchCleanup()
    abortAllPrefetches()
    prefetchInfo.value = { bufferSecs: 0, threads: 0, cached: 0, pending: 0, bytes: 0 }
    resetStrategy()
    stall.unbind()          // 解绑卡顿监听（换流重新计）
    stall.reset()
    stallRecovery.reset()   // 上一集的播放头时间点不能拿来判「冻住」
    tier.guardRateCeiling.value = Infinity   // 解除抗卡降速守卫
  }

  /** 上一次挂的画中画重开监听（切集可能连着来，别叠着挂） */
  let pipRestoreOff: (() => void) | null = null

  /**
   * 切集第二段：新流元信息一到，就把小窗从占位元素手里要回来（第一段是 `holdPiP`，见 engine/pipHandoff）。
   *
   * 挂 `loadedmetadata` 而不是 `loadeddata`：`readyState` 一过 HAVE_NOTHING 就允许申请，越早接手
   * 占位画面停留越短；`loadeddata` 留作备胎（谁先到谁算，`reclaimPiP` 里已经把占位收干净了）。
   *
   * 接不住也不重试：这时占位已经停掉、小窗跟着关，是看得懂的结果——
   * 停在上一集最后一帧才是最坏的那种，会让人以为切集压根没生效。
   */
  const armPiPRestore = () => {
    pipRestoreOff?.()
    const el = videoEl.value
    if (!el) return
    const reclaim = () => {
      pipRestoreOff?.()
      // 用户可能在这一两秒里自己把小窗关了 → 占位已经不在画中画里，别硬塞回去
      if (!isPiPHeld()) { releasePiPHolder(); return }
      void reclaimPiP(el)
    }
    el.addEventListener('loadedmetadata', reclaim, { once: true })
    el.addEventListener('loadeddata', reclaim, { once: true })
    pipRestoreOff = () => {
      el.removeEventListener('loadedmetadata', reclaim)
      el.removeEventListener('loadeddata', reclaim)
      pipRestoreOff = null
    }
  }

  const loadVideo = async () => {
    if (!videoUrl.value.trim()) return

    errorMessage.value = ''
    isLoading.value = true
    isBuffering.value = true
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0
    bufferedPercent.value = 0
    appliedStartPos = 0   // 非 HLS 那条路不设 startPosition，别留上一次的值
    /**
     * 「定位类起播」= 页面上已经有播放器了（切集 / 重载 / 改配置），起播门槛走「够播 2 秒」那一档。
     * 本次会话第一发（`isVideoLoaded` 还是 false）算冷启动，仍要攒够 6 秒——那时用户刚打开页面，
     * 多等一会儿攒厚一点划算；而切集时画面是停着的，每多一秒都在盯转圈。
     * 必须在下面把 isVideoLoaded 置真**之前**读。
     */
    isRelocating = isVideoLoaded.value

    const url = videoUrl.value.trim()
    const nextIsHls = conn.isHlsUrl(url)
    /**
     * **HLS → HLS 时复用同一个 `<video>` 元素**，不再 `videoKey++`。
     *
     * 重建元素要付四笔账：等一次 `nextTick` + 50ms（新元素挂载）；解码器被卸掉重建；
     * 刚发出的 `play()` 撞上 attach 变成 `AbortError`、再等 400ms×n 重试；
     * 以及**画面立刻变黑**——切集体感「慢」有一半来自这一下黑屏，跟真实耗时无关。
     * 换成复用之后，上一集最后一帧会留在屏幕上直到新流出画面。
     *
     * 只有「HLS ↔ MP4 互转」才必须重建：原生播放要 `src`，而 MSE 那套挂在同一个元素上，
     * 两种模式的内部状态（error / networkState / 已 append 的 buffer）混在一起清不干净。
     * `videoTransform` 也不再被重建冲掉（见 forceRecomposite）。
     */
    const reuseEl = !!videoEl.value && isVideoLoaded.value && nextIsHls && isHls.value
    /**
     * 画中画接力**第一段**，必须赶在下面 `destroyHls` / `removeAttribute('src')` 之前：
     * 那两步一执行，Chrome 就把 `document.pictureInPictureElement` 清空（小窗还开着但已经没主），
     * 「已有元素在画中画里 → 申请免用户激活」那条豁免随之消失，播完自动切集就再也开不回来。
     * 详见 engine/pipHandoff.ts。
     */
    const wasPiP = !!videoEl.value && document.pictureInPictureElement === videoEl.value
    const pipHeld = wasPiP ? await holdPiP('正在切换到下一集…') : false
    if (!reuseEl) videoKey.value++
    isVideoLoaded.value = true
    destroyHls()
    // 复用时元素上还留着上一条流的痕迹（MSE 的 blob src、error、已缓冲区间）。
    // hls.js 的 attachMedia 会重设 srcObject/src，但先手动摘掉更稳：
    // 残留的 src 会让 <video> 在 attach 之前先对旧地址发一次请求（表现是控制台多一条取消的请求）。
    if (reuseEl && videoEl.value) {
      videoEl.value.removeAttribute('src')
      try { videoEl.value.load() } catch {}
    }

    // 按视频切换缓存：同一视频（重播/点回去）保留内存缓存，换了视频才清空旧的
    useCacheForVideo(url)
    // 可达性探测可能阻塞（首访该 host 时约 0.5-3s）——必须在 startLoadTimeout 之前 await，
    // 否则探测耗时会被算进加载超时，慢源直接被误判成「加载超时」。
    await conn.applyStrategy(url)
    // 探测期间用户切了地址 → 放弃本次加载。占位画面要一起收掉，否则小窗永远停在「正在切换…」
    // （新的那一发 loadVideo 会自己重新接力）
    if (videoUrl.value.trim() !== url) { if (pipHeld) releasePiPHolder(); return }

    startLoadTimeout()
    isHls.value = nextIsHls

    console.log('开始加载视频:', url, '是否HLS:', isHls.value,
      '使用代理:', conn.useProxy.value)

    try {
      if (isHls.value) await loadHlsVideo(url, reuseEl)
      else await loadNativeVideo(url)
      // 挂在这里而不是更早：src 刚设上（重建元素那条路新元素也已挂好），元信息事件还没可能派发，
      // 一次都不会漏
      if (pipHeld) armPiPRestore()
    } catch (e) {
      console.error('加载视频失败:', e)
      if (pipHeld) releasePiPHolder()   // 这一集起不来了，别让小窗一直停在「正在切换…」
      errorMessage.value = '加载视频失败: ' + (e instanceof Error ? e.message : String(e))
      isLoading.value = false
      isBuffering.value = false
      isVideoLoaded.value = false
    }
  }

  const loadHlsVideo = async (url: string, reuseEl = false) => {
    if (!Hls) Hls = (await import('hls.js')).default
    const HlsLib = Hls   // 取成局部常量，闭包里就不用到处写 Hls!

    isVideoLoaded.value = true
    // 只有真重建了元素才需要等它挂载。复用时元素一直在 DOM 里，这 50ms 是白等——
    // 而它落在切集的关键路径上，每切一集都赔一次。
    // `!videoEl.value` 那半边是兜底：判定「可复用」是在 await 可达性探测**之前**做的，
    // 那期间出错路径可能把 isVideoLoaded 关掉、Stage 连同 <video> 一起卸掉，
    // 这时候还是得等它挂回来，而不是当场抛「视频元素未初始化」。
    if (!reuseEl || !videoEl.value) {
      await nextTick()
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    if (!HlsLib.isSupported()) {
      // 尝试原生支持（Safari）
      if (videoEl.value?.canPlayType('application/vnd.apple.mpegurl')) {
        await loadNativeVideo(url)
        return
      }
      errorMessage.value = '您的浏览器不支持 HLS 播放'
      isLoading.value = false
      return
    }
    if (!videoEl.value) throw new Error('视频元素未初始化')

    const finalUrl = conn.getProxyUrl(url)
    console.log('加载 HLS 视频:', finalUrl)

    /**
     * 起播位置：直接告诉 hls.js 从这里起播，避免它先从头猛下一堆用不上的分片、
     * 等 onLoadedMetadata 里再 seek 过去（那样等于白下了一遍开头）。
     *
     * **跳过片头也走这条路**。原来 startPosition 只认进度记录，`skipIntro` 是在
     * onLoadedMetadata 里手动 `currentTime = skipIntro` 实现的——于是开着「跳过片头 90s」时
     * hls.js 从 0 开始下，下到一半被 seek 打断，再从 90s 重下一遍。片头那段全是白下的流量，
     * 起播还平白多等一轮。两者语义本来就一样：都是「从第 N 秒开始播」。
     * 进度优先于片头（看到一半回来的人不该被扔回片头之后）。
     *
     * 进度按稳定键存（按需取址的站点真实地址每次都变），不能用 url 查。
     */
    const resumeTime = deps.getSavedProgress(deps.progressKey())
    const startPos = resumeTime > 0 ? resumeTime : (media.skipIntro.value > 0 ? media.skipIntro.value : 0)
    pendingStartPos = startPos
    appliedStartPos = startPos
    startAnchorActive = startPos > 0

    hls = new HlsLib(buildHlsConfig({
      tuning: hlsConfig.value,
      startPos,
      fLoader: createHlsFragLoader() as any,
      // 清单加载器必须包在 hls.js 默认 loader 之上（miss 时要走它原来的那套重试/超时）
      pLoader: createHlsPlaylistLoader((HlsLib as any).DefaultConfig.loader) as any,
    }))

    /**
     * 字幕默认不出。hls.js 的 `subtitleDisplay` 默认为真，清单里带字幕轨时它会自动选一条并渲染，
     * 于是画面上凭空多出一层字幕——而本播放器压根没有字幕开关，用户只能问「这怎么关」（实测被问到）。
     * 源站带的字幕多半还硬编码在画面里，这一层纯属重叠。
     * 真要字幕就用浏览器自带的字幕菜单，不在这里造一套 UI。
     * 注意它是**实例属性**不是构造配置，写进 new Hls({...}) 里 tsc 直接报未知属性。
     */
    hls.subtitleDisplay = false

    /**
     * **事件必须在 loadSource 之前登记**（hls.js 官方也是这么建议的）。
     *
     * 原来是「loadSource → attachMedia → 然后才 hls.on(...)」，靠的是「网络请求总是异步的、
     * 事件不可能在这几行之内就派发」。而 pLoader 命中探测下载好的清单时是**同步**回调的，
     * 于是 MANIFEST_LOADED/MANIFEST_PARSED 在 `loadSource()` 里就派发完了——
     * 那时还没有人订阅，`autoPlayHook` 一辈子不会被调，画面永远停在「加载中…」（踩过）。
     */
    hls.on(HlsLib.Events.MANIFEST_PARSED, (_, data) => {
      /*
       * **画质档要连分辨率一起打出来**（一行字符串，不是对象——控制台默认把对象折成 `{…}`）。
       * 「档数 5」这个读数分不清一件要紧的事：**各档的宽高比一致吗**。
       * 实测遇到同一条流里 1920x800（2.40:1 裁过的）和 1920x1080（16:9 烧了黑边的）并存，
       * ABR 一换档，`<video>` 的固有比例就变 → 画中画小窗被浏览器跟着改尺寸（且只增不减，
       * 缩小方向浏览器不给）。没有这一行的话，现场只能看到「小窗自己越变越大」。
       */
      const levelBrief = data.levels
        .map((l: any, i: number) => `${i}:${l.width || '?'}x${l.height || '?'}`
          + `${l.width && l.height ? `(${(l.width / l.height).toFixed(2)})` : ''}`)
        .join(' ')
      console.log(`HLS manifest 解析完成，画质数: ${data.levels.length} → ${levelBrief}`)
      markDataReceived()
      isLoading.value = false
      startPrefetchCleanup()  // 启动周期清理过期缓存
      if (videoEl.value) {
        videoEl.value.playbackRate = playbackRate.value
        videoEl.value.volume = volume.value
        videoEl.value.muted = isMuted.value
      }
      autoPlayHook?.()
    })

    // playlist（分片列表）就绪 → 立刻并行预热前若干分片 + 启动实时心跳
    hls.on(HlsLib.Events.LEVEL_LOADED, () => {
      primePrefetch()
      startHlsTick()
    })

    // 致命错误处理（实现见 ./engine/hlsErrors.ts）：网络重试 → 重新取址 → 重探；媒体错误恢复带上限
    const { onHlsError, resetErrorCounters, noteLoadOk } = useHlsErrorHandler({
      HlsLib,
      getHls: () => hls,
      setError: (msg: string) => { errorMessage.value = msg; return msg },
      clearIfUnchanged: (msg: string) => { if (errorMessage.value === msg) errorMessage.value = '' },
      failMessage,
      giveUp: () => {
        isLoading.value = false
        isBuffering.value = false
        isVideoLoaded.value = false
        destroyHls()
      },
      refetchUrl: () => deps.refetchUrl(),
      escalateStrategy: () => conn.escalateStrategyAndReload(),
      onBufferStalled: stallRecovery.onBufferStalled,
    })
    resetErrorCounters()
    hls.on(HlsLib.Events.ERROR, (_, data) => onHlsError(data))

    // 分片加载完成 → 更新统计 + 触发自适应预取
    hls.on(HlsLib.Events.FRAG_BUFFERED, (_, data) => {
      updateHlsStats()
      cancelBufferingGate()
      isBuffering.value = false
      // 成功一片就把网络重试额度还回去：额度的语义是「连续失败」，不是「本次播放累计」
      // （见 hlsErrors.noteLoadOk——不还的话看久了任何一次抖动都直接走到销毁）
      noteLoadOk()
      // sn 在 init segment 上是字符串 'initSegment'，那种片没有后续可预取，跳过
      const sn = data?.frag?.sn
      if (typeof sn === 'number') triggerAdaptivePrefetch(sn)
    })

    // 分片加载中：不再当场点亮转圈，交给延迟闸门按「有效可播」判（见 armBufferingGate）。
    // 原来这里是 `buffered.end(最后一段) - currentTime < 2` 就亮，两处都错：判据该看播放头
    // 所在缓冲段的前向（拖进度后最后一段常整段落在播放头后面，两者差十几秒），且不该立刻亮
    hls.on(HlsLib.Events.FRAG_LOADING, () => armBufferingGate())

    hls.on(HlsLib.Events.LEVEL_SWITCHED, (_, data: any) => {
      updateHlsStats()
      // 换档要留一行痕迹：`<video>` 的固有比例跟着当前档走，比例一变画中画小窗就被浏览器改尺寸。
      // 没这行的话，「小窗自己越变越大」和「流里拼了不同分辨率的片段」这两件事在现场分不开
      const l: any = hls?.levels?.[data?.level]
      if (l?.width && l?.height) console.log(`[level] 切到档 ${data.level}：${l.width}x${l.height} = ${(l.width / l.height).toFixed(3)}`)
    })

    // 全部事件登记完毕，这才开始加载（见上面 MANIFEST_PARSED 处的说明）
    /**
     * **先 attachMedia 再 loadSource**。顺序反了在 pLoader 命中时会整个播不起来：
     * 那一发清单是同步返回的，于是 `loadSource()` 一行之内就把清单解析完并开始拉分片，
     * 而此时 `<video>` 还没 attach、MediaSource 压根不存在——分片下下来无处可 append，
     * 表现是「分片一个接一个 200，缓冲恒 0，画面一直转圈」（踩过）。
     * 这也是 hls.js 文档里给的标准顺序，异步那条路上同样更稳。
     */
    hls.attachMedia(videoEl.value)
    hls.loadSource(finalUrl)
  }

  const loadNativeVideo = async (url: string) => {
    const finalUrl = conn.getProxyUrl(url)
    console.log('加载原生视频:', finalUrl)
    isVideoLoaded.value = true
    // 等待 DOM 更新（video 元素重新创建需要更多时间）
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!videoEl.value) throw new Error('视频元素未初始化，请刷新页面重试')
    videoEl.value.src = finalUrl
    videoEl.value.load()

    /**
     * 顺手自己读一次真实时长与平均码率（约 2.5KB 两发小请求，见 engine/mp4Duration.ts）。
     *
     * 安卓 Chrome 在这类整片 MP4 上**读不出总时长** → 进度条钉在最左边、拖不动
     *（实测 `01:04 / 00:00`），而时长明明就写在 `moov/mvhd` 里。
     * 不 await：它跟起播没有先后关系，读到了再补上去。
     */
    media.mp4ProbedDuration.value = 0
    media.mp4AvgMbps.value = 0
    media.mp4Kbps.value = 0
    void probeMp4Head(finalUrl).then(({ durationSecs, mediaBytes }) => {
      // 期间可能已经切集了，别把上一集的读数写到这一集头上
      if (!durationSecs || videoUrl.value.trim() !== url) return
      media.mp4ProbedDuration.value = durationSecs
      media.mp4AvgMbps.value = mediaBytes
        ? Math.round((mediaBytes * 8 / durationSecs / 1e6) * 100) / 100
        : 0
      const own = videoEl.value?.duration
      const browserKnows = typeof own === 'number' && Number.isFinite(own) && own > 0
      console.log(`[mp4] 自读时长 ${durationSecs.toFixed(1)}s / 码率 ${media.mp4AvgMbps.value} Mbps`
        + `（浏览器${browserKnows ? `读到 ${own!.toFixed(1)}s` : '没读出来 → 用我们这份'}）`)
      if (!browserKnows) duration.value = durationSecs
    })
  }

  // MANIFEST_PARSED 之后要触发的起播预缓冲，由 useVideoEvents 登记（避免引擎依赖它）
  let autoPlayHook: (() => void) | null = null
  const registerAutoPlayHook = (fn: () => void) => { autoPlayHook = fn }

  /** 「应用配置」：重载并回到原播放位置 */
  const applyHlsConfig = async () => {
    if (!isHls.value || !videoUrl.value) return
    const savedTime = currentTime.value
    const wasPlaying = isPlaying.value
    await loadVideo()
    // video 元素被重建，用一次性 loadedmetadata 恢复位置
    videoEl.value?.addEventListener('loadedmetadata', () => {
      if (videoEl.value && savedTime > 0) {
        videoEl.value.currentTime = savedTime
        if (wasPlaying) videoEl.value.play().catch(() => {})
      }
    }, { once: true })
  }

  const resetHlsConfig = () => { hlsConfig.value = { ...FACTORY_HLS_TUNING } }

  return {
    // hls.js 生命周期
    loadVideo, destroyHls, applyHlsConfig, resetHlsConfig,
    clearLoadTimeout, markDataReceived,
    registerDestroyHook, registerAutoPlayHook, registerTickHook,
    // 转圈闸门（事件层唯一的点亮入口，别直接写 isBuffering）
    armBufferingGate, cancelBufferingGate,
    // 预取 / 缓存 / 卡顿
    prefetchInfo, strategy, stall,
    getAheadBuffered, getCachedAhead, primePrefetch, startOnePrefetch, prefetchTick,
    abortAllPrefetches, triggerAdaptivePrefetch, purgePlayedSegments, stageSegments,
    aggregateKBps, aggregateMbps, deadLaneLabel,
    // getSegBuf 给缩略图用：主播放已经下过的分片一律零网络复用（见 useVideoThumbnails）
    getSegBuf,
    // 起播锚点 / 起播窄口
    clearStartAnchor, isArrivingAtStart, getAppliedStartPos,
    isRelocatingStart, clearRelocating,
    forceRecomposite, videoTransform,
    // 统计。getHls 只给「读一眼当前档位的编码/帧率/声明码率」这类展示用（见 useVideoContextMenu）——
    // 别拿它去外部驱动 hls.js 的生命周期，那一律走上面几个方法
    updateHlsStats, getHls: () => hls,
  }
}

export type VideoEngine = ReturnType<typeof useVideoEngine>
