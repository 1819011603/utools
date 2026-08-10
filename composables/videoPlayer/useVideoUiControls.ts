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
    volume, isMuted, desiredRate, autoBestRate, autoFullscreen, isFullscreen, showControls, showPlayIcon, showSpeedMenu,
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

  const togglePlay = () => {
    if (!videoEl.value) return
    restoreSound()
    if (isPlaying.value) {
      videoEl.value.pause()
    } else {
      // 开播这一下就是浏览器要的「用户激活」，自动全屏在这里兑现最稳：
      // 不看 pendingAutoFullscreen（它只在首个 canplay 置位，错过就没了），
      // 只要开关开着且还没全屏就进——「点中央播放键 = 播放 + 全屏 + 横屏」必须是确定行为。
      if (autoFullscreen.value && !document.fullscreenElement) void enterAutoFullscreen()
      else consumeAutoFullscreen()
      void videoEl.value.play()
    }

    showPlayIcon.value = true
    if (playIconTimer) clearTimeout(playIconTimer)
    playIconTimer = setTimeout(() => { showPlayIcon.value = false }, 500)
  }

  const skip = (seconds: number) => {
    if (!videoEl.value) return
    videoEl.value.currentTime = Math.max(0, Math.min(duration.value, videoEl.value.currentTime + seconds))
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

  /** 用户选择的是「目标倍速」（自动模式下当上限），实际生效由 autoTune.applyEffectiveRate 决定 */
  const setPlaybackRate = (rate: number) => {
    desiredRate.value = rate
    // 自动模式只在 ≥1 里取值，选慢放显然是要慢放 → 直接退出自动，否则这一次点击看着毫无反应
    if (rate < 1 && autoBestRate.value) autoBestRate.value = false
    autoTune.resetRateCooldown()
    autoTune.applyEffectiveRate()
    showSpeedMenu.value = false
  }

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
   * 兑现「加载后自动全屏」。
   *
   * 手机浏览器要求**用户激活**才准进全屏，页面加载完自动调必被拒——安卓上这个开关从来没生效过，
   * 而失败只被 console.log 吞掉，从界面上完全看不出。现在拒了就把意图挂着（pendingAutoFullscreen），
   * 用户第一次碰播放器（点中央播放键、单击画面）时补上。
   */
  const enterAutoFullscreen = async () => {
    if (!playerContainer.value || document.fullscreenElement) { pendingAutoFullscreen.value = false; return }
    try {
      await playerContainer.value.requestFullscreen()
      isFullscreen.value = true
      pendingAutoFullscreen.value = false
      await lockLandscape()
    } catch { /* 没有用户激活，留着意图等下一次交互 */ }
  }

  watch(pendingAutoFullscreen, (v) => { if (v) void enterAutoFullscreen() })

  /** 任何一次用户交互都可以调；没有挂起意图时是空操作 */
  const consumeAutoFullscreen = () => { if (pendingAutoFullscreen.value) void enterAutoFullscreen() }

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

  // 用户按 Esc / 系统手势退出全屏时不会走 toggleFullscreen，横屏锁要在这里解
  const handleFullscreenChange = () => {
    isFullscreen.value = !!document.fullscreenElement
    if (isFullscreen.value) return
    // 退出全屏就解锁：锁定是「全屏握持防误触」，回到小窗它只剩坏处——
    // 手势层全 return、控制栏恒隐、快捷键也停，画面上只剩一枚解锁键（踩过：来电退出全屏后点什么都没反应）
    media.isLocked.value = false
    try { screen.orientation?.unlock?.() } catch { /* 桌面没有这能力 */ }
    // 页面在后台时退出的全屏不是用户的意思（安卓切应用/来电会替他退），
    // 那种要留着意图，回前台时替他要回来（见 handleVisibility）
    if (!document.hidden) pendingAutoFullscreen.value = false
  }

  /**
   * 安卓上切到别的应用再回来，系统常常已经把全屏退掉了。用户的本意显然是「继续全屏看」，
   * 所以记住切走那一刻的全屏状态，回来时替他要回去。
   *
   * `requestFullscreen` 要用户激活，「页面重新可见」不算，所以多半当场被拒——
   * 拒了就把意图挂着（pendingAutoFullscreen），用户下一次碰画面时补上，
   * 这套挂起-补兑现的机制自动全屏那边已经在用了。
   */
  let wasFullscreenBeforeHide = false
  const handleVisibility = () => {
    if (document.hidden) { wasFullscreenBeforeHide = isFullscreen.value; return }
    if (wasFullscreenBeforeHide && !document.fullscreenElement) pendingAutoFullscreen.value = true
    wasFullscreenBeforeHide = false
  }

  // ── 控制栏显隐 ──

  // 触摸端没有「移动鼠标就续命」这回事：点一下唤出来之后就只剩这个倒计时在跑，
  // 3 秒不够手指移过去点倍速/下载（还要先看清图标在哪），实测经常点到一半就收了
  const CONTROLS_HIDE_MS = 5000

  const hideControlsDelayed = () => {
    if (controlsTimer) clearTimeout(controlsTimer)
    controlsTimer = setTimeout(() => {
      // 倍速菜单是控制栏的子元素，收控制栏会把摊开的菜单一起带走——
      // 表现就是「点开倍速还没选就没了」。开着就顺延，等它关了再收
      if (showSpeedMenu.value) { hideControlsDelayed(); return }
      showControls.value = false   // 暂停时也收：暂停态自有中央播放键，控制栏杵着只是挡画面
    }, CONTROLS_HIDE_MS)
  }

  const handleMouseMove = () => {
    showControls.value = true
    hideControlsDelayed()
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
      case '<': case ',': {
        const i = PLAYBACK_RATES.indexOf(desiredRate.value)
        if (i > 0) setPlaybackRate(PLAYBACK_RATES[i - 1])
        break
      }
      case '>': case '.': {
        const i = PLAYBACK_RATES.indexOf(desiredRate.value)
        if (i >= 0 && i < PLAYBACK_RATES.length - 1) setPlaybackRate(PLAYBACK_RATES[i + 1])
        break
      }
    }
  }

  const bindGlobalKeys = () => {
    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('visibilitychange', handleVisibility)
  }
  const unbindGlobalKeys = () => {
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('visibilitychange', handleVisibility)
    if (controlsTimer) clearTimeout(controlsTimer)
    if (playIconTimer) clearTimeout(playIconTimer)
  }

  return {
    supportsPiP, volumeIcon,
    togglePlay, skip, startSeek, updateSeekPreview, updateHoverTime,
    setVolume, toggleMute, setPlaybackRate,
    toggleFullscreen, togglePiP, handleMouseMove, hideControlsDelayed, keepControlsAlive, consumeAutoFullscreen, restoreSound,
    applyPreload, bindGlobalKeys, unbindGlobalKeys,
  }
}

export type VideoUiControls = ReturnType<typeof useVideoUiControls>
