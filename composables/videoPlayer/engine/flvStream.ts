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

/**
 * 起播一条 FLV 流。`fetchUrl` 是**已经拼好代理的**最终地址（调用方负责，见 useVideoEngine）。
 * `onFatal` 只在 mpegts.js 报致命错误时调一次，用来把提示打到界面上——这里不自己重试：
 * 直播地址带时效签名，过期后重试多少次都是同一个 403。
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
  const player = mpegts.createPlayer(
    { type: 'flv', url: fetchUrl, isLive, cors: true },
    {
      // 直播只求低延迟：不攒 stash、缓冲堆太多就追一次进度（点播那条留默认，靠浏览器自己节流）
      enableStashBuffer: !isLive,
      liveBufferLatencyChasing: isLive,
      lazyLoad: !isLive,
    },
  )

  player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
    console.error('[flv] 错误:', type, detail)
    onFatal(`FLV 播放失败: ${type}${detail ? ' / ' + detail : ''}`)
  })

  player.attachMediaElement(el)
  player.load()
  console.log(`[flv] 起播 ${isLive ? '直播' : '点播'}流:`, fetchUrl)

  return {
    destroy: () => {
      try { player.destroy() } catch {}
    },
  }
}
