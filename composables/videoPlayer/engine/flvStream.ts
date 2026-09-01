/**
 * FLV 播放（直播拉流为主）。**只求「能播」**：不做预取、不做卡顿自愈、不做进度记忆——
 * 那一整套是照 HLS 分片写的，直播流上压根没有分片表可算。
 *
 * 为什么不能像整片 MP4 那样直接 `<video src>`：浏览器一律不认 FLV 容器，必须自己
 * 解复用成 fMP4 再喂 MSE（`mpegts.js`，即 flv.js 的维护分支）。而走了 MSE 就意味着
 * 数据是我们自己 fetch 的 → **跨源必须有 CORS 头**，直播 CDN 基本一个都不给
 * → 一律经 `/api/proxy` 转成同源响应（它对二进制是流式透传，直播流不会被攒在内存里）。
 *
 * `import` 必须是**字面量 specifier 且不加 `@vite-ignore`**（同 mux.js 那条）：
 * 它是 CJS 包，要靠 Vite 预打包成 ESM，写成变量会让这行原样留到运行时、浏览器解析裸包名失败。
 */
import type Mpegts from 'mpegts.js'

let lib: typeof Mpegts | null = null

export interface FlvHandle {
  destroy: () => void
}

/**
 * 「这条 FLV 是直播还是点播」。
 *
 * 判错的代价是不对称的：把直播判成点播只是多算一次（不存在的）时长；反过来把点播判成直播
 * 会让进度条彻底不能拖。所以只在拿到明显的直播特征时才判直播——签名 + 时效参数
 * （直播拉流地址一律带，抖音那条是 `expire=…&sign=…`）或路径里的 `pull` / `live`。
 */
function looksLive(url: string): boolean {
  const cut = url.search(/[?#]/)
  const rest = cut === -1 ? '' : url.slice(cut)
  if (/[?&]expire=/i.test(rest) && /[?&]sign=/i.test(rest)) return true
  return /\/(pull|live)[-/.]/i.test(url) || /\bpull-[a-z]*flv\b/i.test(url)
}

/** 断流重连：最多几次、隔多久。直播地址带时效签名，试不通就是真不通，别无限重来 */
const MAX_RETRY = 5
const RETRY_DELAY_MS = 1000
/** 已经稳稳播了这么久，就把重连额度还回去（同「每一个失败额度都必须是连续失败」那条） */
const RETRY_RESET_MS = 20000

/**
 * 起播一条 FLV 流。`fetchUrl` 是**已经拼好代理的**最终地址（调用方负责，见 useVideoEngine）。
 *
 * **断流必须自己重连**：直播长连接抖一下就是 `UnrecoverableEarlyEof`（实测这条抖音源播 17s
 * 就报一次，而同一地址用 curl 拉 45s 一直有数据 —— 也就是说上游没断，是这条连接断的）。
 * mpegts.js 自己不重连，只报错就完 → 表现是「播二十几秒画面停住 + 一句播放失败」。
 * 重连就是**整个实例重建**（`unload/load` 在直播上会卡在旧时间线上），直播天然从直播边缘接上。
 *
 * `onFatal` 只在额度用完后调一次。
 */
export async function createFlvStream(
  el: HTMLVideoElement,
  fetchUrl: string,
  srcUrl: string,
  onFatal: (msg: string) => void,
): Promise<FlvHandle> {
  if (!lib) lib = (await import('mpegts.js')).default
  const mpegts = lib

  if (!mpegts.getFeatureList().mseLivePlayback) {
    throw new Error('当前浏览器不支持 MSE，无法播放 FLV')
  }

  const isLive = looksLive(srcUrl)
  let player: Mpegts.Player | null = null
  let disposed = false
  let retry = 0
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const start = () => {
    if (disposed) return
    startedAt = performance.now()
    const p = mpegts.createPlayer(
      { type: 'flv', url: fetchUrl, isLive, cors: true },
      {
        // 直播只求低延迟：不攒 stash、缓冲堆太多就追一次进度（点播那条留默认，靠浏览器自己节流）
        enableStashBuffer: !isLive,
        liveBufferLatencyChasing: isLive,
        lazyLoad: !isLive,
      },
    )
    player = p

    p.on(mpegts.Events.ERROR, (type: string, detail: string) => {
      if (disposed || player !== p) return
      console.error('[flv] 错误:', type, detail)
      // 播够久了说明这次不是「起播就不通」，额度还回去
      if (performance.now() - startedAt > RETRY_RESET_MS) retry = 0
      if (type !== mpegts.ErrorTypes.NETWORK_ERROR && type !== mpegts.ErrorTypes.MEDIA_ERROR) {
        onFatal(`FLV 播放失败: ${type}${detail ? ' / ' + detail : ''}`)
        return
      }
      if (retry >= MAX_RETRY) {
        onFatal(`FLV 断流且重连 ${MAX_RETRY} 次未成功（${detail || type}）`)
        return
      }
      retry++
      console.log(`[flv] 断流，${RETRY_DELAY_MS}ms 后重连（第 ${retry}/${MAX_RETRY} 次）`)
      try { p.destroy() } catch {}
      if (player === p) player = null
      timer = setTimeout(start, RETRY_DELAY_MS)
    })

    p.attachMediaElement(el)
    p.load()
    // 重连那几发要自己续上播：上一发的 error 已经让 <video> 停住了，
    // 而这时候手上没有用户点击（自动重连），只能靠「已经播过」这个既有授权
    if (retry > 0) void el.play().catch(() => {})
  }

  start()
  console.log(`[flv] 起播 ${isLive ? '直播' : '点播'}流:`, fetchUrl)

  return {
    destroy: () => {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
      try { player?.destroy() } catch {}
      player = null
    },
  }
}
