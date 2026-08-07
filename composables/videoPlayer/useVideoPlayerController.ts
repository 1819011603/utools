/**
 * 播放器装配层：把各功能模块接起来，并负责三件跨模块的事——
 * 持久化（localStorage）、地址栏双向同步、挂载/卸载生命周期。
 *
 * 页面和子组件都通过 provide/inject 拿这个对象（见 `useVideoPlayerCtx`），
 * 所以子组件不需要一层层传 props。
 *
 * 装配顺序上有几处「循环依赖」（tier 要读 conn 命中的规则、conn 要能重载视频、
 * playlist 要能加载视频），一律用惰性箭头函数回调打破——这些回调只在运行时被调用，
 * 那时所有模块都已创建完毕。
 */
import type { InjectionKey } from 'vue'
import type { SavedState } from './types'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoEngine } from './useVideoEngine'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'

const STORAGE_KEY = 'video-player-state'

export function useVideoPlayerController() {
  const media = useVideoMediaState()
  const handoff = useVideoHandoff()

  // 下面三个互相引用，先声明后赋值；回调里访问时都已就绪
  let conn!: VideoConnStrategy
  let engine!: VideoEngine
  let playlist!: VideoPlaylistCtl

  const tier = useVideoServerTier({
    onDirty: () => saveState(),
  })

  conn = useVideoConnStrategy({
    media,
    tier,
    onDirty: () => saveState(),
    syncUrl: () => syncUrlToQuery(),
    reload: () => { void engine.loadVideo() },
  })

  playlist = useVideoPlaylistCtl({
    media,
    handoff,
    onDirty: () => saveState(),
    syncUrl: () => syncUrlToQuery(),
    loadVideo: () => engine.loadVideo(),
  })

  engine = useVideoEngine({
    media,
    conn,
    tier,
    progressKey: () => playlist.progressKey(),
    getSavedProgress: url => playlist.getSavedProgress(url),
  })

  // 自愈调参环每秒跑一次，挂在引擎心跳上（引擎不反向依赖它）
  const autoTune = useVideoAutoTune({ media, tier, conn, engine })
  engine.registerTickHook(autoTune.selfHeal)

  const events = useVideoEvents({ media, engine, conn, playlist })
  const controls = useVideoUiControls({ media, autoTune })

  // 视频下载（HLS 分片并发 + AES 解密 + ffmpeg 合并 / MP4 直下）
  const download = useVideoDownload({
    getProxyUrl: conn.getProxyUrl,
    isHlsUrl: conn.isHlsUrl,
    getVideoName: handoff.getVideoName,
    videoUrl: media.videoUrl,
    playlist: playlist.playlist,
    currentIndex: playlist.currentIndex,
    errorMessage: media.errorMessage,
    useProxy: conn.useProxy,
    getDownloadConcurrency: () => 6,
  })
  // 换流/销毁时把下载任务一起取消（引擎不认识下载模块，靠登记钩子）
  engine.registerDestroyHook(() => download.cancelDownload())

  // ── 持久化 ──

  const loadSavedState = (): SavedState | null => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch (e) {
      console.error('加载保存状态失败:', e)
    }
    return null
  }

  const saveState = () => {
    try {
      const state: SavedState = {
        videoUrlInput: media.videoUrlInput.value,
        playlist: playlist.playlist.value,
        currentIndex: playlist.currentIndex.value,
        progress: media.savedProgress.value,
        volume: media.volume.value,
        // 存用户选择的目标倍速（非自动下调后的实际值）
        playbackRate: media.desiredRate.value,
        useProxy: conn.useProxy.value,
        autoFullscreen: media.autoFullscreen.value,
        autoBestRate: media.autoBestRate.value,
        skipIntro: media.skipIntro.value,
        skipOutro: media.skipOutro.value,
        requestOrigin: conn.requestOrigin.value,
        requestReferer: conn.requestReferer.value,
        manifestOnly: conn.manifestOnly.value,
        disguiseAsDownloader: conn.disguiseAsDownloader.value,
        dualChannel: conn.dualChannel.value,
        originHint: conn.originHint.value,
        refererHint: conn.refererHint.value,
        hlsConfig: { ...media.hlsConfig.value },
        tierOverrides: { ...tier.tierOverrides.value },
        lazyTask: handoff.lazyTask.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
      console.error('保存状态失败:', e)
    }
  }

  const hydrate = (s: SavedState) => {
    media.savedProgress.value = s.progress || {}
    media.volume.value = s.volume ?? 1
    media.playbackRate.value = s.playbackRate ?? 1
    media.desiredRate.value = s.playbackRate ?? 1
    media.autoFullscreen.value = s.autoFullscreen ?? true
    media.autoBestRate.value = s.autoBestRate ?? true
    media.skipIntro.value = s.skipIntro ?? 0
    media.skipOutro.value = s.skipOutro ?? 0
    conn.useProxy.value = s.useProxy ?? false
    conn.requestOrigin.value = s.requestOrigin ?? ''
    conn.requestReferer.value = s.requestReferer ?? ''
    conn.manifestOnly.value = s.manifestOnly ?? true
    conn.disguiseAsDownloader.value = s.disguiseAsDownloader ?? false
    conn.dualChannel.value = s.dualChannel ?? false
    conn.originHint.value = s.originHint ?? ''
    conn.refererHint.value = s.refererHint ?? ''
    // 填过候选头就展开设置区，否则用户看不到自己填的值还在不在
    if (conn.originHint.value || conn.refererHint.value) media.showAdvancedProxy.value = true
    if (s.hlsConfig) media.hlsConfig.value = { ...media.hlsConfig.value, ...s.hlsConfig }
    if (s.tierOverrides) tier.tierOverrides.value = { ...s.tierOverrides }
  }

  // ── 地址栏 ──

  const query = useVideoDeepLink({ media, conn, handoff, playlist })
  const { parseQueryVideoParams, syncUrlToQuery, copyDeepLink, deepLinkCopied } = query

  // ── 生命周期 ──

  const mount = async () => {
    controls.bindGlobalKeys()
    conn.loadHeaderHistory()

    // URL 参数优先于本地存储：外部直链打开时不该被上次的地址/播放列表覆盖
    const queryParams = parseQueryVideoParams()

    const savedState = loadSavedState()
    if (savedState) {
      hydrate(savedState)
      // 没有 URL 参数时才恢复保存的视频地址
      if (!queryParams.urls.length && savedState.videoUrlInput) {
        media.videoUrlInput.value = savedState.videoUrlInput
        playlist.playlist.value = savedState.playlist || []
        playlist.currentIndex.value = savedState.currentIndex ?? 0
        // 作业单要跟着列表一起回来，否则恢复出来的是一列播不了的占位地址
        if (savedState.lazyTask) handoff.setLazyTask(savedState.lazyTask, playlist.playlist.value)
      }
    }

    if (queryParams.urls.length) {
      media.videoUrlInput.value = queryParams.urls.join('\n')
      // 老链接里的 origin/referer 收作候选值喂给探测（不再强制生效——连接方式一律自动决定）。
      // proxy/noref/manifestOnly 直接忽略：它们是引擎的中间态，固化下来只会让探测绕远。
      // 注意这几个键仍留在 PAGE_QUERY_KEYS 里，否则 `&origin=` 这段会被当成视频地址的一部分回写。
      if (queryParams.origin !== undefined || queryParams.referer !== undefined) {
        if (queryParams.origin !== undefined) conn.originHint.value = queryParams.origin
        if (queryParams.referer !== undefined) conn.refererHint.value = queryParams.referer
        media.showAdvancedProxy.value = true
      }
      await nextTick()
      // playByIndex 内部会置 isRestoringFromSaved，直链进来即自动起播
      await playlist.parseAndLoad(queryParams.index)
    } else if (savedState?.playlist?.length) {
      // 刷新后恢复：有保存的播放列表且为网络链接，自动加载并播放
      const idx = savedState.currentIndex ?? 0
      if (savedState.playlist[idx]?.startsWith('http')) {
        media.isRestoringFromSaved.value = true
        await nextTick()
        await playlist.playByIndex(idx)
      }
    } else if (savedState?.videoUrlInput?.trim()) {
      // 有视频地址但无播放列表（如粘贴后未解析），尝试解析并加载
      await nextTick()
      media.isRestoringFromSaved.value = true
      await playlist.parseAndLoad()
    }

    window.addEventListener('beforeunload', playlist.saveCurrentProgress)
  }

  const unmount = () => {
    playlist.saveCurrentProgress()
    engine.destroyHls()
    engine.clearLoadTimeout()
    controls.unbindGlobalKeys()
    events.disposeEvents()
    window.removeEventListener('beforeunload', playlist.saveCurrentProgress)
  }

  // 全部平铺成一层：子组件里 `const { volume, playlist, strategyLabel } = useVideoPlayerCtx()`
  // 就能直接解构出来当顶层 setup 绑定用（模板里自动解包 ref、v-model 也能写）。
  // 各模块的返回键名互不重复，这一点在新增导出时要保持。
  return {
    ...media,
    ...handoff,
    ...tier,
    ...conn,
    ...playlist,
    ...engine,
    ...autoTune,
    ...controls,
    ...events,
    ...download,
    ...query,
    saveState, mount, unmount,
  }
}

export type VideoPlayerCtx = ReturnType<typeof useVideoPlayerController>

export const VIDEO_PLAYER_KEY = Symbol('video-player') as InjectionKey<VideoPlayerCtx>

/** 子组件取上下文。页面必须先 provide，否则这里直接抛错比拿到 undefined 好排查 */
export function useVideoPlayerCtx(): VideoPlayerCtx {
  const ctx = inject(VIDEO_PLAYER_KEY)
  if (!ctx) throw new Error('useVideoPlayerCtx 必须在 video-player 页面内使用')
  return ctx
}
