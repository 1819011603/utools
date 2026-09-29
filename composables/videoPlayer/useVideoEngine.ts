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
import { useLoadTimeout } from './engine/loadTimeout'
import { failMessageOf } from './engine/hlsErrors'
import { useStallRecovery } from './engine/stallRecovery'
import { type FlvHandle } from './engine/flvStream'
import { reclaimPiP, releasePiPHolder, isPiPHeld, startPiPTracking, resyncPiPAspect } from './engine/pipHandoff'
import { onNetChange } from './engine/netWatch'
import { clearDirectDead } from './probeStore'
import { useSpinnerGate } from './engine/spinnerGate'
import { useNetRecovery } from './engine/netRecovery'
import { useHlsStats } from './engine/hlsStats'
import { useStartAnchor } from './engine/startAnchor'
import { useVideoLoader } from './engine/videoLoader'

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


export function useVideoEngine(deps: VideoEngineDeps) {
  const { media, conn, tier } = deps
  const {
    videoUrl, videoEl, isHls, isFlv, isLoading, isBuffering, isPlaying, isVideoLoaded,
    errorMessage, currentTime, duration, bufferedPercent, videoKey,
    hlsConfig, hlsStats, playbackDiag, playbackRate, desiredRate, autoBestRate, volume, isMuted,
  } = media

  let hls: HlsType | null = null
  let flv: FlvHandle | null = null


  // 起播锚点（刷新/恢复进度/切集起播的位置），实现见 ./engine/startAnchor.ts
  const startAnchor = useStartAnchor()
  const {
    clearStartAnchor, isArrivingAtStart, getAppliedStartPos, isRelocatingStart, clearRelocating,
    getStartPosition, beginAnchor, setAppliedStartPos, setRelocating,
  } = startAnchor

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
    getStartPosition,
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
    startOnePrefetch, strategy, resetStrategy, resetConcurrencyRamp, tick: prefetchTick, primePrefetch, getStuckSegment, laneDead,
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

  // 转圈遮罩的延迟闸门 + FLV 兜底熄灯心跳（实现见 ./engine/spinnerGate.ts）
  const spinnerGate = useSpinnerGate({
    getVideoEl: () => videoEl.value,
    isFlv,
    isBuffering,
    getAheadBuffered,
    getCachedAhead,
  })
  const { armBufferingGate, cancelBufferingGate, dropSpinnerIfPlaying, startFlvTick, stopFlvTick } = spinnerGate

  // ── 实时心跳的外挂钩子 ──
  // 自愈调参环（useVideoAutoTune.selfHeal）、下一集预热（useVideoPrewarm.tick）都挂在这儿，
  // 引擎不反向依赖它们。多播而不是单槽：单槽时后登记的会把前一个静默顶掉
  const tickHooks: Array<() => void> = []
  const registerTickHook = (fn: () => void) => { tickHooks.push(fn) }

  // ── 网络变化的恢复动作：断网恢复 / 换 Wi-Fi / 切蜂窝 / 回前台（实现见 ./engine/netRecovery.ts）──
  const netRecovery = useNetRecovery({
    getVideoEl: () => videoEl.value,
    getHls: () => hls,
    getAheadBuffered,
    getVideoUrl: () => videoUrl.value,
    errorMessage,
    // 网络变了：lane 熔断记录 + 可达性结论 + 「直连是黑洞」缓存都是**上一个网络**测出来的，整份作废
    invalidateNetworkState: () => {
      reviveLanes()
      conn.invalidateReachCache()
      try { clearDirectDead(new URL(videoUrl.value, location.href).hostname) } catch {}
    },
    primePrefetch,
  })
  const { onNetChanged, recoverTick, onNetworkOffline } = netRecovery

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
      dropSpinnerIfPlaying()   // 转圈兜底熄灯（见它自己那段注释）
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

  // 播放统计刷新（实现见 ./engine/hlsStats.ts）
  const { updateHlsStats } = useHlsStats({
    getHls: () => hls,
    getVideoEl: () => videoEl.value,
    getCachedAhead,
    getStuckSegment,
    playbackDiag,
    hlsStats,
  })

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
    // FLV 也挂在这里销毁：它同样是「一个 MSE 实例绑在 <video> 上」，
    // 不摘掉的话新流 attach 时会撞上上一条流的 SourceBuffer
    if (flv) { flv.destroy(); flv = null }
    stopFlvTick()
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


  // MANIFEST_PARSED 之后要触发的起播预缓冲，由 useVideoEvents 登记（避免引擎依赖它）
  let autoPlayHook: (() => void) | null = null
  const registerAutoPlayHook = (fn: () => void) => { autoPlayHook = fn }

  // ── 视频装载：HLS / FLV / 原生 MP4 三条路（实现见 ./engine/videoLoader.ts）──
  const loader = useVideoLoader({
    media,
    conn,
    getSavedProgress: deps.getSavedProgress,
    progressKey: deps.progressKey,
    refetchUrl: () => deps.refetchUrl(),
    destroyHls,
    setHls: (h) => { hls = h },
    setFlv: (f) => { flv = f },
    armPiPRestore,
    useCacheForVideo,
    startLoadTimeout,
    markDataReceived,
    startPrefetchCleanup,
    primePrefetch,
    startHlsTick,
    startFlvTick,
    updateHlsStats,
    cancelBufferingGate,
    armBufferingGate,
    triggerAdaptivePrefetch,
    failMessage,
    createHlsFragLoader,
    createHlsPlaylistLoader,
    onBufferStalled: stallRecovery.onBufferStalled,
    getAutoPlayHook: () => autoPlayHook,
    beginAnchor,
    setAppliedStartPos,
    setRelocating,
  })
  const loadVideo = loader.loadVideo

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
    abortAllPrefetches, triggerAdaptivePrefetch, purgePlayedSegments, stageSegments, resetConcurrencyRamp,
    aggregateKBps, aggregateMbps, deadLaneLabel,
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
