import { Readable } from 'node:stream'

/**
 * 服务端视频代理
 * 用途：浏览器禁止 JS 设置 Origin / Referer（forbidden headers），
 *       必须通过服务端请求来注入这两个头。
 *
 * 参数：
 *   url     目标地址（必填）
 *   origin  注入的 Origin 头（可选）
 *   referer 注入的 Referer 头（可选）
 *
 * 对 m3u8 响应做 URL 改写，让 hls.js 解析到的分片 URL 也经过本代理。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = (query.url as string)?.trim()
  const origin    = (query.origin  as string)?.trim() ?? ''
  const referer   = (query.referer as string)?.trim() ?? ''

  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    throw createError({ statusCode: 400, statusMessage: 'Missing or invalid url parameter' })
  }

  // 构建请求头
  const reqHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  }
  if (origin)  reqHeaders['Origin']  = origin
  if (referer) reqHeaders['Referer'] = referer

  // 透传 Range（支持视频 seek / MP4 拖拽）
  const rangeHeader = getRequestHeader(event, 'range')
  if (rangeHeader) reqHeaders['Range'] = rangeHeader

  let response: Response
  try {
    response = await fetch(targetUrl, { headers: reqHeaders })
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: 'Proxy fetch failed: ' + (e as Error).message })
  }

  const contentType = response.headers.get('content-type') ?? ''

  // ── m3u8：改写内部 URL ──
  if (
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl') ||
    targetUrl.includes('.m3u8')
  ) {
    const text = await response.text()
    const baseUrl = targetUrl.replace(/\/[^/?#]*(\?.*)?$/, '/')
    // noseg=1：只改写子 playlist(m3u8) 的 URL，分片 URL 保持原始直链
    // 让浏览器直连 CDN 取分片，速度与无代理一致
    const noseg = query.noseg === '1'
    const rewritten = rewriteM3u8(text, baseUrl, origin, referer, noseg)

    setResponseHeader(event, 'Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
    setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
    return rewritten
  }

  // ── 二进制（分片 / MP4）：流式转发 ──
  // 关键：用 Readable.fromWeb() 把 Web ReadableStream 转成 Node.js Readable，
  // 再交给 sendStream 流式写入响应，避免等待整个分片下载完才开始发送。
  // CDN → Node.js → 浏览器 三段同时进行，而非先缓冲再转发。
  const contentLength = response.headers.get('content-length')
  const contentRange  = response.headers.get('content-range')
  const acceptRanges  = response.headers.get('accept-ranges')

  if (contentType)    setResponseHeader(event, 'Content-Type', contentType)
  if (contentLength)  setResponseHeader(event, 'Content-Length', contentLength)
  if (contentRange)   setResponseHeader(event, 'Content-Range', contentRange)
  if (acceptRanges)   setResponseHeader(event, 'Accept-Ranges', acceptRanges)
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseStatus(event, response.status)

  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  return sendStream(event, nodeStream)
})

// ── 工具函数 ──────────────────────────────────────────────────

function rewriteM3u8(content: string, baseUrl: string, origin: string, referer: string, noseg: boolean): string {
  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed) return line

      // 改写标签内的 URI="..."（EXT-X-MAP / EXT-X-KEY / EXT-X-MEDIA 等）
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = resolveUrl(baseUrl, uri)
          // noseg 模式：只代理子 playlist，跳过初始化分片（.mp4/.m4s）
          if (noseg && !abs.includes('.m3u8')) return `URI="${abs}"`
          return `URI="${buildProxyUrl(abs, origin, referer)}"`
        })
      }

      const abs = resolveUrl(baseUrl, trimmed)
      // noseg 模式：分片直链（.ts / .m4s / 无扩展），只代理子 playlist
      if (noseg && !abs.includes('.m3u8')) return abs
      return buildProxyUrl(abs, origin, referer)
    })
    .join('\n')
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative
  try { return new URL(relative, base).href } catch { return relative }
}

function buildProxyUrl(url: string, origin: string, referer: string): string {
  const params = new URLSearchParams({ url })
  if (origin)  params.set('origin',  origin)
  if (referer) params.set('referer', referer)
  return '/api/proxy?' + params.toString()
}
