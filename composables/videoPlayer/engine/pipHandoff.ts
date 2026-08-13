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

/** 占位画面尺寸：只是给小窗一帧字，不需要清晰 */
const W = 480
const H = 270
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

const paint = (ctx: CanvasRenderingContext2D, text: string) => {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#fff'
  ctx.font = '24px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, W / 2, H / 2)
}

/**
 * 把小窗交给占位元素。返回是否接住了——没接住的话调用方就别再指望 `reclaimPiP` 了。
 * 必须在拆掉旧流之前调。
 */
export async function holdPiP(text = '正在切换…'): Promise<boolean> {
  if (!document.pictureInPictureEnabled || !document.pictureInPictureElement) return false
  stopHolder()   // 上一次没收干净的残留（切集连着来）

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx || !canvas.captureStream) return false
  paint(ctx, text)

  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  // 不能 display:none（那样浏览器不给它解码器），挪出视口 + 1px 就够
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  holder = el
  el.srcObject = canvas.captureStream(2)
  repaintTimer = setInterval(() => paint(ctx, text), REPAINT_MS)

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

/** 小窗此刻是不是握在占位元素手上 */
export function isPiPHeld(): boolean {
  return !!holder && document.pictureInPictureElement === holder
}
