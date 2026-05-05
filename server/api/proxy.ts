import { Readable } from 'node:stream'
import { Agent, fetch as undiciFetch } from 'undici'

// 兼容老旧/中国 CDN 的 TLS 设置：放宽证书校验，强制 IPv4，延长超时。
// 国内站（如 jisuzyv 这类聚合站）经常因为 cert chain / SNI / cipher 不兼容
// 让 Node 默认 fetch 报 "fetch failed"。
const tolerantAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
    timeout: 15000,
  },
  bodyTimeout: 30000,
  headersTimeout: 30000,
})

/**
 * 服务端视频代理
 * 用途：浏览器禁止 JS 设置 Origin / Referer（forbidden headers），
 *       必须通过服务端请求来注入这两个头。
 *
 * 参数：
 *   url     目标地址（必填）
 *   origin  注入的 Origin 头（可选，noref=1 时忽略）
 *   referer 注入的 Referer 头（可选，noref=1 时忽略）
 *   noref=1 伪装下载器：不发送 Origin/Referer，部分 CDN（如 xhscdn）对此类请求放行
 *
 * 对 m3u8 响应做 URL 改写，让 hls.js 解析到的分片 URL 也经过本代理。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = (query.url as string)?.trim()
  const noref = query.noref === '1'
  const origin = noref ? '' : ((query.origin as string)?.trim() ?? '')
  const referer = noref ? '' : ((query.referer as string)?.trim() ?? '')

  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    throw createError({ statusCode: 400, statusMessage: 'Missing or invalid url parameter' })
  }

  // 构建请求头（noref 时故意不添加 Origin/Referer，模拟 N_m3u8DL-RE 等下载器）
  const reqHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
  }
  if (origin) reqHeaders['Origin'] = origin
  if (referer) reqHeaders['Referer'] = referer

  // 透传 Range（支持视频 seek / MP4 拖拽）
  const rangeHeader = getRequestHeader(event, 'range')
  if (rangeHeader) reqHeaders['Range'] = rangeHeader

  let response: Response
  try {
    response = await undiciFetch(targetUrl, {
      headers: reqHeaders,
      dispatcher: tolerantAgent,
    }) as unknown as Response
  } catch (e) {
    // undici 把真实原因放在 cause 上（如 ECONNRESET / EPROTO / UND_ERR_SOCKET）
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const cause = err.cause?.code || err.cause?.message || ''
    const detail = cause ? `${err.message} (${cause})` : err.message
    console.error('[proxy] fetch failed:', targetUrl, '|', detail, e)
    throw createError({ statusCode: 502, statusMessage: 'Proxy fetch failed: ' + detail })
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
    const noseg = query.noseg === '1'
    const rewritten = rewriteM3u8(text, baseUrl, origin, referer, noseg, noref)

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

function rewriteM3u8(
  content: string,
  baseUrl: string,
  origin: string,
  referer: string,
  noseg: boolean,
  noref: boolean,
): string {
  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed) return line

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = resolveUrl(baseUrl, uri)
          if (noseg && !abs.includes('.m3u8')) return `URI="${abs}"`
          // 子 playlist 也传递 noseg，避免改写其内部的分片 URL
          return `URI="${buildProxyUrl(abs, origin, referer, noref, noseg)}"`
        })
      }

      const abs = resolveUrl(baseUrl, trimmed)
      if (noseg && !abs.includes('.m3u8')) return abs
      return buildProxyUrl(abs, origin, referer, noref, noseg)
    })
    .join('\n')
}

function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative
  try { return new URL(relative, base).href } catch { return relative }
}

function buildProxyUrl(url: string, origin: string, referer: string, noref: boolean, noseg?: boolean): string {
  const params = new URLSearchParams({ url })
  if (noref) {
    params.set('noref', '1')
  } else {
    if (origin) params.set('origin', origin)
    if (referer) params.set('referer', referer)
  }
  if (noseg) params.set('noseg', '1')
  return '/api/proxy?' + params.toString()
}
