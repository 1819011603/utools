/**
 * 用户交互：播放/暂停、进度条拖拽、音量、倍速、全屏、画中画、控制栏显隐、键盘快捷键。
 *
 * 只碰 `<video>` 元素和界面 ref，不参与加载决策，所以只依赖 media 和 autoTune（倍速换算）。
 * 「上/下一集」不在这里——那是播放列表的事，模板直接用 playlist 那份。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoAutoTune } from './useVideoAutoTune'

export interface VideoUiControlsDeps {
  media: VideoMediaState
  /** 倍速换算在自愈调参环里（实际生效倍速受带宽/抗卡守卫钳制） */
  autoTune: VideoAutoTune
}

export function useVideoUiControls(deps: VideoUiControlsDeps) {
  const { media, autoTune } = deps
  const {
    videoEl, playerContainer, progressBar, isPlaying, isVideoLoaded, duration,
    volume, isMuted, desiredRate, autoBestRate, isFullscreen, showControls, showPlayIcon, showSpeedMenu,
    seekPreviewTime, seekPreviewPercent, isSeeking, hoverTime, hoverPercent, preloadStrategy,
  } = media

  let controlsTimer: ReturnType<typeof setTimeout> | null = null
  let playIconTimer: ReturnType<typeof setTimeout> | null = null

  const supportsPiP = computed(() => document.pictureInPictureEnabled)

  const volumeIcon = computed(() =>
    isMuted.value || volume.value === 0 ? 'i-heroicons-speaker-x-mark' : 'i-heroicons-speaker-wave')

  const canDownload = computed(() =>
    isVideoLoaded.value && !!media.videoUrl.value
    && (media.videoUrl.value.startsWith('http') || media.videoUrl.value.startsWith('//')))

  const togglePlay = () => {
    if (!videoEl.value) return
    if (isPlaying.value) videoEl.value.pause()
    else videoEl.value.play()

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
    if (!isFullscreen.value) {
      try { screen.orientation?.unlock?.() } catch { /* 桌面没有这能力 */ }
    }
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
      if (isPlaying.value) showControls.value = false
    }, CONTROLS_HIDE_MS)
  }

  const handleMouseMove = () => {
    showControls.value = true
    hideControlsDelayed()
  }

  /** 在控制栏上有任何动作就重新计时（触摸端唯一的续命途径） */
  const keepControlsAlive = () => {
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
      case 'p': case 'P':
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
  }
  const unbindGlobalKeys = () => {
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    if (controlsTimer) clearTimeout(controlsTimer)
    if (playIconTimer) clearTimeout(playIconTimer)
  }

  return {
    supportsPiP, volumeIcon, canDownload,
    togglePlay, skip, startSeek, updateSeekPreview, updateHoverTime,
    setVolume, toggleMute, setPlaybackRate,
    toggleFullscreen, togglePiP, handleMouseMove, hideControlsDelayed, keepControlsAlive,
    applyPreload, bindGlobalKeys, unbindGlobalKeys,
  }
}

export type VideoUiControls = ReturnType<typeof useVideoUiControls>
