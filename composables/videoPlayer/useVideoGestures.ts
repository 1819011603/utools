/**
 * 画面手势层：单击唤出控制栏、双击左右 ±5s / 中间播放暂停、长按右侧临时 2x、
 * 横滑调进度、竖滑调音量与亮度、锁定屏幕。
 *
 * 为什么单独一层而不是塞进 useVideoUiControls：那边是「按钮点了要干什么」，
 * 这里是「一次指针交互到底算什么」——同一个 pointerdown 可能变成点击/双击/长按/拖拽四种之一，
 * 判定过程带一堆定时器和临时量，混进去会把控制栏那份也搅浑。
 *
 * 鼠标与触摸走同一套 Pointer Events，只在两处按 `pointerType` 分叉（见 onTap）：
 * 触摸端「双击中间 = 播放/暂停」，鼠标端「双击 = 全屏」——后者是桌面几十年的肌肉记忆，
 * 换掉的代价比统一带来的收益大。两端**都不再单击即播放/暂停**：那会让「想看看进度到哪了」
 * 这种最常见的意图必然误触一次暂停。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoUiControls } from './useVideoUiControls'
import type { VideoAutoTune } from './useVideoAutoTune'

/** 双击判定窗口。再长会让单击唤出控制栏明显发木（那一下要等窗口过完才执行） */
const DOUBLE_TAP_MS = 280
/** 长按加速的触发时长。短于 350ms 会和「按下去想拖但还没动」撞车 */
const LONG_PRESS_MS = 400
/** 超过这个位移就判为拖拽，不再是点击（触摸按下时手指本来就会漂几个像素） */
const MOVE_SLOP = 12
const DOUBLE_TAP_SEEK = 5
/** 横滑整个宽度对应的最大跨度：长片按比例映射会让 1px ≈ 10 秒，根本对不准 */
const SEEK_SPAN_MAX = 600
/** 左右边缘各占多少判为「快退/快进区」，中间留给播放暂停 */
const SIDE_ZONE = 0.3
/** 小窗里「单击即播放/暂停」的中间区域：左右各三分之一留给唤出控制栏 */
const CENTER_ZONE = 1 / 3

export interface VideoGesturesDeps {
  media: VideoMediaState
  controls: VideoUiControls
  autoTune: VideoAutoTune
}

type HudKind = 'seek' | 'volume' | 'light'
type DragMode = null | 'seek' | 'volume' | 'light'

export function useVideoGestures(deps: VideoGesturesDeps) {
  const { media, controls, autoTune } = deps
  // isLocked 在裸状态里（快捷键那边也要读它，见 useVideoMediaState 的注释）
  const { videoEl, duration, volume, isMuted, showControls, isPlaying, isFullscreen, isLocked } = media

  /** 锁定态下唯一还认的交互：点一下让解锁按钮露 3 秒 */
  const showLockBtn = ref(false)
  /** 画面亮度（纯前端 CSS filter，改不了背光，但暗环境下够用） */
  const brightness = ref(1)
  /** 中央 HUD：拖拽过程中的实时读数 */
  const gestureHud = ref<{ kind: HudKind; text: string; percent?: number; delta?: string } | null>(null)
  /** 双击 ±5s 的左右水波纹反馈（key 自增以重放动画；secs 连点累加，见 flashSide） */
  const seekFlash = ref<{ side: 'left' | 'right'; key: number; secs: number } | null>(null)

  let lockBtnTimer: ReturnType<typeof setTimeout> | null = null
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let singleTapTimer: ReturnType<typeof setTimeout> | null = null
  let seekFlashTimer: ReturnType<typeof setTimeout> | null = null
  let flashSeq = 0

  // 一次指针交互的临时量
  let startX = 0
  let startY = 0
  let startAt = 0
  let startTime = 0      // 按下那一刻的播放位置
  let startVolume = 1
  let startBright = 1
  let dragMode: DragMode = null
  let seekTarget = 0
  let boosting = false
  let lastTapAt = 0
  let lastTapX = 0
  let activePointer: number | null = null
  let pointerKind = 'mouse'
  let lastTouchAt = 0    // 最近一次触摸的时刻，用来滤掉浏览器补发的兼容鼠标事件
  let tapWasShown = false  // 按下那一刻控制栏是不是开着（单击的目标态由它定，见 onTap）
  let tapX = 0.5           // 这一下点在横向哪个位置（0~1）；单击要等双击窗口过完才执行，得先存下来
  let lastDragEndAt = 0    // 拖动结束时刻：拖完浏览器还会补一个 click，那一下不能当播放/暂停

  const clearTimers = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  }

  const vibrate = (ms: number) => {
    try { navigator.vibrate?.(ms) } catch { /* iOS 没有，忽略 */ }
  }

  /**
   * 水波纹反馈。同一侧连着双击会**累加读数**（5s → 10s → 15s…）：
   * 连点时用户想的是「一直往前」，每次都从 5s 重新数会让人不确定到底跳了几次。
   * 累加窗口就是水波纹自己的存活时间——纹还在就算连着。
   */
  const flashSide = (side: 'left' | 'right') => {
    const cur = seekFlash.value
    const secs = cur?.side === side ? cur.secs + DOUBLE_TAP_SEEK : DOUBLE_TAP_SEEK
    seekFlash.value = { side, key: ++flashSeq, secs }
    if (seekFlashTimer) clearTimeout(seekFlashTimer)
    seekFlashTimer = setTimeout(() => { seekFlash.value = null }, 800)
  }

  const revealLockBtn = () => {
    showLockBtn.value = true
    if (lockBtnTimer) clearTimeout(lockBtnTimer)
    lockBtnTimer = setTimeout(() => { showLockBtn.value = false }, 3000)
  }

  const toggleLock = () => {
    isLocked.value = !isLocked.value
    if (isLocked.value) {
      showControls.value = false
      autoTune.setBoost(false)
    }
    revealLockBtn()
  }

  /**
   * 单击：只管控制栏显隐，不碰播放状态。
   *
   * 目标态取「按下那一刻」的相反值，而不是定时器烧到时的取反——中间隔着 280ms 的双击窗口，
   * 触摸端浏览器会在这段里补发一套兼容鼠标事件，`mousemove` 先把控制栏顶成显示，
   * 再取反就成了「弹出来 0.3 秒又收回去」（踩过，一开始误以为是自动收起时间太短）。
   */
  const applyTapControls = () => {
    showControls.value = !tapWasShown
    if (showControls.value) controls.hideControlsDelayed()
  }

  /**
   * 容器上的 mousemove 入口：触摸抬手后浏览器补发的那套鼠标事件与真实鼠标长得一模一样，
   * 只能按「刚刚有过触摸」来滤。不滤的话触摸端根本关不掉控制栏。
   */
  const onMouseMove = () => {
    if (performance.now() - lastTouchAt < 900) return
    if (isLocked.value) return
    controls.handleMouseMove()
  }

  const fmtDelta = (sec: number) => `${sec >= 0 ? '+' : '-'}${Math.abs(Math.round(sec))}s`

  // ── 指针事件 ──

  /**
   * 控制栏、按钮这些自己有交互的区域不参与手势判定。
   *
   * 除了显式的 `data-no-gesture`，**原生可交互元素一律放过**：漏挂一处标记的代价特别难看——
   * 点在按钮上却被手势层当成画面双击，直接把人拽进全屏（实测用户报「点上下集就全屏了」）。
   * 与其指望每个新控件都记得加标记，不如在这里兜住。
   */
  const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [data-no-gesture]'
  const fromControls = (e: PointerEvent) =>
    !!(e.target as HTMLElement | null)?.closest?.(INTERACTIVE)

  const rectOf = (e: PointerEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect()

  const onPointerDown = (e: PointerEvent) => {
    if (fromControls(e)) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (isLocked.value) { revealLockBtn(); return }
    // 这一下就是「用户激活」：自动全屏被浏览器拒过的话趁现在补上（安卓上必然走这条路）。
    // **鼠标不参与**：桌面单击 = 播放/暂停，顺手把人拽进全屏是纯粹的惊吓（Windows 上踩到）。
    // 这里能拿到 pointerType，比查 media query 更准
    if (e.pointerType !== 'mouse') controls.consumeAutoFullscreen()
    controls.restoreSound()   // 静音兜底起播过的话，这一下把声音还回来

    activePointer = e.pointerId
    pointerKind = e.pointerType
    if (e.pointerType !== 'mouse') lastTouchAt = performance.now()
    tapWasShown = showControls.value
    const rect = rectOf(e)
    startX = e.clientX
    startY = e.clientY
    startAt = performance.now()
    startTime = videoEl.value?.currentTime ?? 0
    startVolume = volume.value
    startBright = brightness.value
    dragMode = null
    boosting = false

    // 包 try：这一对在指针已经没了的时候会抛 NotFoundError（合成事件、指针被系统收走、
    // 多点触控里那根手指先离开…）。抛出去会把整个 pointerdown 处理中断，后面的手势判定全不执行——
    // 表现是「画面点了没反应」，而捕获本身只是锦上添花（丢了顶多是滑出元素后不再跟手）
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch {}

    // 长按右半屏 → 临时加速。左半屏留空：那里是「按住不动想看清画面」的常见位置，
    // 两边都加速会让人分不清自己触发了什么
    const onRight = (e.clientX - rect.left) / rect.width > 0.5
    clearTimers()
    if (onRight) {
      longPressTimer = setTimeout(() => {
        if (dragMode) return
        boosting = true
        autoTune.setBoost(true)
        vibrate(15)
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return
    const rect = rectOf(e)
    const dx = e.clientX - startX
    const dy = e.clientY - startY

    if (!dragMode) {
      if (boosting) return                                   // 加速中不再改判成拖拽
      if (Math.abs(dx) < MOVE_SLOP && Math.abs(dy) < MOVE_SLOP) return
      clearTimers()
      if (Math.abs(dx) > Math.abs(dy)) dragMode = 'seek'
      // 竖滑只在全屏里开：非全屏时页面还要能上下滚，抢走垂直方向等于把播放器变成滚动黑洞
      else if (isFullscreen.value) dragMode = (e.clientX - rect.left) / rect.width > 0.5 ? 'volume' : 'light'
      else return
    }

    if (dragMode === 'seek') {
      if (!duration.value) return
      const span = Math.min(duration.value, SEEK_SPAN_MAX)
      const delta = (dx / rect.width) * span
      seekTarget = Math.max(0, Math.min(duration.value, startTime + delta))
      gestureHud.value = {
        kind: 'seek',
        text: `${formatTime(seekTarget)} / ${formatTime(duration.value)}`,
        delta: fmtDelta(seekTarget - startTime),
        percent: duration.value ? (seekTarget / duration.value) * 100 : 0,
      }
      return
    }

    // 竖滑：向上为增。用容器高度的 70% 走完 0→100%，全程拖到底又太钝
    const ratio = -dy / (rect.height * 0.7)
    if (dragMode === 'volume') {
      const v = Math.max(0, Math.min(1, startVolume + ratio))
      volume.value = v
      if (videoEl.value) {
        videoEl.value.volume = v
        // 拖音量时还静着音只会让人以为坏了
        if (v > 0 && isMuted.value) { isMuted.value = false; videoEl.value.muted = false }
      }
      gestureHud.value = { kind: 'volume', text: `${Math.round(v * 100)}%`, percent: v * 100 }
    } else {
      const b = Math.max(0.25, Math.min(1.6, startBright + ratio))
      brightness.value = b
      // 0.25~1.6 映射成 0~100% 的读数，用户看的是相对亮度不是滤镜系数
      gestureHud.value = { kind: 'light', text: `${Math.round((b - 0.25) / 1.35 * 100)}%`, percent: (b - 0.25) / 1.35 * 100 }
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (activePointer !== e.pointerId) return
    activePointer = null
    clearTimers()
    if (e.pointerType !== 'mouse') lastTouchAt = performance.now()
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId) } catch {}

    if (boosting) {                       // 长按结束：只收加速，不算点击
      boosting = false
      autoTune.setBoost(false)
      return
    }
    if (dragMode) {
      if (dragMode === 'seek' && videoEl.value && duration.value) videoEl.value.currentTime = seekTarget
      lastDragEndAt = performance.now()
      dragMode = null
      gestureHud.value = null
      return
    }
    // 按了很久又没动也没触发加速（比如在左半屏），不当点击处理
    if (performance.now() - startAt > 700) return
    // 鼠标交给原生 click/dblclick：自己用 pointerdown/up 拼「单击」在桌面上不可靠
    //（指针捕获、拖动阈值、双击窗口三者叠一起，实测点了不暂停），
    // 而浏览器自带的 click/dblclick 语义正好就是桌面播放器要的那套
    if (e.pointerType === 'mouse') return

    onTap(e, rectOf(e))
  }

  const onPointerCancel = () => {
    activePointer = null
    clearTimers()
    if (boosting) { boosting = false; autoTune.setBoost(false) }
    dragMode = null
    gestureHud.value = null
  }

  /** 触摸专用的点击判定（鼠标走原生 click/dblclick，见下） */
  const onTap = (e: PointerEvent, rect: DOMRect) => {
    const now = performance.now()
    const x = (e.clientX - rect.left) / rect.width
    tapX = x
    const isDouble = now - lastTapAt < DOUBLE_TAP_MS && Math.abs(e.clientX - lastTapX) < 60
    lastTapAt = isDouble ? 0 : now      // 三连击不该被当成「第二次双击」
    lastTapX = e.clientX

    if (isDouble) {
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null }
      if (x < SIDE_ZONE) { controls.skip(-DOUBLE_TAP_SEEK); flashSide('left'); vibrate(10) }
      else if (x > 1 - SIDE_ZONE) { controls.skip(DOUBLE_TAP_SEEK); flashSide('right'); vibrate(10) }
      else controls.togglePlay()
      return
    }

    // 单击要等双击窗口过完才能确定，否则双击会先闪一下控制栏/先暂停再全屏
    if (singleTapTimer) clearTimeout(singleTapTimer)
    singleTapTimer = setTimeout(() => {
      singleTapTimer = null
      // 小窗（非全屏）：中间三分之一单击 = 播放/暂停，并顺手唤出控制栏
      //（一个动作两件事，不用先点一下出控制栏再去够播放键）；左右三分之一只唤控制栏。
      // 「单击只显控制栏」那条规矩是给全屏看片准备的——那时误触暂停最烦人，而且有双击中间可用。
      if (!isFullscreen.value && tapX > CENTER_ZONE && tapX < 1 - CENTER_ZONE) {
        controls.togglePlay()
        controls.keepControlsAlive()
      } else {
        applyTapControls()
      }
    }, DOUBLE_TAP_MS)
  }

  // ── 鼠标：原生 click / dblclick ──
  // 桌面播放器的规矩就两条：单击播放/暂停、双击全屏（不分区）。
  // 单击要延后一个双击窗口再执行，否则双击会「先暂停一下再全屏」。
  let clickTimer: ReturnType<typeof setTimeout> | null = null

  /** 这一发鼠标事件该不该管：控制栏内、触摸补发的合成事件、刚拖过进度 —— 都不管 */
  const mouseIgnored = (e: MouseEvent) =>
    !!(e.target as HTMLElement | null)?.closest?.(INTERACTIVE)
    || performance.now() - lastTouchAt < 900
    || isLocked.value
    || performance.now() - lastDragEndAt < 300

  const onClick = (e: MouseEvent) => {
    if (mouseIgnored(e) || e.detail > 1) return   // detail>1 是双击的第二下
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => { clickTimer = null; controls.togglePlay() }, DOUBLE_TAP_MS)
  }

  const onDblClick = (e: MouseEvent) => {
    if (mouseIgnored(e)) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }   // 撤销这一对里的单击
    void controls.toggleFullscreen()
  }

  /**
   * 触摸行为：非全屏时放行竖向滚动（页面还要能翻），全屏时整块吃掉。
   * 不设 `none` 的话浏览器会把横滑也当成滚动的起手式，pointermove 直接被 pointercancel 掐断。
   */
  const touchAction = computed(() => (isFullscreen.value ? 'none' : 'pan-y'))

  /**
   * 控制栏可见 = 用户唤出过 && 没锁定。
   *
   * 原来还带一条「暂停时常显」：可暂停态本来就有中央大播放键，再叠上顶部信息条和整条控制栏，
   * 起播前画面上三样东西一起挤（手机上尤其明显）。现在暂停只出中央键，想要控制栏点一下就有。
   */
  const controlsVisible = computed(() => !isLocked.value && showControls.value)

  const disposeGestures = () => {
    clearTimers()
    if (clickTimer) clearTimeout(clickTimer)
    if (singleTapTimer) clearTimeout(singleTapTimer)
    if (seekFlashTimer) clearTimeout(seekFlashTimer)
    if (lockBtnTimer) clearTimeout(lockBtnTimer)
    autoTune.setBoost(false)
  }

  // isLocked 来自 media，controller 已经平铺过一份，这里不再重复导出（键名会撞）
  return {
    showLockBtn, toggleLock, revealLockBtn,
    brightness, gestureHud, seekFlash, touchAction, controlsVisible,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseMove, onClick, onDblClick,
    disposeGestures,
  }
}

export type VideoGestures = ReturnType<typeof useVideoGestures>
