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

// 加载超时：走服务端代理时需要更长，统一 15s
//（代理要先请求远端再返回，3s 往往不够，会误触 destroyHls 取消所有请求）
const LOAD_TIMEOUT = 15000
// 到这个点还没收到任何数据，先怀疑「地址本身死了」而不是通道选错了：
// 预热/交接槽里的签名地址会过期，过期后换哪条通道都是 403。比 LOAD_TIMEOUT 早，
// 这样重新取址那一次还能落在用户耐心之内（重取成功会把两个计时器一起重置）。
const STALE_URL_TIMEOUT = 10000
const MAX_HLS_RETRY = 3
/**
 * `recoverMediaError()` 的次数上限。**必须有上限**：它重建 MediaSource 再从当前位置续拉，
 * 前提是「数据本身没问题、只是解码器状态坏了」。可如果取回来的字节压根不是视频
 *（实测被 Cloudflare 下线的源，每个分片都是同一张 20KB 诱饵图，见 server/api/proxy.ts 的
 * DEAD_SOURCE_LANDINGS），那就是「恢复 → 立刻再失败 → 再恢复」的死循环，
 * 屏幕上是**一直在闪**、永远出不来画面，而错误提示每次 2s 后自己清掉，用户连原因都看不到（踩过）。
 */
const MAX_MEDIA_ERROR_RECOVER = 3

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
  const hlsRetryCount = ref(0)
  let mediaErrorRecovered = 0   // 本次加载已恢复几次媒体错误（见 MAX_MEDIA_ERROR_RECOVER）

  let loadTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  let staleUrlTimer: ReturnType<typeof setTimeout> | null = null
  let hasReceivedData = false

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
   * 起播窄口：从「刚定位」到「已经能播」的那几百毫秒里把预取并发钳到 2（见 useHlsPrefetch 的 NARROW_CONN）。
   *
   * 为什么需要它：定位那一刻缓存必然接近 0，而闭环的规则是「缓存少 → 拉满并发」，
   * 加上起播前 `video.paused` 恒为真（还没 play()）又走「暂停 → 顶格并发」，
   * 结果 6~12 条连接全去下第 2..12 片。浏览器同 host 只给 6 条，
   * 真正决定能不能出画面的第一片排在队尾，带宽还被瓜分——越想快，第一片越慢。
   *
   * 三个入口都要进：切集/重载（loadVideo）、用户拖进度（onSeeked）、恢复进度起播。
   * 解除取二者先到：① 起播门槛达成（由 useVideoEvents 在真正 play() 时调 endStartupNarrow）；
   * ② 兜底 NARROW_MAX_MS——极慢源上第一片可能几秒都下不来，窄口不能无限期按着并发。
   *
   * **计时必须从「真正开始要分片」那一刻起算**，不能从 loadVideo 的开头。
   * 起播前面还有可达性探测和 manifest（合起来 1-2s，慢源更久），从开头起算的话
   * 这 2.5s 往往在 hls.js 发出第一个分片请求之前就烧完了——实测冷启动首 1.2s 里
   * 依然有 32 个并发分片请求，等于窄口压根没生效。所以 loadSource 之前要**重新上膛**。
   */
  const NARROW_MAX_MS = 2500
  let narrowUntil = 0
  const beginStartupNarrow = () => { narrowUntil = performance.now() + NARROW_MAX_MS }
  const endStartupNarrow = () => { narrowUntil = 0 }
  const isStartupNarrow = () => narrowUntil > 0 && performance.now() < narrowUntil

  /**
   * 本次起播是不是「定位类」（切集 / 重载 / 拖进度），供 useVideoEvents 选起播门槛：
   * 定位类只等 2.5s 缓冲就出画面，首次冷启动仍等 6s。
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
    // 并发下限恒为 1：站点规则已删除，实际下限由档位的 concurrencyFloor 给，
    // 引擎再按实测带宽 + 倍速动态往上爬（见 useHlsPrefetch 的 floorConn/stepControl）
    getConcurrencyCap: () => 1,
    getPlaybackRate: () => playbackRate.value,
    // 「预加载时长」= 往后预取多少秒就够了，到量即停（0/负数视为不限）
    getPrefetchTargetSecs: () => {
      const t = hlsConfig.value.maxBufferLength
      return t && t > 0 ? t : Infinity
    },
    // 起播锚点：定位未到位前，预取从 pendingStartPos 起（而非 currentTime=0）
    getStartPosition: () => (startAnchorActive ? pendingStartPos : 0),
    // 直连+代理双通道：仅在「开启 + 该分片直连可达」时加一条本站代理 lane（不同 origin → 各享 6 连接）。
    // 需注入头/走代理的源直连 lane 会 403，退回单 lane。
    getLaneUrls: (url: string) => {
      if (conn.dualChannel.value && conn.isDirectMode(url)) return [url, conn.getProxyPassthroughUrl(url)]
      return [conn.getProxyUrl(url)]
    },
    // 服务器档位参数（好/中/差预设 + 页面覆盖）：抗卡阈值/超时/安全系数/并发下限/预取深度全从这里读
    getTierParams: () => tier.effectiveTierParams.value,
    // 起播窄口：刚定位的那几百毫秒只给 2 条连接，先把「能不能播」那一片拿到手
    isStartupNarrow,
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

  // 聚合下载速度（估算）= 单连接实测速度 × 当前并发。perConnKBps 是当前并发下的实测值，
  // 故乘积能反映「加并发到底换没换来更多总带宽」：双通道真生效则随 6→12 翻倍，被 per-IP 限死则基本不变。
  const aggregateKBps = computed(() => Math.round(strategy.value.perConnKBps * strategy.value.targetConn))
  const aggregateMbps = computed(() => Math.round((aggregateKBps.value * 8 / 1024) * 10) / 10)

  /**
   * 报错文案：探测已经实测证伪时，一律用它的结论顶掉笼统的兜底话术。
   *
   * 「加载超时」「链接无效或已过期」这些兜底只是猜，而 `diagnoseProbe` 手上有实测证据
   *（典型：源站已被 Cloudflare 下线，换哪条通道都一样）。更要紧的是**它得留在页面上**——
   * toast 会自己消失，用户回过神来想看原因时只剩一句猜的（踩过：「提醒一下就没了」）。
   */
  const failMessage = (fallback: string): string => {
    const v = conn.probeVerdict.value
    return v.severity === 'fatal' ? `${v.title}——${v.detail}` : fallback
  }

  // ── 加载超时 ──
  const clearLoadTimeout = () => {
    if (loadTimeoutTimer) { clearTimeout(loadTimeoutTimer); loadTimeoutTimer = null }
    if (staleUrlTimer) { clearTimeout(staleUrlTimer); staleUrlTimer = null }
  }
  const startLoadTimeout = () => {
    clearLoadTimeout()
    hasReceivedData = false
    // 第一档：10s 一个字节都没来，可能是地址过期 → **静默**后台重新取址（每集一次额度，
    // 不是按需取址的列表直接返回 false）；取到不一样的地址才重载，那时 loadVideo 会把这两个
    // 计时器重新起一遍。
    //
    // 静默是硬要求：这一档**必然会误伤**——慢源的 manifest 本身就要十几秒，它没死。
    // 早先在这里写了句「正在重新获取播放地址」并拉起 isResolvingUrl，于是正常的慢加载
    // 也会盖上转圈遮罩，表现成「视频刚开始点下一集，一直显示获取中」（踩过）。
    staleUrlTimer = setTimeout(() => {
      if (hasReceivedData || !isLoading.value) return
      void deps.refetchUrl(true)
    }, STALE_URL_TIMEOUT)
    loadTimeoutTimer = setTimeout(() => {
      if (!hasReceivedData && isLoading.value) {
        errorMessage.value = failMessage('加载超时，视频链接可能已过期或无法访问（403/404）')
        isLoading.value = false
        isBuffering.value = false
        isVideoLoaded.value = false
        destroyHls()
      }
    }, LOAD_TIMEOUT)
  }
  const markDataReceived = () => {
    hasReceivedData = true
    clearLoadTimeout()
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
   * `<video>` 的 transform。**初值为空**——不打扰绝大多数设备：空 transform 时浏览器才可能
   * 把视频交给硬件 overlay 平面（省电、解码路径最短）。只有真需要重新合成时（见 forceRecomposite）
   * 才置上并从此常驻，代价是那一路视频改走纹理合成。
   * 走响应式绑定而不是直改 DOM：换集时 `videoKey++` 会重建元素，直改的样式会跟着丢。
   */
  const videoTransform = ref('')

  /**
   * 强制重新合成一次 `<video>`。
   *
   * 治的是浏览器侧的**残影**：Chrome 把视频画在独立的硬件 overlay 平面上，该平面在
   * 「标签页切走切回」「播放停下」之后可能停在没画完的一帧（画面被静止图挡住、错开成两块、
   * 或整块黑屏），而音频和 currentTime 一切正常——**播放本身没问题，只是那一层没被重画**。
   * 用户的自救方式「再切一次标签页」正是逼它重新合成，这里把这一步替他做了。
   *
   * 手法是**在两个视觉等价的 transform 之间切换**（Z 轴 0.01px，看不出位移）。
   * 早先是「设 translateZ(0) → 下一帧撤销」，那样元素会在 overlay 平面和普通合成层之间
   * 来回搬两次，**每次搬家在屏幕上都看得见**，表现是每次暂停都「闪一下，最后画面才对」（踩过）。
   *
   * 所以第一次调用之后 transform 就不再撤销，元素常驻合成层，此后切换值只重画不搬家。
   * 只有这**第一下**还会闪一次——按需而不是一上来就常驻，是为了不打扰没这毛病的设备：
   * 空 transform 时视频才可能走硬件 overlay（省电、解码路径最短）。
   *
   * 用 `transform` 而不是 `display:none`：后者会让 `<video>` 卸掉解码器再重建，真的会黑一下。
   */
  const forceRecomposite = () => {
    videoTransform.value = videoTransform.value === 'translateZ(0px)'
      ? 'translateZ(0.01px)'
      : 'translateZ(0px)'
  }

  /**
   * 回到前台时的追赶。**整个预取引擎都挂在上面那个 1 秒心跳上**，而浏览器会节流后台标签页的
   * 定时器（切走久了拉长到几十秒一拍）。于是后台期间：播放照常消耗预取缓存，补片却几乎停了，
   * 前方缓存被吃空。切回来的一瞬间 hls.js 要的分片不在缓存里 → 走网络 → 就是那「卡一下」。
   * 而并发是每拍 +1 慢慢爬的，等它自己恢复要好几秒；期间再切走切回来，缓存已经填回去了，
   * 所以第二次「就好了」——这正是这个 bug 的特征现象。
   * 全屏时没事也对得上：全屏的标签页始终是前台，压根没被节流过。
   *
   * 这里不等下一拍，立刻把该做的都做一遍：作废卡顿采样基准（见 resetSampler，
   * 否则后台那几十秒会被回填成一次假卡顿）→ 跑一拍闭环 → primePrefetch 直接把并发拉起来。
   */
  const onVisibilityChange = () => {
    if (!hls) return
    // 切走时立刻把已播分片吐掉。后台标签页是浏览器做内存回收/压缩的首选对象，
    // 而这份缓存可能有几百 MB 的 ArrayBuffer——留着它进后台，回来时要把这一大坨重新换页进来，
    // 表现就是「整个浏览器像卡死一样」。已播的那部分反正也用不上了，走之前先扔
    if (document.visibilityState === 'hidden') {
      purgePlayedSegments()
      return
    }
    if (document.visibilityState !== 'visible') return
    forceRecomposite()
    stall.resetSampler()
    stall.tick()
    prefetchTick()
    primePrefetch()   // 不等并发一拍 +1 地爬，立刻按当前缓冲拉满补片
    refreshCacheStats()
    updateHlsStats()
  }

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
    hlsRetryCount.value = 0
    mediaErrorRecovered = 0
    appliedStartPos = 0   // 非 HLS 那条路不设 startPosition，别留上一次的值
    /**
     * 「定位类起播」= 页面上已经有播放器了（切集 / 重载 / 改配置），门槛走 2.5s 那一档。
     * 本次会话第一发（`isVideoLoaded` 还是 false）算冷启动，仍用 6s——那时用户刚打开页面，
     * 多等两秒攒厚一点划算；而切集时画面是停着的，每多一秒都在盯转圈。
     * 必须在下面把 isVideoLoaded 置真**之前**读。
     */
    isRelocating = isVideoLoaded.value
    beginStartupNarrow()

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

  /**
   * 网络错误重试用尽后的恢复顺序：**重新取址 → 重探连接方式 → 才报错**。
   *
   * 顺序不能反。按需取址的站点给的是带时效签名的地址，过期之后无论走哪条通道都是 403，
   * 而重探一轮好几秒、探不出结论还会连着走完线性阶梯 5 级，全程是白等——
   * 用户看到的是「自动跳到下一集然后卡死在转圈上」。地址过期比通道判断错常见得多。
   */
  const recoverFromNetworkFailure = async (details: string) => {
    errorMessage.value = '链接可能已过期，正在重新获取播放地址...'
    if (await deps.refetchUrl()) return
    if (conn.escalateStrategyAndReload()) return
    errorMessage.value = failMessage(details === 'manifestLoadError'
      ? '视频链接无效或已过期，请检查链接是否正确'
      : `网络错误: ${details}，链接可能已过期`)
    isLoading.value = false
    isBuffering.value = false
    isVideoLoaded.value = false
    destroyHls()
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

    hls = new HlsLib({
      // MSE 缓冲要「小而健康」——append 太多（几百 MB）会触发浏览器 MSE 配额/驱逐，
      // 产生缓冲空洞导致明明缓冲很多却卡在原地。真正的大量预读放在 JS 预取缓存里
      //（容量 = maxBufferSizeMB），hls.js 只在 MSE 里留 ~30s，随播随取。
      // Math.min 兼容并迁移旧的超大配置。
      maxBufferLength: Math.min(30, hlsConfig.value.maxBufferLength),
      maxMaxBufferLength: Math.min(60, hlsConfig.value.maxMaxBufferLength),
      backBufferLength: Math.min(30, hlsConfig.value.backBufferLength),
      maxBufferSize: 60 * 1000 * 1000,   // MSE 最多 ~60MB，其余交给 JS 预取缓存
      // 缓冲空洞 / 卡顿自动跳跃恢复
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 1,
      nudgeOffset: 0.2,
      nudgeMaxRetry: 8,
      fragLoadingTimeOut: hlsConfig.value.fragLoadingTimeOut,
      fragLoadingMaxRetry: hlsConfig.value.fragLoadingMaxRetry,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      levelLoadingTimeOut: 20000,
      levelLoadingMaxRetry: 3,
      enableWorker: hlsConfig.value.enableWorker,
      lowLatencyMode: hlsConfig.value.lowLatencyMode,
      startLevel: -1,
      startPosition: startPos > 0 ? startPos : -1,
      // 自定义分片加载器：接管分片请求，命中预取缓存直接返回
      fLoader: createHlsFragLoader() as any,
      // 自定义清单加载器：命中「探测刚下载过的同一份 m3u8」就同步返回，省一次 RTT。
      // 必须包在 hls.js 默认 loader 之上（miss 时要走它原来的那套重试/超时）
      pLoader: createHlsPlaylistLoader((HlsLib as any).DefaultConfig.loader) as any,
      // Origin/Referer 由 /api/proxy 服务端注入，XHR 层只需关闭 credentials
      xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false },
    })

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

    hls.on(HlsLib.Events.ERROR, (_, data) => {
      console.warn('HLS 错误:', data.type, data.details, 'fatal:', data.fatal)
      if (!data.fatal) return
      switch (data.type) {
        case HlsLib.ErrorTypes.NETWORK_ERROR:
          hlsRetryCount.value++
          if (hlsRetryCount.value <= MAX_HLS_RETRY) {
            errorMessage.value = `网络错误，正在重试 (${hlsRetryCount.value}/${MAX_HLS_RETRY})...`
            setTimeout(() => { hls?.startLoad() }, 1000)
          } else {
            void recoverFromNetworkFailure(data.details)
          }
          break
        case HlsLib.ErrorTypes.MEDIA_ERROR:
          mediaErrorRecovered++
          if (mediaErrorRecovered > MAX_MEDIA_ERROR_RECOVER) {
            // 恢复了几次还在同一个地方倒下 → 不是解码器状态坏了，是数据不对。
            // 继续恢复只会无限闪屏，停下来把原因说清楚才是有用的
            errorMessage.value = failMessage('媒体解码持续失败：取回的数据不是可播的视频（源站可能已下线或返回了占位内容），换一条线路试试')
            isLoading.value = false
            isBuffering.value = false
            isVideoLoaded.value = false
            destroyHls()
            break
          }
          {
            const msg = `媒体错误，正在恢复 (${mediaErrorRecovered}/${MAX_MEDIA_ERROR_RECOVER})...`
            errorMessage.value = msg
            hls?.recoverMediaError()
            // **只在这条提示还没被别人改过时才清掉**。不加这道判断，恢复失败得快的时候
            // 上一次的定时器会把刚写上去的「放弃原因」一起擦掉——表现正是「报了一下就没了」
            setTimeout(() => { if (errorMessage.value === msg) errorMessage.value = '' }, 2000)
          }
          break
        default:
          errorMessage.value = '播放失败: ' + data.details
          isLoading.value = false
          isBuffering.value = false
          isVideoLoaded.value = false
          destroyHls()
      }
    })

    // 分片加载完成 → 更新统计 + 触发自适应预取
    hls.on(HlsLib.Events.FRAG_BUFFERED, (_, data) => {
      updateHlsStats()
      isBuffering.value = false
      // sn 在 init segment 上是字符串 'initSegment'，那种片没有后续可预取，跳过
      const sn = data?.frag?.sn
      if (typeof sn === 'number') triggerAdaptivePrefetch(sn)
    })

    // 分片加载中：只在没有足够缓冲时显示加载
    hls.on(HlsLib.Events.FRAG_LOADING, () => {
      const v = videoEl.value
      if (v && v.buffered.length > 0) {
        const bufferedEnd = v.buffered.end(v.buffered.length - 1)
        if (bufferedEnd - v.currentTime < 2) isBuffering.value = true
      }
    })

    hls.on(HlsLib.Events.LEVEL_SWITCHED, () => updateHlsStats())

    // 全部事件登记完毕，这才开始加载（见上面 MANIFEST_PARSED 处的说明）。
    // 窄口在这里重新上膛：到这一刻才真正开始要分片，前面探测/manifest 那 1-2s 不该算进它的寿命
    beginStartupNarrow()
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

  /**
   * 自定义 playlist loader：hls.js 第一次要 manifest 时，如果**刚刚**的可达性探测已经
   * 拉过同一个 URL，就把那份原文同步交给它，省掉一次 RTT。
   *
   * 为什么值得做：探测为了数分片本来就把 m3u8 整个 body 读完了，紧接着 hls.js 又去拉同一个地址。
   * 代理通道靠浏览器 HTTP 缓存能命中（/api/proxy 对点播 m3u8 发 1 天缓存头），
   * 但**直连通道多数 CDN 的 m3u8 是 no-cache**——那一发就是白等，而它正卡在切集的关键路径上。
   *
   * 按**完整 URL** 严格匹配，对不上就老实走网络：探测的 manifest URL 恒带 `noseg=1`，
   * 而真正加载时只有 manifestOnly 才带，两者不同就说明内容不同（服务端会不会重写分片 URI），
   * 喂错了会让 hls.js 拿到一份分片指向错地方的清单。宁可 miss。
   * 一次性：用掉即清，避免播到一半 hls.js 重载 level 时拿到一份陈旧清单。
   *
   * **回调必须延到下一个宏任务，绝不能同步回**。同步回等于在 `loadSource()` 这一行之内
   * 把 MANIFEST_LOADED / MANIFEST_PARSED 全派发完，而此时 `attachMedia` 建的 MediaSource
   * 还没等到异步的 `sourceopen`（MEDIA_ATTACHED 尚未派发）——hls.js 从这个状态起步会
   * 「分片一个接一个 200、缓冲恒 0、画面一直转圈」（实测 A/B 确认：关掉复用立刻能播）。
   * 让它像一个「快得离谱的网络请求」那样异步返回，行为就和原来完全一致，
   * 而省下的是一整个 RTT（几十到几百毫秒），一个宏任务的代价可以忽略。
   */
  const createHlsPlaylistLoader = (BaseLoader: any) => {
    return class ProbeSeededPlaylistLoader extends BaseLoader {
      private seedTimer: ReturnType<typeof setTimeout> | null = null

      load(context: any, config: any, callbacks: any): void {
        const seeded = conn.takeSeededManifest(context?.url)
        if (!seeded) { super.load(context, config, callbacks); return }
        const t = performance.now()
        this.seedTimer = setTimeout(() => {
          this.seedTimer = null
          if (this.stats?.aborted) return
          const stats = this.stats ?? {}
          // hls.js 只读这几个字段来算带宽/耗时；给一个自洽的最小集即可
          stats.loading = { start: t, first: performance.now(), end: performance.now() }
          stats.parsing = { start: 0, end: 0 }
          stats.loaded = stats.total = seeded.length
          stats.retry = 0
          stats.chunkCount = 1
          console.log('用探测已下载的 manifest，省掉一次请求:', context.url)
          callbacks.onSuccess({ data: seeded, url: context.url }, stats, context, null)
        }, 0)
      }

      abort(): void {
        if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = null }
        super.abort()
      }

      destroy(): void {
        if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = null }
        super.destroy()
      }
    }
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
    // 预取 / 缓存 / 卡顿
    prefetchInfo, strategy, stall,
    getAheadBuffered, getCachedAhead, primePrefetch, startOnePrefetch, prefetchTick,
    abortAllPrefetches, triggerAdaptivePrefetch, purgePlayedSegments, stageSegments,
    aggregateKBps, aggregateMbps, deadLaneLabel,
    // 起播锚点 / 起播窄口
    clearStartAnchor, isArrivingAtStart, getAppliedStartPos,
    beginStartupNarrow, endStartupNarrow, isStartupNarrow,
    isRelocatingStart, clearRelocating,
    forceRecomposite, videoTransform,
    // 统计
    updateHlsStats,
  }
}

export type VideoEngine = ReturnType<typeof useVideoEngine>
