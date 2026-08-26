/**
 * 画面右键菜单 + 媒体信息面板。
 *
 * 为什么不并进 useVideoGestures：那边判定的是「一次左键/触摸交互到底算什么」（单击/双击/
 * 长按/拖拽四选一，带一堆定时器和临时量）；右键是**按下即成立**的动作，跟那套判定没有共享状态，
 * 混进去只会把那份本来就难读的判定再搅浑一层。
 *
 * 菜单和面板都挂在 `playerContainer` **内部**、坐标用容器相对值：容器就是全屏元素，
 * 挂到 body 上的话全屏时整个菜单在全屏层下面，一个像素都看不见。
 */
import type { VideoMediaState } from './useVideoMediaState'

/**
 * 菜单的估算尺寸，只用于「贴边时朝反方向展开」。
 * 不去等真实尺寸（`nextTick` 后量 offsetWidth）：那要晚一帧翻转，肉眼能看见菜单先冒出去再跳回来。
 */
const MENU_W = 224
const MENU_H = 248

export interface VideoContextMenuDeps {
  media: VideoMediaState
  /**
   * 取 hls.js 实例。编码、帧率、声明码率、一共几档只有它知道，
   * `hlsStats` 那份是给徽标用的字符串，抠不出这些字段。整片 MP4 一律拿不到（没有清单这回事）。
   */
  getHls: () => any
}

export function useVideoContextMenu(deps: VideoContextMenuDeps) {
  const { media, getHls } = deps
  const {
    videoEl, playerContainer, isLocked, isHls, videoUrl, hlsStats,
    decodedRes, duration, currentTime, playbackRate, desiredRate,
  } = media

  /** 菜单位置（容器相对坐标）。null = 没开 */
  const ctxMenuAt = ref<{ x: number; y: number } | null>(null)
  const showMediaInfo = ref(false)
  /** 复制地址的回执。**失败也要说话**：不安全上下文里 clipboard 压根不存在，静默失败会被当成「点了没反应」 */
  const copyState = ref<'' | 'ok' | 'fail'>('')

  const closeContextMenu = () => { ctxMenuAt.value = null }

  const openContextMenu = (e: MouseEvent) => {
    // 一律吃掉原生菜单：留着它会直接盖在自己这份上面（Windows 上尤其明显）
    e.preventDefault()
    // 锁定态下画面上只该有解锁键那一个出口，菜单会把它盖掉
    if (isLocked.value) return
    const box = playerContainer.value
    if (!box) return
    const r = box.getBoundingClientRect()
    ctxMenuAt.value = {
      x: Math.max(4, Math.min(e.clientX - r.left, r.width - MENU_W - 4)),
      y: Math.max(4, Math.min(e.clientY - r.top, r.height - MENU_H - 4)),
    }
  }

  /**
   * 关菜单的几条出路。**只在菜单开着时挂监听**：常挂的话页面上每一次点击、每一次滚动
   * 都要白跑一遍这几个回调。
   *
   * `pointerdown` 走**捕获阶段**，否则菜单项里 `@click.stop` 之类会把事件截在半路，
   * 点了菜单外面反而关不掉。
   */
  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null
    if (t?.closest?.('[data-ctx-menu]')) return   // 点在菜单/面板里：交给按钮自己处理
    // 右键落在画面上 = 想换个位置再弹一次，这一下由 openContextMenu 重设坐标，别在这里先关掉
    //（关掉再开会让菜单闪一下；而 Chrome/Windows 上 contextmenu 是在 pointerdown **之后**才派发的）
    if (e.button === 2 && playerContainer.value?.contains(t as Node)) return
    closeContextMenu()
  }
  const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }

  watch(ctxMenuAt, open => {
    const fn = open ? 'addEventListener' : 'removeEventListener'
    document[fn]('pointerdown', onDocPointerDown as EventListener, true)
    document[fn]('keydown', onDocKey as EventListener)
    document[fn]('fullscreenchange', closeContextMenu)
    // 捕获阶段才收得到内层滚动容器（选集抽屉）的滚动
    window[fn]('scroll', closeContextMenu, true)
  })

  /**
   * 媒体信息快照。
   *
   * `videoWidth`/`videoHeight`/`readyState` 都**不是响应式的**，所以把引擎心跳每秒重算的
   * `hlsStats` 拿来当依赖——面板开着时读数就跟着秒更，不用自己再养一个定时器。
   */
  const mediaInfo = computed(() => {
    const v = videoEl.value
    void hlsStats.value      // 心跳依赖：让下面这些非响应式读数跟着每秒刷新
    void decodedRes.value    // 切档/切集时也要立刻跟上，不等下一拍心跳
    const hls = getHls()
    const levels = hls?.levels ?? []
    // 档位索引与 updateHlsStats 同一套三级兜底：currentLevel 只在切过档后才有效，
    // 刚起播时两个都是 -1，直接取 [0] 才不会整块空着
    const li = hls ? (hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel >= 0 ? hls.loadLevel : 0) : -1
    const lv = li >= 0 ? levels[li] : undefined
    return {
      /*
       * 解码实测 = 「当前这一帧」的真实像素，会随播放位置变，这不是 bug：
       * 实测有源站在正片前面拼了一段贴片（`#EXT-X-DISCONTINUITY` 隔开），
       * 贴片 1920×1080@30、正片 1920×808@25，两段编码压根不是一个。
       * 清单声明的那档（declared）只说得清「站点标的是什么」。
       */
      pixels: v?.videoWidth && v?.videoHeight ? `${v.videoWidth} × ${v.videoHeight}` : '',
      declared: isHls.value ? (hlsStats.value?.level ?? '') : '',
      levelCount: levels.length,
      videoCodec: lv?.videoCodec || '',
      audioCodec: lv?.audioCodec || '',
      // FRAME-RATE 是可选属性，很多清单压根不写
      fps: Number(lv?.attrs?.['FRAME-RATE']) || 0,
      bitrateMbps: lv?.bitrate ? (lv.bitrate / 1e6).toFixed(2) : '',
      duration: duration.value,
      currentTime: currentTime.value,
      dropped: hlsStats.value?.dropped ?? 0,
      totalFrames: hlsStats.value?.total ?? 0,
      buffered: hlsStats.value?.buffered ?? 0,
      readyState: v?.readyState ?? 0,
      rate: playbackRate.value,
      desiredRate: desiredRate.value,
      url: videoUrl.value,
    }
  })

  const copyVideoUrl = async () => {
    if (!videoUrl.value) return
    try {
      // 局域网 http 打开时 navigator.clipboard 是 undefined（非安全上下文），
      // 这里的 catch 就是为它准备的——报出去比抛一句「Cannot read properties of undefined」有用
      await navigator.clipboard.writeText(videoUrl.value)
      copyState.value = 'ok'
    } catch {
      copyState.value = 'fail'
    }
    setTimeout(() => { copyState.value = '' }, 1800)
  }

  const disposeContextMenu = () => {
    document.removeEventListener('pointerdown', onDocPointerDown as EventListener, true)
    document.removeEventListener('keydown', onDocKey as EventListener)
    document.removeEventListener('fullscreenchange', closeContextMenu)
    window.removeEventListener('scroll', closeContextMenu, true)
  }

  return {
    ctxMenuAt, showMediaInfo, mediaInfo, copyState,
    openContextMenu, closeContextMenu, copyVideoUrl, disposeContextMenu,
  }
}

export type VideoContextMenu = ReturnType<typeof useVideoContextMenu>
