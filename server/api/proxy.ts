/**
 * 服务端视频代理（Node + Cloudflare Workers 双环境兼容）
 *
 * 用途：浏览器禁止 JS 设置 Origin / Referer（forbidden headers），
 *       必须通过服务端请求来注入这两个头。
 *
 * 参数：
 *   url     目标地址（必填）
 *   origin  注入的 Origin 头（可选，noref=1 时忽略）
 *   referer 注入的 Referer 头（可选，noref=1 时忽略）
 *   noref=1 伪装下载器：不发送 Origin/Referer
 *   noseg=1 m3u8 内的分片 URL 不改写（让分片直连 CDN）
 *
 * 实现细节：
 *   - 不静态 import 任何 node:* 或 Node 专属包，避免 CF 构建/运行报错
 *   - 在 Node 上动态加载 undici Agent，放宽 TLS 校验（兼容老旧/中国 CDN）
 *   - 在 CF/Bun/Deno 上自动降级走原生 fetch
 *   - 二进制响应通过 Web ReadableStream（response.body）流式转发
 */

// 动态获取 undici Dispatcher（仅在 Node 可用）。
// 用变量包裹 specifier + @vite-ignore 防止 Vite/Nitro 在 CF 构建时静态解析。
let _dispatcher: any = undefined
let _dispatcherChecked = false
async function getNodeDispatcher(): Promise<any> {
  if (_dispatcherChecked) return _dispatcher
  _dispatcherChecked = true
  // CF Workers 没有 process；只在 Node 进程里尝试加载 undici
  // @ts-ignore globalThis.process 在 CF 上不存在
  if (typeof globalThis.process === 'undefined' || !globalThis.process?.versions?.node) return undefined
  try {
    const spec = 'undici'
    const undici = await import(/* @vite-ignore */ spec)
    if (undici?.Agent) {
      _dispatcher = new undici.Agent({
        connect: { rejectUnauthorized: false, timeout: 15000 },
        bodyTimeout: 30000,
        headersTimeout: 30000,
      })
    }
  } catch {
    // 加载失败就降级为原生 fetch
  }
  return _dispatcher
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = (query.url as string)?.trim()
  const noref = query.noref === '1'
  const origin = noref ? '' : ((query.origin as string)?.trim() ?? '')
  const referer = noref ? '' : ((query.referer as string)?.trim() ?? '')

  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    throw createError({ statusCode: 400, statusMessage: 'Missing or invalid url parameter' })
  }

  const reqHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
  }
  if (origin) reqHeaders['Origin'] = origin
  if (referer) reqHeaders['Referer'] = referer

  // 透传 Range（支持视频 seek / MP4 拖拽）
  const rangeHeader = getRequestHeader(event, 'range')
  if (rangeHeader) reqHeaders['Range'] = rangeHeader

  const dispatcher = await getNodeDispatcher()
  const fetchOpts: RequestInit & { dispatcher?: any } = { headers: reqHeaders }
  if (dispatcher) fetchOpts.dispatcher = dispatcher

  let response: Response
  try {
    response = await fetch(targetUrl, fetchOpts as RequestInit)
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const cause = err.cause?.code || err.cause?.message || ''
    const detail = cause ? `${err.message} (${cause})` : err.message
    console.error('[proxy] fetch failed:', targetUrl, '|', detail)
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

  // ── 二进制（分片 / MP4）：透传 Web ReadableStream ──
  const contentLength = response.headers.get('content-length')
  const contentRange = response.headers.get('content-range')
  const acceptRanges = response.headers.get('accept-ranges')

  if (contentType) setResponseHeader(event, 'Content-Type', contentType)
  if (contentLength) setResponseHeader(event, 'Content-Length', contentLength)
  if (contentRange) setResponseHeader(event, 'Content-Range', contentRange)
  if (acceptRanges) setResponseHeader(event, 'Accept-Ranges', acceptRanges)
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseStatus(event, response.status)

  // h3 v1+ 支持直接返回 Web ReadableStream，Node 和 CF 都 OK
  return response.body
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
