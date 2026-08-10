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
    purgePlayedSegments,
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

  // ── 实时心跳：每秒刷新缓冲读数 + 跑闭环预取控制（不依赖 FRAG_BUFFERED，卡顿时也持续工作） ──
  let hlsTickTimer: ReturnType<typeof setInterval> | null = null
  const startHlsTick = () => {
    if (hlsTickTimer) return
    document.addEventListener('visibilitychange', onVisibilityChange)
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
      prefetchTick()
      refreshCacheStats()   // 面板上的「预取缓存 N 片 / X MB」
      updateHlsStats()
      tickHooks.forEach(fn => fn())
    }, 1000)
  }
  const stopHlsTick = () => {
    if (hlsTickTimer) { clearInterval(hlsTickTimer); hlsTickTimer = null }
    document.removeEventListener('visibilitychange', onVisibilityChange)
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
      level: describeLevel(hls.levels[hls.currentLevel]),
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
    tier.guardRateCeiling.value = Infinity   // 解除抗卡降速守卫
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
    if (videoUrl.value.trim() !== url) return   // 探测期间用户切了地址 → 放弃本次加载

    startLoadTimeout()
    isHls.value = nextIsHls

    console.log('开始加载视频:', url, '是否HLS:', isHls.value,
      '使用代理:', conn.useProxy.value)

    try {
      if (isHls.value) await loadHlsVideo(url, reuseEl)
      else await loadNativeVideo(url)
    } catch (e) {
      console.error('加载视频失败:', e)
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
      console.log('HLS manifest 解析完成，画质数:', data.levels.length)
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
    const { onHlsError, resetErrorCounters } = useHlsErrorHandler({
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
    })
    resetErrorCounters()
    hls.on(HlsLib.Events.ERROR, (_, data) => onHlsError(data))

    // 分片加载完成 → 更新统计 + 触发自适应预取
    hls.on(HlsLib.Events.FRAG_BUFFERED, (_, data) => {
      updateHlsStats()
      cancelBufferingGate()
      isBuffering.value = false
      // sn 在 init segment 上是字符串 'initSegment'，那种片没有后续可预取，跳过
      const sn = data?.frag?.sn
      if (typeof sn === 'number') triggerAdaptivePrefetch(sn)
    })

    // 分片加载中：不再当场点亮转圈，交给延迟闸门按「有效可播」判（见 armBufferingGate）。
    // 原来这里是 `buffered.end(最后一段) - currentTime < 2` 就亮，两处都错：判据该看播放头
    // 所在缓冲段的前向（拖进度后最后一段常整段落在播放头后面，两者差十几秒），且不该立刻亮
    hls.on(HlsLib.Events.FRAG_LOADING, () => armBufferingGate())

    hls.on(HlsLib.Events.LEVEL_SWITCHED, () => updateHlsStats())

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
    // 起播锚点 / 起播窄口
    clearStartAnchor, isArrivingAtStart, getAppliedStartPos,
    isRelocatingStart, clearRelocating,
    forceRecomposite, videoTransform,
    // 统计
    updateHlsStats,
  }
}

export type VideoEngine = ReturnType<typeof useVideoEngine>
