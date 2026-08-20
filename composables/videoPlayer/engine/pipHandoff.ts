/**
 * 切集时保住画中画小窗（不需要用户激活）。
 *
 * 换流一定要给 `<video>` 换一次 src（hls.js 的 attachMedia 挂新 MediaSource 的 blob；MP4 直接改 src），
 * 而 Chrome 的小窗绑的是换掉之前那个播放器 → 小窗停在上一集最后一帧再也不更新。
 * 同一个元素**没法**脚本重新绑（`requestPictureInPicture()` 对已在画中画的元素直接原样返回），
 * 所以只能「退出 + 重新申请」。
 *
 * 难点全在**申请要用户激活**这一条上：
 * · 先 `exit()` 再 `request()` 的写法，只有在最近一次点击的激活窗口里才成（Chrome 约 5 秒），
 *   **播完自动切下一集压根没有点击** → 小窗被关掉再也开不回来（踩过，就是这一版的表现）。
 * · 规范里那条豁免是：`document.pictureInPictureElement` **非空**时申请不要求用户激活
 *   （Chrome 74+）。所以只要全程让小窗「有主」，整套动作一次激活都不用。
 *
 * 于是做成两段接力：
 *   ① 换流**之前**（小窗还归旧流）→ 把它交给一个占位 `<video>`（canvas 抓流，画一句「正在切换…」）
 *   ② 新流 `loadedmetadata` → 从占位手上要回来 → 占位停掉
 * 中间小窗一直是开着的，用户看到的是「切换提示 → 新一集」，而不是「窗口没了」。
 *
 * 接力必须在**拆掉旧流之前**发起：我们那句 `removeAttribute('src') + load()` 一执行，
 * Chrome 就把 `pictureInPictureElement` 清空了（小窗还开着但已经没主），豁免随之消失。
 */

/**
 * 占位画面高度：只是给小窗一帧字，不需要清晰。宽度按锁定比例算（见 lockedAspect）。
 */
const HOLDER_HEIGHT = 270
/**
 * 小窗对象（`width`/`height` 是**小窗自己的**尺寸，且随用户拖动实时更新）。
 *
 * **必须是它，不能拿 `videoWidth/videoHeight` 顶替**：那两个是视频的固有尺寸，
 * 窗口被拖过或比例已经飘了之后，两者就不是一回事了。
 * 只能在**进入那一刻**从事件上拿——DOM 里没有 `document.pictureInPictureWindow` 这种事后补读的东西。
 */
let pipWin: PictureInPictureWindow | null = null
const onEnterPiP = (e: Event) => { pipWin = (e as any).pictureInPictureWindow ?? null }

/**
 * 开始跟踪小窗对象。**挂在 `document` 的捕获阶段**，两个原因：
 * `enterpictureinpicture` 不冒泡，而 `<video>` 会被 `videoKey++` 整个换掉（挂元素上一换集就丢）；
 * 而且用户可能用**浏览器原生控件**进小窗，那条路压根不走我们的 `togglePiP`。
 */
export function startPiPTracking(): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('enterpictureinpicture', onEnterPiP, true)
  return () => document.removeEventListener('enterpictureinpicture', onEnterPiP, true)
}

/**
 * 此刻该按哪个比例画占位。
 *
 * **默认跟着小窗，不能写死 16:9**（踩过）：小窗比例跟着当前在画中画里的那个元素走，
 * 而切集接力会把占位塞进去。放一部 2.40:1 的片子（实测 1920×800）时，写死 16:9 就等于
 * 每切一集都拿一个错比例去顶一次窗口。拿不到小窗才退回视频固有尺寸，最后才是 16:9。
 */
const currentAspect = (): number => {
  if (pipWin?.width && pipWin?.height) return pipWin.width / pipWin.height
  const el = document.pictureInPictureElement as HTMLVideoElement | null
  if (el?.videoWidth && el?.videoHeight) return el.videoWidth / el.videoHeight
  return 16 / 9
}

/** 占位画布尺寸。宽度取偶数：奇数宽在部分抓流实现上会被悄悄补一列 */
const holderSize = (aspect: number) => ({
  w: Math.round(HOLDER_HEIGHT * aspect / 2) * 2,
  h: HOLDER_HEIGHT,
})
/** 占位画面重绘间隔：captureStream 只在有新帧时推流，静止画面会被小窗认成卡住 */
const REPAINT_MS = 500
/** 拿到占位元素的第一帧最多等这么久——它落在切集的关键路径上，宁可放弃接力也不能拖住换流 */
const READY_TIMEOUT_MS = 600
/**
 * 占位最多握这么久就自己撒手。没有它的话，新一集永远到不了 `loadedmetadata`（源站挂了、
 * 地址过期、就是播不了）时小窗会永远停在「正在切换…」——那比关掉更像是坏了。
 */
const HOLD_MAX_MS = 30_000

let holder: HTMLVideoElement | null = null
let repaintTimer: ReturnType<typeof setInterval> | null = null
let holdWatchdog: ReturnType<typeof setTimeout> | null = null

const stopHolder = () => {
  if (repaintTimer) { clearInterval(repaintTimer); repaintTimer = null }
  if (holdWatchdog) { clearTimeout(holdWatchdog); holdWatchdog = null }
  if (!holder) return
  const stream = holder.srcObject as MediaStream | null
  stream?.getTracks().forEach(t => t.stop())
  holder.srcObject = null
  holder.remove()
  holder = null
}

const paint = (ctx: CanvasRenderingContext2D, text: string, w: number, h: number) => {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#fff'
  ctx.font = '24px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2)
}

/**
 * 把小窗交给占位元素。返回是否接住了——没接住的话调用方就别再指望 `reclaimPiP` 了。
 * 必须在拆掉旧流之前调。
 *
 * `aspect` 只有比例重同步那条路（`resyncPiPAspect`）会传：那时是**故意**要把窗口挪到新比例上。
 * 切集走默认值 = 跟着小窗当前比例，不去碰它。
 */
export async function holdPiP(text = '正在切换…', aspect = 0): Promise<boolean> {
  if (!document.pictureInPictureEnabled || !document.pictureInPictureElement) return false
  stopHolder()   // 上一次没收干净的残留（切集连着来）

  const { w, h } = holderSize(aspect || currentAspect())
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx || !canvas.captureStream) return false
  paint(ctx, text, w, h)

  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  // 不能 display:none（那样浏览器不给它解码器），挪出视口 + 1px 就够
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  holder = el
  el.srcObject = canvas.captureStream(2)
  repaintTimer = setInterval(() => paint(ctx, text, w, h), REPAINT_MS)

  try {
    await el.play()   // 纯视频轨、静音，不需要用户激活
    // readyState 还是 HAVE_NOTHING 时申请画中画会被判 InvalidStateError，得等第一帧
    if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('占位元素首帧超时')), READY_TIMEOUT_MS)
        el.addEventListener('loadeddata', () => { clearTimeout(t); resolve() }, { once: true })
      })
    }
    await el.requestPictureInPicture()
    console.log('[pip] 小窗已交给占位画面，等新一集接手')
    holdWatchdog = setTimeout(() => {
      console.log('[pip] 等了 30s 没人接手，占位撒手（这一集多半压根没起来）')
      stopHolder()
    }, HOLD_MAX_MS)
    return true
  } catch (e) {
    console.log('[pip] 交接给占位画面失败，切集后小窗可能关掉:', e)
    stopHolder()
    return false
  }
}

/**
 * 把小窗从占位元素手里要回来给真正的 `<video>`。
 * 成功与否都会把占位收干净——留着它只会占一条 canvas 抓流。
 */
export async function reclaimPiP(el: HTMLVideoElement): Promise<boolean> {
  try {
    // 占位还在画中画里 → 这一发申请免用户激活（规范那条豁免）。
    // 注意不能先 exit：一 exit 豁免就没了，而这条路径上通常没有任何点击可用。
    await el.requestPictureInPicture()
    console.log('[pip] 新一集已接手小窗')
    return true
  } catch (e) {
    console.log('[pip] 新一集接手小窗失败:', e)
    return false
  } finally {
    stopHolder()
  }
}

/** 放弃接力（加载失败 / 组件卸载 / 用户自己关了小窗） */
export function releasePiPHolder() {
  stopHolder()
}

/** 比例差到这个程度才动手。浮点比较要留余量，1.778 和 1.7777… 不该算不同 */
const ASPECT_TOLERANCE = 0.02
/** 两次重同步的最小间隔：比例来回抖时别连着重开窗口（每次都要闪一下黑） */
const RESYNC_COOLDOWN_MS = 3000
let resyncing = false
let lastResyncAt = 0

/**
 * ── 视频固有比例变了 → 把小窗尺寸也跟过去 ──
 *
 * **实测（现场日志）：Chrome 只会自己把小窗变大，不会自己变小。**
 * 一部 2.40:1 的片子（1920×800）里 ABR 切到一档 16:9 的（1920×1080）时，小窗当场从
 * 384×160 长成 384×216（宽度不动、只长高）；等比例切回 2.40:1，**小窗就赖在 384×216 不动了**，
 * 画面被塞在一个更高的窗口里。用户看到的就是「自动扩大之后再也不缩回去」。
 *
 * 标准 PiP API **没有任何尺寸/比例参数**，唯一能让浏览器重算窗口尺寸的动作是「重进一次」。
 * 而**绝不能真的 `exitPictureInPicture()`**：一 exit，`document.pictureInPictureElement`
 * 变 null，「非空时申请免用户激活」那条豁免就没了，而比例变化是自动发生的、手上没有任何点击
 * → 重进必被 `NotAllowedError` 拒掉，小窗直接关了再也开不回来。
 *
 * 所以走**两跳**（复用切集那套接力）：占位进小窗 → 真视频要回来。全程小窗「有主」，
 * 一次激活都不用。实测两跳之后窗口确实按新比例重开了（缩小方向也生效）。
 *
 * 占位画的是**新比例**（而不是跟随当前小窗）——这条路上我们是故意要挪动窗口的。
 */
export async function resyncPiPAspect(el: HTMLVideoElement): Promise<boolean> {
  if (document.pictureInPictureElement !== el || !pipWin) return false
  if (!el.videoWidth || !el.videoHeight) return false
  const want = el.videoWidth / el.videoHeight
  const now = pipWin.width / pipWin.height
  if (Math.abs(now - want) < ASPECT_TOLERANCE) return false
  if (resyncing || Date.now() - lastResyncAt < RESYNC_COOLDOWN_MS) return false
  resyncing = true
  lastResyncAt = Date.now()
  console.log(`[pip] 比例变了（小窗 ${now.toFixed(3)} → 视频 ${want.toFixed(3)}），重开小窗`)
  try {
    // 占位画面不写字：这不是切集，用户只是看着看着比例变了，弹一句「正在切换…」纯属误导
    if (!await holdPiP('', want)) return false
    return await reclaimPiP(el)
  } finally {
    resyncing = false
  }
}

/** 小窗此刻是不是握在占位元素手上 */
export function isPiPHeld(): boolean {
  return !!holder && document.pictureInPictureElement === holder
}
