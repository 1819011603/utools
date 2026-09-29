/**
 * 全屏 / 画中画 / 切走应用-切回来 / 锁定态全屏看门狗（从 useVideoUiControls.ts 下沉）。
 *
 * 这一块全是「猜时序 + 补兑现」：安卓/Windows 上系统退全屏的时机、切走时浏览器自己按暂停、
 * 挂起的全屏意图什么时候兑现……单独成文件是为了让这块的坑有地方讲清楚，不淹没交互逻辑。
 */
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoPlaylistCtl } from '../useVideoPlaylistCtl'

export interface FullscreenControllerDeps {
  media: VideoMediaState
  playlist: VideoPlaylistCtl
}

export function useFullscreenController(deps: FullscreenControllerDeps) {
  const { media, playlist } = deps
  const {
    videoEl, playerContainer, isFullscreen, pendingAutoFullscreen, isLocked, isPlaying, bgPlay,
    showControls, showSpeedMenu, showEpisodes, showSettings, showLines, showDownloads, showLockBtn,
  } = media

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
   * 挂起 `restore` 意图期间，在 **document** 上守着 pointerdown。
   *
   * 安卓切回来时全屏已经被系统退掉了，而「窗口重新获得焦点」不算用户激活 →
   * `requestFullscreen()` 必被拒，只能等他碰一下。**但他碰的地方常常不在播放器上**：
   * 退出全屏后整页都露出来了，手指第一下多半落在别处（尤其锁定态，画面上什么都没有）。
   * 只在容器上等的话那一下白费，于是卡在「锁定 + 小窗」（用户点名报过）。
   * **只给触摸端**：桌面上任何一次点页面都突然全屏太惊吓，那边靠点画面那条路就够了。
   *
   * **不能用 `once`。** 兑现是异步的（`requestFullscreen` 返回 Promise），被拒之后重新绑要等到
   * 下一个 microtask，用户在那之前又点一下就白点了；而「点了没反应、再点还是没反应」正是
   * 这套东西最难查的表现。改成一直守着，**只有真的进了全屏才解绑**（见 enterAutoFullscreen）。
   */
  let restoreTapBound = false
  const onAnyTapRestore = () => {
    if (pendingIsRestore) void enterAutoFullscreen()
  }
  const bindRestoreTap = () => {
    if (restoreTapBound || !isTouchPrimary()) return
    restoreTapBound = true
    document.addEventListener('pointerdown', onAnyTapRestore, true)
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
      userExitedFs = true          // 这一发是他自己按的，别再要回来（见 handleFullscreenChange）
      // 退不成功就把标记撤回去，否则它会一直挂着，把之后某一发系统退全屏冒充成「用户自己退的」
      await document.exitFullscreen().catch(() => { userExitedFs = false })
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
  /** 回前台后补打的那几发 requestFullscreen（见 armRestore） */
  let restoreShots: ReturnType<typeof setTimeout>[] = []
  /** 用户自己点了「退出全屏」。只有这一种退出不该被要回来 */
  let userExitedFs = false
  /**
   * 刚回到前台的时刻。安卓上系统那一发退出全屏**常常晚于 `visibilitychange`**，
   * 于是 `fullscreenchange` 派发时 `isBackgrounded()` 已经是 false → 被判成「用户自己退的」→
   * 意图当场作废 → 切回来停在小窗。这个窗口就是拿来兜住那一发的。
   */
  let foregroundAt = 0
  /*
   * **开了后台播放之后这个窗口必须给得很宽。** 关着的时候视频在后台是停的，安卓当场就把全屏退了
   *（那一发落在后台，`isBackgrounded()` 接得住）；开着的时候视频没停、全屏能一直挂到回前台，
   * 于是退全屏那一发**晚于** `visibilitychange` 落下来，晚多少完全看机型 —— 2 秒接不住，
   * 就落进「前台退的 = 他自己退的」→ 意图作废 → 停在窄屏。
   * 代价是切回来这 6 秒内用返回手势退全屏会被拽回去一次，比「全屏自己没了」轻。
   */
  const JUST_FOREGROUND_MS = 6000

  /** 后台播放：切走之后补打的那几发 `play()`（见 onBackground） */
  let bgPlayShots: ReturnType<typeof setTimeout>[] = []
  const clearBgPlayShots = () => { bgPlayShots.forEach(clearTimeout); bgPlayShots = [] }
  const scheduleBgPlayShots = () => {
    if (!isPlaying.value) return          // 他本来就是暂停着切走的，别替他开播
    clearBgPlayShots()
    /*
     * 判据只能是「切走那一刻在播」这个快照，**不能是 `isPlaying`**：浏览器那一发暂停会派发
     * `pause` 事件，`isPlaying` 当场变 false —— 拿它当条件等于永远抢不回来。
     * 代价是这 2 秒内从通知栏/媒体键按的暂停也会被抢一次，但窗口就这么长，之后一概不管。
     */
    bgPlayShots = [120, 400, 900, 2000].map(ms => setTimeout(() => {
      const v = videoEl.value
      if (!backgrounded || !bgPlay.value || !v || !v.paused) return   // 回前台了就不归这儿管
      v.play().catch(() => { /* 系统不让就算了，别跟它掰手腕 */ })
    }, ms))
  }

  /**
   * 挂起「把他刚刚那个全屏还回去」的意图，并尽力当场兑现。
   *
   * 三件事一起做，缺一不可：① 补几发 `requestFullscreen` —— 安卓上回前台这一发多半当场被拒
   *（没有用户激活），但拒不拒跟时机有关，有些机型在恢复后头一两百毫秒里是放行的，白试没有代价；
   * ② **显式** `bindRestoreTap()` 守他的下一次触摸 —— 不能指望 `watch(pendingAutoFullscreen)`
   * 的副作用，那个 ref 已经是 `true` 时 watch 根本不触发，于是没人去绑，卡在「锁定 + 小窗」；
   * ③ 意图标成 `restore` 而不是 `setting`（后者在桌面上被拒会就地作废）。
   */
  const armRestore = () => {
    pendingIsRestore = true
    pendingAutoFullscreen.value = true
    bindRestoreTap()
    restoreShots.forEach(clearTimeout)
    restoreShots = [0, 160, 500, 1200].map(ms => setTimeout(() => {
      if (pendingIsRestore) void enterAutoFullscreen()
    }, ms))
  }

  /**
   * **锁定态的全屏看门狗。**
   *
   * 前面那一套（记「切走前是不是全屏」、判「这一发退全屏是谁干的」、掐「刚回前台」的窗口）
   * 全是在**猜时序**，而安卓上退全屏那一发到底落在切走前、后台里、还是回前台之后，
   * 跟机型、跟视频有没有在后台继续播都有关系 —— 猜错一次就是「切回来变窄屏」。
   *
   * 锁定态给了一个不用猜的判据：**锁屏本身就是「我在横屏看片、别动画面」的明确表态**，
   * 所以这个状态下压根不该存在窄屏或竖屏，发现了就一直要回来。于是这里不问是谁退的、
   * 什么时候退的，只看当下对不对：掉出全屏 → 意图挂着 + 每 2s 试一发 + 守着他下一次触摸；
   * 还在全屏但方向锁被系统释放了（后台播放时最常见，见 onForeground）→ 补锁横屏。
   *
   * **只给触摸端**：桌面上没有「系统替你退全屏」这回事，一直抢反而是打扰。
   * 被拒是静默的（`enterAutoFullscreen` 自己 catch），成本只有一个 Promise。
   */
  let lockFsTimer: ReturnType<typeof setInterval> | null = null
  let lastLockFsTry = 0
  const lockFsTick = () => {
    if (!isLocked.value || backgrounded) return   // 后台里要全屏没有意义，回前台那一拍再说
    if (document.fullscreenElement) {
      if (isPortrait()) void lockLandscape()
      return
    }
    pendingIsRestore = true
    pendingAutoFullscreen.value = true
    bindRestoreTap()
    const now = performance.now()
    if (now - lastLockFsTry < 2000) return   // 试的频率压一压：多数会被拒，没必要每秒来一发
    lastLockFsTry = now
    void enterAutoFullscreen()
  }
  const stopLockFsWatch = () => {
    if (!lockFsTimer) return
    clearInterval(lockFsTimer)
    lockFsTimer = null
  }
  watch(isLocked, (on) => {
    stopLockFsWatch()
    if (!on || !isTouchPrimary()) return
    lastLockFsTry = 0
    lockFsTimer = setInterval(lockFsTick, 1000)
  })

  /**
   * 切走。三件事：记住全屏状态（回来要还给他）、**锁定态下主动暂停**、把进度落库
   *（这一走完全可能就直接关标签页了，那时 `beforeunload` 未必来得及）。
   */
  const onBackground = () => {
    if (backgrounded) return          // blur 与 visibilitychange 常常一起来，只认第一发
    backgrounded = true
    // `||=`：系统可能**先**退全屏再让页面 hidden，那一发已经把它记成 true 了，别在这儿抹掉
    wasFullscreenBeforeHide = wasFullscreenBeforeHide || isFullscreen.value
    if (isLocked.value && isPlaying.value && videoEl.value && !bgPlay.value) {
      lockedAutoPaused = true
      videoEl.value.pause()
    }
    playlist.saveCurrentProgress()
    /*
     * **开了后台播放就得把浏览器按下的那一发抢回来。** 「我们不主动暂停」只做了一半：
     * 安卓 Chrome 在标签页转入后台时会自己把 `<video>` 停掉（省电策略，跟自动播放策略是两回事），
     * 我们一个事件都收不到就已经停了。所以隔几百毫秒复查几次，停了就 `play()` 回去。
     * 补几发而不是一发：那个策略不是同一时刻生效的，机型/版本之间差好几百毫秒。
     * 一直失败也不硬撑（见 bgPlayShots 的次数），否则会跟系统来回掰手腕。
     */
    if (bgPlay.value) scheduleBgPlayShots()
  }

  /**
   * 回来。把全屏要回去（系统/浏览器可能已经替他退了），锁定态则**自动接着播**，
   * 且这一刻什么都不弹 —— 锁定态的语义就是「画面上别出东西」，
   * 弹出控制栏/解锁键等于每次切回来都要再点一下才干净。
   */
  const onForeground = () => {
    if (!backgrounded) return
    backgrounded = false
    foregroundAt = performance.now()
    clearBgPlayShots()
    /*
     * 还在全屏里就先不动手：安卓那一发退出全屏常常晚于这里，由 `handleFullscreenChange`
     * 的 `JUST_FOREGROUND_MS` 窗口接住。这里抢着 armRestore 只会白试几发。
     *
     * **但横屏锁必须自己补一发。** 安卓切走应用时会释放 orientation lock，而它只在
     * `requestFullscreen` 兑现之后跟着调 —— 开了后台播放时视频没停、全屏压根没被退掉，
     * 于是那条路走不到，回来就是「还在全屏、但锁没了」→ 手机竖着拿当场变竖屏全屏
     *（上下两条黑边比不全屏还大）。这正是「关着后台播放一切正常、开了就变竖屏」的原因。
     */
    if (document.fullscreenElement) void lockLandscape()
    else if (wasFullscreenBeforeHide) armRestore()
    wasFullscreenBeforeHide = false
    if (!lockedAutoPaused) return
    lockedAutoPaused = false
    showControls.value = false
    showSpeedMenu.value = false
    showEpisodes.value = false
    showSettings.value = false
    showLines.value = false
    showDownloads.value = false
    showLockBtn.value = false
    videoEl.value?.play().catch(() => { /* 被策略拦下就等用户点一下 */ })
  }

  /*
   * **标签页重新可见 = 回前台，不再附加 `hasFocus()` 这个条件。**
   * 安卓上 `visibilitychange` 派发那一刻 `document.hasFocus()` 常常还是 false，而移动端浏览器
   * 切回应用时**未必补发 window `focus`** → 两条路都不成立 → `onForeground` 一次都不跑，
   * 全屏再也要不回来。这正是「有概率变回小窗」的主因（丢的是那一半信号，不是全屏 API 拒了）。
   * 反过来「可见但没焦点」在桌面上顶多是早触发一拍，onForeground 本身是幂等的。
   */
  const handleVisibility = () => {
    if (document.hidden) onBackground()
    else onForeground()
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
    const byUser = userExitedFs
    userExitedFs = false
    if (isLocked.value) {
      armRestore()
      return
    }
    if (byUser) {                  // 点了「退出全屏」那颗按钮，别拗着他
      wasFullscreenBeforeHide = false
      pendingAutoFullscreen.value = false
      pendingIsRestore = false
      unbindRestoreTap()           // 监听器不再是 once 的，清意图的地方都得自己摘
      return
    }
    if (isBackgrounded()) {
      // 系统替他退的。记下来（这一发可能**早于** onBackground，那时 isFullscreen 已是 false，
      // 光靠 onBackground 去读就成了「切走时不是全屏」）→ 回前台由 onForeground 要回来
      wasFullscreenBeforeHide = true
      return
    }
    // 刚回前台那一两秒里的退出同样是系统干的（安卓上它就是晚于 visibilitychange 派发）
    if (performance.now() - foregroundAt < JUST_FOREGROUND_MS) {
      armRestore()
      return
    }
    wasFullscreenBeforeHide = false   // Esc / 安卓返回手势，他自己在前台退的
    pendingAutoFullscreen.value = false
    pendingIsRestore = false
    unbindRestoreTap()
  }

  // ── 监听绑定（keydown 留在 useVideoUiControls，这里只管全屏/可见性那四个）──
  const bindFsListeners = () => {
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('visibilitychange', handleVisibility)
    // blur/focus 是桌面上唯一能察觉「切到别的应用」的信号（见 isBackgrounded）
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
  }
  const unbindFsListeners = () => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('visibilitychange', handleVisibility)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('focus', handleWindowFocus)
    unbindRestoreTap()
    restoreShots.forEach(clearTimeout)
    restoreShots = []
    clearBgPlayShots()
    stopLockFsWatch()
  }

  return { toggleFullscreen, togglePiP, consumeAutoFullscreen, enterAutoFullscreen, isTouchPrimary, bindFsListeners, unbindFsListeners }
}
