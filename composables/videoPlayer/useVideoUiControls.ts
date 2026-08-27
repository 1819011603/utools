/**
 * 用户交互：播放/暂停、进度条拖拽、音量、倍速、全屏、画中画、控制栏显隐、键盘快捷键。
 *
 * 只碰 `<video>` 元素和界面 ref，不参与加载决策，所以只依赖 media 和 autoTune（倍速换算）。
 * 「上/下一集」的实现不在这里（那是播放列表的事，模板直接用 playlist 那份），
 * 但**快捷键**得在这里——全局 keydown 只有这一处，切集键散在别处必然漂移。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoAutoTune } from './useVideoAutoTune'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'
// 只依赖最底层的本机账本，不认识同步引擎本身（方向与 useWatchHistory 一致，见 cloudSyncLocal 文件头）
import { requestSyncFlush } from '../cloudSyncLocal'

export interface VideoUiControlsDeps {
  media: VideoMediaState
  /** 倍速换算在自愈调参环里（实际生效倍速受带宽/抗卡守卫钳制） */
  autoTune: VideoAutoTune
  /** 只为 N/P 两个切集快捷键（实现仍在播放列表里） */
  playlist: VideoPlaylistCtl
}

export function useVideoUiControls(deps: VideoUiControlsDeps) {
  const { media, autoTune, playlist } = deps
  const {
    videoEl, playerContainer, progressBar, isPlaying, isVideoLoaded, duration,
    volume, isMuted, desiredRate, autoBestRate, turboRate, autoFullscreen, isFullscreen, showControls, showPlayIcon, showSpeedMenu,
    showEpisodes, showSettings, showLines, showLockBtn, isLocked,
    pendingAutoFullscreen, autoMuted,
    seekPreviewTime, seekPreviewPercent, isSeeking, hoverTime, hoverPercent, preloadStrategy,
  } = media

  let controlsTimer: ReturnType<typeof setTimeout> | null = null
  let playIconTimer: ReturnType<typeof setTimeout> | null = null

  const supportsPiP = computed(() => document.pictureInPictureEnabled)

  const volumeIcon = computed(() =>
    isMuted.value || volume.value === 0 ? 'i-heroicons-speaker-x-mark' : 'i-heroicons-speaker-wave')


  /** 静音兜底起播后，用户任何一次触碰都把声音还回来（这一下就是浏览器要的手势） */
  const restoreSound = () => {
    if (!autoMuted.value) return
    autoMuted.value = false
    isMuted.value = false
    if (videoEl.value) videoEl.value.muted = false
  }

  /**
   * 「用户自己动了看到哪儿」→ 落进度 + 请求同步一次（暂停 / 拖进度，切集在 playlist 那边）。
   *
   * **必须挂在用户动作上，绝不能挂 `<video>` 的 `pause`/`seeked` 事件**：那两个事件
   * 在抗卡时也会发（缓冲不够时引擎会主动 pause 去攒秒数、卡死自救会微跳播放头，
   * 见 useVideoEvents / engine/stallRecovery），一卡就同步一轮是把网络往火上浇。
   * 这里的调用点只有用户够得着——控制栏按钮、空格/方向键、手势层的单击和横滑。
   *
   * 去重（30 秒）在 `requestSyncFlush` 里做，三处调用方不用各写一份。
   */
  const flushAfterUserMove = () => {
    playlist.saveCurrentProgress()          // 先把这一刻的秒数落库，同步的才是最新的那份
    requestSyncFlush()
  }

  const togglePlay = () => {
    if (!videoEl.value) return
    restoreSound()
    if (isPlaying.value) {
      videoEl.value.pause()
      flushAfterUserMove()
    } else {
      // 「开播这一下顺便进全屏」**只在触摸端做**（见 isTouchPrimary）。
      // 手机上它是必需的：浏览器不给用户激活就不准全屏，页面加载时那一发必被拒，
      // 所以要挂起、等用户第一次碰播放器再补兑现，而「点中央播放键 = 播放 + 全屏 + 横屏」
      // 也得是确定行为。但桌面上单击 = 播放/暂停（鼠标标准），于是同一段代码变成了
      // **「点画面任何位置都会被拽进全屏」**（Windows 上踩到）。桌面本来也不需要它：
      // 起播那一发 requestFullscreen 在用户点「选集/播放」的激活窗口内多半直接就成了，
      // 成不了就算了——桌面进全屏有双击和 F 键，不该靠猜。
      if (isTouchPrimary()) {
        if (autoFullscreen.value && !document.fullscreenElement) void enterAutoFullscreen()
        else consumeAutoFullscreen()
      }
      void videoEl.value.play()
    }

    showPlayIcon.value = true
    if (playIconTimer) clearTimeout(playIconTimer)
    playIconTimer = setTimeout(() => { showPlayIcon.value = false }, 500)
  }

  const skip = (seconds: number) => {
    if (!videoEl.value) return
    videoEl.value.currentTime = Math.max(0, Math.min(duration.value, videoEl.value.currentTime + seconds))
    // 双击 ±5s / 方向键都汇到这里，都是用户自己在挪位置
    flushAfterUserMove()
  }

  // ── 进度条 ──

  const percentAt = (e: MouseEvent): number => {
    const rect = progressBar.value!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  const updateSeekPreview = (e: MouseEvent) => {
    if (!progressBar.value) return
    const p = percentAt(e)
    seekPreviewPercent.value = p * 100
    seekPreviewTime.value = p * duration.value
  }

  const updateHoverTime = (e: MouseEvent) => {
    if (!progressBar.value || isSeeking.value) return
    const p = percentAt(e)
    hoverPercent.value = p * 100
    hoverTime.value = p * duration.value
  }

  /**
   * 开始拖动进度条。单击也走这条路（抬手时统一 seek），避免单击+拖拽两套逻辑双重 seek。
   * 用 pointer 事件而不是 mouse：手指拖进度条时浏览器不保证补发 mousemove，
   * 只有触摸端「点一下能跳、拖不动」这一种表现。
   */
  const startSeek = (e: PointerEvent) => {
    if (!progressBar.value || !videoEl.value || !duration.value) return

    isSeeking.value = true
    updateSeekPreview(e)

    const onMove = (ev: PointerEvent) => updateSeekPreview(ev)
    const onUp = (ev: PointerEvent) => {
      isSeeking.value = false
      seekPreviewTime.value = null
      if (progressBar.value && videoEl.value) {
        videoEl.value.currentTime = percentAt(ev) * duration.value
        // 松手才 seek，也才是「他确实要看这儿」的那一刻（拖动过程中不发）
        flushAfterUserMove()
      }
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }

  // ── 音量 / 倍速 ──

  const setVolume = (e: Event) => {
    volume.value = parseFloat((e.target as HTMLInputElement).value)
    if (videoEl.value) {
      videoEl.value.volume = volume.value
      videoEl.value.muted = false
      isMuted.value = false
    }
  }

  const toggleMute = () => {
    if (!videoEl.value) return
    isMuted.value = !isMuted.value
    videoEl.value.muted = isMuted.value
  }

  /**
   * 倍速菜单与 `</>` 快捷键共用的档位表：开了「超快倍速」才把 3.5~5x 接上去。
   * 一个来源供两处用——各写一遍的话快捷键会步进到菜单里根本没有的档位。
   */
  const rateOptions = computed(() => turboRate.value ? [...PLAYBACK_RATES, ...TURBO_PLAYBACK_RATES] : PLAYBACK_RATES)

  /** 用户选择的是「目标倍速」（自动模式下当上限），实际生效由 autoTune.applyEffectiveRate 决定 */
  const setPlaybackRate = (rate: number) => {
    desiredRate.value = rate
    // 自动模式只在 ≥1 里取值，选慢放显然是要慢放 → 直接退出自动，否则这一次点击看着毫无反应
    if (rate < 1 && autoBestRate.value) autoBestRate.value = false
    autoTune.resetRateCooldown()
    autoTune.applyEffectiveRate()
    showSpeedMenu.value = false
  }

  /**
   * 关掉「超快倍速」时把已经选上的高档位收回到 3x：
   * 否则开关关了倍速还停在 5x，而菜单里连这一档都不再显示——看着就是「关不掉」。
   */
  watch(turboRate, on => { if (!on && desiredRate.value > 3) setPlaybackRate(3) })

  // ── 全屏 / 画中画 ──

  /**
   * 进全屏时在手机上顺手锁横屏——竖屏全屏只是把 16:9 画面钉在屏幕中间，
   * 上下两条黑边比不全屏还大，用户下一步动作必然是自己转手机。
   * `orientation.lock` 只在真全屏的文档里被允许，所以必须等 requestFullscreen 兑现之后再调；
   * 桌面浏览器与 iOS Safari 上它直接 reject，吞掉即可（不是错误路径，只是没这能力）。
   */
  const lockLandscape = async () => {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    if (!so?.lock) return
    // 只在窄屏（手机/平板）上锁：桌面窗口再窄也不该被强行转向
    if (Math.min(screen.width, screen.height) > 900) return
    try { await so.lock('landscape') } catch { /* 不支持或被拒，保持原样 */ }
  }

  /**
   * 触摸为主的设备（手机/平板）。用 `pointer: coarse` 判：Windows 上插着鼠标就是 fine，
   * 触摸屏笔记本也按鼠标算——这正是我们要的，因为要治的就是「桌面单击被拽进全屏」。
   */
  const isTouchPrimary = (): boolean =>
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true

  /** 竖屏（手机握持的常态）。全屏在竖屏下只是把 16:9 钉在屏幕正中，上下黑边比不全屏还大 */
  const isPortrait = (): boolean =>
    typeof window !== 'undefined' && window.innerHeight > window.innerWidth

  /**
   * 挂起的全屏意图是哪一种。
   *
   * `restore`（切走应用回来，把他刚刚的全屏还给他）与 `setting`（「加载后自动全屏」那个开关）
   * 必须分开：后者在桌面上被拒就得**就地作废**（否则会一直挂着，等用户某次单击画面时突然全屏），
   * 而前者恰恰要留着——桌面上「窗口重新获得焦点」不算用户激活，`requestFullscreen` 必被拒，
   * 就地作废等于 Windows 上切回来永远回不到全屏。
   */
  let pendingIsRestore = false

  /**
   * 挂起 `restore` 意图期间，在 **document** 上守一发一次性的 pointerdown。
   *
   * 安卓切回来时全屏已经被系统退掉了，而「窗口重新获得焦点」不算用户激活 →
   * `requestFullscreen()` 必被拒，只能等他碰一下。**但他碰的地方常常不在播放器上**：
   * 退出全屏后整页都露出来了，手指第一下多半落在别处（尤其锁定态，画面上什么都没有）。
   * 只在容器上等的话那一下白费，于是卡在「锁定 + 小窗」（用户点名报过）。
   * **只给触摸端**：桌面上任何一次点页面都突然全屏太惊吓，那边靠点画面那条路就够了。
   */
  let restoreTapBound = false
  const onAnyTapRestore = () => {
    restoreTapBound = false
    if (pendingIsRestore) void enterAutoFullscreen()
  }
  const bindRestoreTap = () => {
    if (restoreTapBound || !isTouchPrimary()) return
    restoreTapBound = true
    document.addEventListener('pointerdown', onAnyTapRestore, { capture: true, once: true })
  }
  const unbindRestoreTap = () => {
    if (!restoreTapBound) return
    restoreTapBound = false
    document.removeEventListener('pointerdown', onAnyTapRestore, true)
  }

  /**
   * 兑现自动全屏。手机浏览器要求**用户激活**才准进全屏，页面加载完自动调必被拒 →
   * 拒了就把意图挂着，等用户碰画面时补上。
   */
  const enterAutoFullscreen = async () => {
    if (!playerContainer.value || document.fullscreenElement) {
      pendingAutoFullscreen.value = false
      pendingIsRestore = false
      unbindRestoreTap()
      return
    }
    /*
     * **触摸端竖屏不自动全屏**，意图留着等转成横屏再兑现。补兑现唯一的时机是「用户碰画面」，
     * 而竖屏下最常见的那一碰就是点中间播放 → 「点一下播放」必然把人拽进上下全是黑边的竖屏全屏。
     * 但 `restore` 例外：那是把他自己开过的全屏还回去，比例问题他已经认了。
     */
    if (isTouchPrimary() && isPortrait() && !pendingIsRestore) return
    try {
      await playerContainer.value.requestFullscreen()
      isFullscreen.value = true
      pendingAutoFullscreen.value = false
      pendingIsRestore = false
      unbindRestoreTap()
      await lockLandscape()
    } catch {
      // 没有用户激活。留着意图等下一次交互补兑现；只有「设置」那一种在桌面上就地作废
      if (!isTouchPrimary() && !pendingIsRestore) pendingAutoFullscreen.value = false
      if (pendingIsRestore) bindRestoreTap()   // 他下一次碰屏幕（哪儿都算）就还回去
    }
  }

  watch(pendingAutoFullscreen, (v) => { if (v) void enterAutoFullscreen() })

  /**
   * 任何一次用户交互都可以调；没有挂起意图时是空操作。
   * `restoreOnly` 给鼠标用：桌面单击画面 = 播放/暂停，不该顺带被「设置」那种意图拽进全屏，
   * 但「刚刚就在全屏、切了个应用回来」这一种还回去是应该的。
   */
  const consumeAutoFullscreen = (restoreOnly = false) => {
    if (!pendingAutoFullscreen.value) return
    if (restoreOnly && !pendingIsRestore) return
    void enterAutoFullscreen()
  }

  const toggleFullscreen = async () => {
    if (!playerContainer.value) return
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
      try { screen.orientation?.unlock?.() } catch { /* 同上 */ }
      isFullscreen.value = false
      return
    }
    try {
      await playerContainer.value.requestFullscreen()
      isFullscreen.value = true
      await lockLandscape()
    } catch {
      // iOS Safari 不给容器全屏，只有 <video> 自己的原生全屏（自带横屏与系统控制条）
      const v = videoEl.value as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined
      if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen()
    }
  }

  const togglePiP = async () => {
    if (!videoEl.value) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await videoEl.value.requestPictureInPicture()
    } catch (e) {
      console.error('PiP error:', e)
    }
  }

  // ── 切走应用 / 切回来 ──

  /**
   * 「页面在后台」= 标签页被藏起来 **或** 窗口失去焦点。
   *
   * **不能只看 `document.hidden`**：Windows 上 alt-tab 到别的应用、或者点一下另一个窗口，
   * 标签页仍然是「可见」的（`visibilityState === 'visible'`），`visibilitychange` 一声不响。
   * 只听它的话，「锁定态切应用 → 暂停 / 保住锁定 / 回来接着播」这一整套在 **Windows 上
   * 从来不会触发**，而这正是用户报的那个「切换应用全局播放没有保存」。
   * 手机上两个信号都会来（切应用一定会 hidden），多监听一个只是幂等地早触发一次。
   */
  const isBackgrounded = (): boolean => document.hidden || !document.hasFocus()

  let backgrounded = false
  let wasFullscreenBeforeHide = false
  let lockedAutoPaused = false
  /** 回前台后补打的那几发 requestFullscreen（见 onForeground） */
  let restoreShots: ReturnType<typeof setTimeout>[] = []

  /**
   * 切走。三件事：记住全屏状态（回来要还给他）、**锁定态下主动暂停**、把进度落库
   *（这一走完全可能就直接关标签页了，那时 `beforeunload` 未必来得及）。
   */
  const onBackground = () => {
    if (backgrounded) return          // blur 与 visibilitychange 常常一起来，只认第一发
    backgrounded = true
    wasFullscreenBeforeHide = isFullscreen.value
    if (isLocked.value && isPlaying.value && videoEl.value) {
      lockedAutoPaused = true
      videoEl.value.pause()
    }
    playlist.saveCurrentProgress()
  }

  /**
   * 回来。把全屏要回去（系统/浏览器可能已经替他退了），锁定态则**自动接着播**，
   * 且这一刻什么都不弹 —— 锁定态的语义就是「画面上别出东西」，
   * 弹出控制栏/解锁键等于每次切回来都要再点一下才干净。
   */
  const onForeground = () => {
    if (!backgrounded) return
    backgrounded = false
    if (wasFullscreenBeforeHide && !document.fullscreenElement) {
      pendingIsRestore = true
      pendingAutoFullscreen.value = true
      /*
       * **补几枪。** 安卓上「回到前台」这一发 requestFullscreen 多半当场被拒（没有用户激活），
       * 但拒不拒跟时机有关：有些机型/版本在恢复后的头一两百毫秒里是放行的。
       * 被拒是静默的，白试几次没有代价，而试中了用户就不用自己再点一下。
       * 一直失败也不要紧 —— `bindRestoreTap` 已经在守他的下一次触摸。
       */
      restoreShots.forEach(clearTimeout)
      restoreShots = [160, 500, 1200].map(ms => setTimeout(() => {
        if (pendingIsRestore) void enterAutoFullscreen()
      }, ms))
    }
    wasFullscreenBeforeHide = false
    if (!lockedAutoPaused) return
    lockedAutoPaused = false
    showControls.value = false
    showSpeedMenu.value = false
    showEpisodes.value = false
    showSettings.value = false
    showLines.value = false
    showLockBtn.value = false
    videoEl.value?.play().catch(() => { /* 被策略拦下就等用户点一下 */ })
  }

  const handleVisibility = () => {
    if (document.hidden) onBackground()
    else if (document.hasFocus()) onForeground()
  }
  const handleWindowBlur = () => onBackground()
  const handleWindowFocus = () => { if (!document.hidden) onForeground() }

  // 用户按 Esc / 系统手势退出全屏时不会走 toggleFullscreen，横屏锁要在这里解
  const handleFullscreenChange = () => {
    isFullscreen.value = !!document.fullscreenElement
    if (isFullscreen.value) return
    try { screen.orientation?.unlock?.() } catch { /* 桌面没有这能力 */ }
    /*
     * **锁定状态一律不因为退出全屏而解除**。
     *
     * 这里原来按「是不是在后台」去猜这一发是谁退的（系统替他退 → 留着锁，用户自己退 → 解锁），
     * 但那个判断在 Windows 上不可靠：`fullscreenchange` 常常**在窗口重新获得焦点之后**才派发，
     * 那时 `hasFocus()` 已经是 true → 判成「用户自己退的」→ 锁当场没了。
     * 猜不准就不猜。逃生口不依赖这里：锁定态下解锁键在任何尺寸下都渲染，点一下画面就露出来。
     * 顺便把全屏挂起，下一次点画面替他要回去（仍是锁定态）。
     */
    if (isLocked.value) {
      pendingIsRestore = true
      pendingAutoFullscreen.value = true
      return
    }
    if (isBackgrounded()) return   // 系统替他退的，意图留着回前台再要回来
    pendingAutoFullscreen.value = false
    pendingIsRestore = false
  }

  // ── 控制栏显隐 ──

  // 触摸端没有「移动鼠标就续命」这回事：点一下唤出来之后就只剩这个倒计时在跑，
  // 3 秒不够手指移过去点倍速/下载（还要先看清图标在哪），实测经常点到一半就收了
  const CONTROLS_HIDE_MS = 5000

  // 倍速菜单开着时的宽限次数。菜单是控制栏的子元素，收控制栏会把摊开的菜单一起带走
  // ——「点开倍速还没选就没了」。但**只能让一次路，不能无限顺延**：原来是无条件递归，
  // 于是点开菜单又不选（很常见：看一眼当前是几倍速就回去看片）时控制栏和菜单一起
  // 永远杵在画面上，只能特地去点一下别处才收
  let speedMenuGrace = 0

  const hideControlsDelayed = () => {
    if (controlsTimer) clearTimeout(controlsTimer)
    controlsTimer = setTimeout(() => {
      // 设置抽屉/换源面板是**独立浮层**（不在控制栏里），开着时控制栏照旧收
      if (showSpeedMenu.value && speedMenuGrace > 0) { speedMenuGrace--; hideControlsDelayed(); return }
      showSpeedMenu.value = false  // 宽限用完就连菜单一起收，否则下次唤出控制栏它还摊在那儿
      showControls.value = false   // 暂停时也收：暂停态自有中央播放键，控制栏杵着只是挡画面
    }, CONTROLS_HIDE_MS)
  }

  // 每次打开菜单重新给一次宽限（选完档位关掉再打开，理应又有完整的时间去挑）
  watch(showSpeedMenu, open => { if (open) speedMenuGrace = 1 })

  const handleMouseMove = () => {
    showControls.value = true
    hideControlsDelayed()
  }

  /**
   * 关掉画面上摊开的那些浮层（选集 / 设置 / 换源 / 倍速）。
   * 返回「有没有真的关掉什么」——点画面时优先关它们，而不是去切控制栏：
   * 设置和换源两块都只铺右侧 70%，露出来的那条画面正是用户想点掉它们的地方。
   */
  const closeOverlays = (): boolean => {
    if (!showEpisodes.value && !showSettings.value && !showLines.value && !showSpeedMenu.value) return false
    showEpisodes.value = false
    showSettings.value = false
    showLines.value = false
    showSpeedMenu.value = false
    return true
  }

  /**
   * 打开画面里的某一块浮层（选集 / 设置 / 换源），**三块互斥** —— 设置和换源都摊在右侧，
   * 同时开就是叠在一起。收在这里是因为竖屏时选集和齿轮的入口在顶栏、宽屏时在控制栏，
   * 两个组件各写一份必然漂移。
   */
  const openOverlay = (which: 'episodes' | 'settings' | 'lines') => {
    showEpisodes.value = which === 'episodes' && !showEpisodes.value
    showSettings.value = which === 'settings' && !showSettings.value
    showLines.value = which === 'lines' && !showLines.value
  }

  /** 在控制栏上有任何动作就重新计时（触摸端唯一的续命途径） */
  const keepControlsAlive = () => {
    consumeAutoFullscreen()
    restoreSound()   // 控制栏上的每一次点按都是「用户激活」，挂起的自动全屏顺手兑现
    showControls.value = true
    hideControlsDelayed()
  }

  // ── MP4 预加载 ──
  const applyPreload = () => {
    if (videoEl.value) videoEl.value.preload = preloadStrategy.value
  }

  // ── 快捷键 ──
  const handleKeydown = (e: KeyboardEvent) => {
    if (!isVideoLoaded.value) return
    // 锁定是「什么都别动」，快捷键跟着一起停，否则锁了还能空格暂停会显得开关是坏的
    if (media.isLocked.value) return
    // 忽略输入框、文本域中的按键
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return

    switch (e.key) {
      case 'Enter':
        e.preventDefault(); toggleFullscreen(); break
      case ' ':
        e.preventDefault(); togglePlay(); break
      case 'ArrowLeft':
        e.preventDefault(); skip(-5); break
      case 'ArrowRight':
        e.preventDefault(); skip(5); break
      case 'ArrowUp':
        e.preventDefault()
        volume.value = Math.min(1, volume.value + 0.1)
        if (videoEl.value) videoEl.value.volume = volume.value
        break
      case 'ArrowDown':
        e.preventDefault()
        volume.value = Math.max(0, volume.value - 0.1)
        if (videoEl.value) videoEl.value.volume = volume.value
        break
      case 'm': case 'M':
        toggleMute(); break
      case 'f': case 'F':
        toggleFullscreen(); break
      // 切集：N 下一集 / P 上一集。看剧时用得最多，而原来只能去点画面上的按钮
      //（窄屏还把「上一集」整个藏了）。P 让给上一集，画中画挪到 I——
      // 画中画在这一页几乎没人用，而 P/N 相邻正好是 prev/next 的直觉。
      case 'n': case 'N':
        e.preventDefault(); void playlist.playNext(); break
      case 'p': case 'P':
        e.preventDefault(); void playlist.playPrev(); break
      case 'i': case 'I':
        togglePiP(); break
      // 步进表跟菜单同一个来源（rateOptions）：写死 PLAYBACK_RATES 的话，
      // 开了超快倍速也只能按到 3x，而菜单里明明还有几档
      case '<': case ',': {
        const rates = rateOptions.value
        const i = rates.indexOf(desiredRate.value)
        if (i > 0) setPlaybackRate(rates[i - 1])
        break
      }
      case '>': case '.': {
        const rates = rateOptions.value
        const i = rates.indexOf(desiredRate.value)
        if (i >= 0 && i < rates.length - 1) setPlaybackRate(rates[i + 1])
        break
      }
    }
  }

  const bindGlobalKeys = () => {
    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('visibilitychange', handleVisibility)
    // blur/focus 是桌面上唯一能察觉「切到别的应用」的信号（见 isBackgrounded）
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
  }
  const unbindGlobalKeys = () => {
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('focus', handleWindowFocus)
    unbindRestoreTap()
    restoreShots.forEach(clearTimeout)
    restoreShots = []
    if (controlsTimer) clearTimeout(controlsTimer)
    if (playIconTimer) clearTimeout(playIconTimer)
  }

  return {
    supportsPiP, volumeIcon,
    togglePlay, skip, startSeek, updateSeekPreview, updateHoverTime,
    setVolume, toggleMute, setPlaybackRate, rateOptions,
    toggleFullscreen, togglePiP, handleMouseMove, hideControlsDelayed, keepControlsAlive, consumeAutoFullscreen, restoreSound,
    closeOverlays, openOverlay,
    applyPreload, bindGlobalKeys, unbindGlobalKeys,
  }
}

export type VideoUiControls = ReturnType<typeof useVideoUiControls>
