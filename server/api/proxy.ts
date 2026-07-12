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
        // 与客户端「单分片 5 分钟」上限一致：慢源大分片别在服务端被 30s 提前掐断。
        // headersTimeout=首字节等待；bodyTimeout=body 分块间的空闲上限（都设 5 分钟）。
        bodyTimeout: 300000,
        headersTimeout: 300000,
        connections: 64,             // 每 origin 最大连接数（默认 10，太低会让 hls.js + 预取互相堵）
        pipelining: 1,
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
    response = await fetchWithRetry(targetUrl, fetchOpts as RequestInit)
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
    // manifest 缓存策略：
    //   · master 列表（#EXT-X-STREAM-INF）→ 永远不变，缓存 1 天
    //   · 点播媒体列表（含 #EXT-X-ENDLIST）→ 已完结、分片列表固定，缓存 1 天
    //   · 直播媒体列表（无 ENDLIST，分片会滚动）→ no-cache，避免拿到旧分片列表
    const isMaster = /#EXT-X-STREAM-INF/i.test(text)
    const isVod = /#EXT-X-ENDLIST/i.test(text)
    if (isMaster || isVod) {
      setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')
    } else {
      setResponseHeader(event, 'Cache-Control', 'no-cache')
    }
    return rewritten
  }

  // ── 二进制（分片 / MP4）：透传 Web ReadableStream ──
  const contentLength = response.headers.get('content-length')
  const contentRange = response.headers.get('content-range')
  const acceptRanges = response.headers.get('accept-ranges')
  const etag = response.headers.get('etag')
  const lastModified = response.headers.get('last-modified')

  if (contentType) setResponseHeader(event, 'Content-Type', contentType)
  if (contentLength) setResponseHeader(event, 'Content-Length', contentLength)
  if (contentRange) setResponseHeader(event, 'Content-Range', contentRange)
  if (acceptRanges) setResponseHeader(event, 'Accept-Ranges', acceptRanges)
  // 分片是不可变内容（同 URL 永远同字节）：只对「完整 200」让浏览器磁盘缓存 1 天，
  // 刷新后大部分分片直接命中磁盘缓存，避免回源慢站。
  // 关键：206 分块响应绝不缓存——同一 URL 不同 Range 若被 HTTP 缓存混用会拿到错乱字节，
  // 导致分块拼出的分片损坏、播不了（Range 分块并行下载踩过的坑）。
  if (response.status === 200) {
    setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')
    // 透传源站校验头，作为缓存过期后的二次校验兜底
    if (etag) setResponseHeader(event, 'ETag', etag)
    if (lastModified) setResponseHeader(event, 'Last-Modified', lastModified)
  } else {
    setResponseHeader(event, 'Cache-Control', 'no-store')
  }
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseStatus(event, response.status)

  // h3 v1+ 支持直接返回 Web ReadableStream，Node 和 CF 都 OK
  return response.body
})

// ── 工具函数 ──────────────────────────────────────────────────

// 带 1 次重试的 fetch：网络错误或 5xx 时重试一次，与前端分片重试形成两层兜底。
// 兼容 Node（透传 dispatcher）与 CF（原生 fetch）。
async function fetchWithRetry(url: string, opts: RequestInit, retries = 1): Promise<Response> {
  let lastErr: any
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (res.status >= 500 && attempt < retries) continue
      return res
    } catch (e) {
      lastErr = e
      if (attempt >= retries) throw e
    }
  }
  throw lastErr
}

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
