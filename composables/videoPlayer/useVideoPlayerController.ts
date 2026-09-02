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

  // 「这部剧收了没」。同样只吃 handoff，装在这里三处按钮才共用同一份状态
  const favorite = useVideoFavorite({ handoff })

  // 按剧记住倍速与片头片尾。只吃裸状态 + handoff（剧名从那儿来），不碰 playlist，
  // 所以放在最前面装：它靠 watch 剧名工作，装配顺序对它没有要求
  const showPrefs = useShowPrefs({ media, handoff })

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
    applyHints: (origin, referer) => {
      if (origin) conn.originHint.value = origin
      if (referer) conn.refererHint.value = referer
      // 不再顺手展开连接设置：那块已经是页面下方默认折叠的一节，
      // 而解析来的候选头几乎每次都有，等于「默认折叠」形同虚设（用户点名要求收起）
    },
  })

  engine = useVideoEngine({
    media,
    conn,
    tier,
    progressKey: () => playlist.progressKey(),
    getSavedProgress: url => playlist.getSavedProgress(url),
    refetchUrl: silent => playlist.refetchCurrentUrl(silent),
  })

  // 自愈调参环每秒跑一次，挂在引擎心跳上（引擎不反向依赖它）
  const autoTune = useVideoAutoTune({ media, tier, conn, engine })
  engine.registerTickHook(autoTune.selfHeal)

  // 下一集预热同样挂心跳：快播完这一集时后台把下一集的取址/探测/manifest/首几片先做掉
  const prewarm = useVideoPrewarm({ media, handoff, conn, engine, playlist })
  engine.registerTickHook(prewarm.prewarmTick)

  // 下载：真正的队列是模块级单例（离开这一页也接着跑），这里装的只是薄壳。
  // 排在 engine/playlist 之后——它要问引擎「缓冲健不健康」、问 playlist 取按需地址
  const download = useVideoDownload({
    media, handoff, engine, conn, playlist,
    onDirty: () => saveState(),
  })

  const events = useVideoEvents({ media, engine, conn, playlist })
  const controls = useVideoUiControls({ media, autoTune, playlist })
  // 手势层建在控制层之上：它把「一次指针交互」翻译成控制层已有的动作
  const gestures = useVideoGestures({ media, controls, autoTune })
  // 右键菜单/媒体信息面板：只读裸状态 + 问引擎要一眼当前档位，不参与任何加载决策
  const contextMenu = useVideoContextMenu({ media, getHls: engine.getHls })

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
        turboRate: media.turboRate.value,
        bgPlay: media.bgPlay.value,
        skipIntro: media.skipIntro.value,
        skipOutro: media.skipOutro.value,
        fitMode: media.fitMode.value,
        hwDecode: media.hwDecode.value,
        boostRate: media.boostRatePref.value,
        dlMp4: download.dlMp4.value,
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
    media.turboRate.value = s.turboRate ?? false
    media.bgPlay.value = s.bgPlay ?? false
    media.skipIntro.value = s.skipIntro ?? 0
    media.skipOutro.value = s.skipOutro ?? 0
    media.fitMode.value = s.fitMode ?? 'default'
    media.hwDecode.value = s.hwDecode ?? true
    media.boostRatePref.value = s.boostRate ?? 2
    download.dlMp4.value = s.dlMp4 ?? false
    conn.useProxy.value = s.useProxy ?? false
    conn.requestOrigin.value = s.requestOrigin ?? ''
    conn.requestReferer.value = s.requestReferer ?? ''
    conn.manifestOnly.value = s.manifestOnly ?? true
    conn.disguiseAsDownloader.value = s.disguiseAsDownloader ?? false
    conn.dualChannel.value = s.dualChannel ?? false
    conn.originHint.value = s.originHint ?? ''
    conn.refererHint.value = s.refererHint ?? ''
    if (s.hlsConfig) media.hlsConfig.value = { ...media.hlsConfig.value, ...migrateHlsTuning(s.hlsConfig) }
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

    // 老链接里的 origin/referer 收作候选值喂给探测（不再强制生效——连接方式一律自动决定）。
    // proxy/noref/manifestOnly 直接忽略：它们是引擎的中间态，固化下来只会让探测绕远。
    // 注意这几个键仍留在 PAGE_QUERY_KEYS 里，否则 `&origin=` 这段会被当成视频地址的一部分回写。
    //
    // 必须放在所有加载分支**之前**：解析失败/超时那条路上不会有 applyHints，
    // 这对候选头只能从 query 来，漏了就只剩探测硬碰，防盗链站点直接一片红。
    if (queryParams.origin !== undefined || queryParams.referer !== undefined) {
      if (queryParams.origin !== undefined) conn.originHint.value = queryParams.origin
      if (queryParams.referer !== undefined) conn.refererHint.value = queryParams.referer
    }

    const savedState = loadSavedState()
    if (savedState) {
      hydrate(savedState)
      // hydrate 装的是「上一次」那份全局值，**必须排在按剧那份之前**，否则把本剧的设置盖回去。
      // 眼下没有哪条路会在 hydrate 之前拿到剧名（交接槽删掉之后，剧名只在解析成功时才有），
      // 所以这一发通常什么都不做；留着是为了把顺序钉死——将来谁再往 mount 前面加一条
      // 「先认出是哪部剧」的路径（比如从 savedState 里也存剧名），不补这一发就会静默失效
      showPrefs.applyShowPrefs()
      // 没有 URL 参数时才恢复保存的视频地址（parseUrl 也算——那条路自己会装好列表，
      // 先恢复上一份只会让旧作业单短暂串进来）
      if (!queryParams.urls.length && !queryParams.parseUrl && savedState.videoUrlInput) {
        media.videoUrlInput.value = savedState.videoUrlInput
        playlist.playlist.value = savedState.playlist || []
        playlist.currentIndex.value = savedState.currentIndex ?? 0
        // 作业单要跟着列表一起回来，否则恢复出来的是一列播不了的占位地址
        if (savedState.lazyTask) handoff.setLazyTask(savedState.lazyTask, playlist.playlist.value)
      }
    }

    if (queryParams.parseUrl) {
      // 分享进来的链接：列表一律由「源站播放页 + 线路」**现场解析**。
      //
      // 这里曾经有一条捷径：从 /video-parse 点进来或本机刷新时，localStorage 的「交接槽」里
      //（`video-player-handoff`，整套已删）就是同一份列表，直接用它装列表、跳过整轮解析。已按需求删除——
      // 现在每次进播放器都重解析一遍，代价是慢站几秒、按需取址的站点还可能撞上限流；
      // 换来的是「列表永远是当前源站的实况」，作业单/集名/线路表都是新的。
      // 按需取址的站点不受影响：loadFromParseSource 自己会 setLazyTask 拿到新作业单。
      const line = queryParams.line ?? 0
      // 集数只认 query。槽里那份 index 一并弃用——它本来就只在「槽确实是这份列表」时才敢用
      //（否则分享链接会跳到收链接的人本机上一部剧的集数，实测抓到过）
      const idx = queryParams.index ?? 0
      await nextTick()
      await playlist.loadFromParseSource(queryParams.parseUrl, line, idx, queryParams.lineName, queryParams.ep, queryParams.t)
    } else if (queryParams.urls.length) {
      media.videoUrlInput.value = queryParams.urls.join('\n')
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
    gestures.disposeGestures()
    contextMenu.disposeContextMenu()
    events.disposeEvents()
    window.removeEventListener('beforeunload', playlist.saveCurrentProgress)
  }

  // 全部平铺成一层：子组件里 `const { volume, playlist, strategyLabel } = useVideoPlayerCtx()`
  // 就能直接解构出来当顶层 setup 绑定用（模板里自动解包 ref、v-model 也能写）。
  // 各模块的返回键名互不重复，这一点在新增导出时要保持。
  return {
    ...media,
    ...handoff,
    ...favorite,
    ...showPrefs,
    ...tier,
    ...conn,
    ...playlist,
    ...engine,
    ...autoTune,
    ...prewarm,
    ...download,
    ...controls,
    ...gestures,
    ...contextMenu,
    ...events,
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

/**
 * 「在播放器里就用，不在也能活」——媒体库那套组件（左侧悬浮抽屉、播放历史、收藏）
 * 同时挂在播放页、搜索页、解析页上，后两个页面**根本没有播放器**。
 *
 * 所以它们一律走这个可选版：拿不到就是 `null`，调用方按「没有正在播的那部剧」处理
 *（点一条走整页跳转、不显示「换源」和「收藏当前」）。用抛错那版的话，
 * 那两个页面一挂上就白屏。
 */
export function useVideoPlayerCtxOptional(): VideoPlayerCtx | null {
  return inject(VIDEO_PLAYER_KEY, null)
}
