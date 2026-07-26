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
  // 注意：Origin / Referer 不在这里塞——交给 fetchWithHeaderProbe 决定
  // （很多源站根本不校验防盗链，不带头反而更快更稳，见下方探测逻辑）

  // 透传 Range（支持视频 seek / MP4 拖拽）
  const rangeHeader = getRequestHeader(event, 'range')
  if (rangeHeader) reqHeaders['Range'] = rangeHeader

  const dispatcher = await getNodeDispatcher()

  let response: Response
  try {
    response = await fetchWithHeaderProbe(targetUrl, reqHeaders, origin, referer, dispatcher)
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

// ── 防盗链头探测 ──────────────────────────────────────────────
//
// 前端传了 origin/referer，但很多源站压根不校验防盗链；
// 不带头请求往往更快（少一次源站鉴权），有些站反而会因为 Origin 触发 CORS 预检式拒绝。
// 所以首次访问某个 host 时「带头 / 不带头」两路并发，谁先成功用谁，
// 结果按 host 缓存，后续请求（分片、后续 m3u8）只发一路。

type HeaderVariant = 'with' | 'without'
const headerModeCache = new Map<string, { variant: HeaderVariant; at: number }>()
const HEADER_MODE_TTL = 30 * 60 * 1000 // 30 分钟后重新探测，避免源站策略变更后一直用错

function hostKey(url: string): string {
  try { return new URL(url).host } catch { return url }
}

function readHeaderMode(host: string): HeaderVariant | undefined {
  const hit = headerModeCache.get(host)
  if (!hit) return undefined
  if (Date.now() - hit.at > HEADER_MODE_TTL) {
    headerModeCache.delete(host)
    return undefined
  }
  return hit.variant
}

/**
 * 按需探测「带 Origin/Referer」还是「裸请求」能通，返回成功的那个响应。
 * 未提供 origin/referer 时退化为普通单次请求。
 */
async function fetchWithHeaderProbe(
  targetUrl: string,
  baseHeaders: Record<string, string>,
  origin: string,
  referer: string,
  dispatcher: any,
): Promise<Response> {
  const buildOpts = (variant: HeaderVariant, signal?: AbortSignal) => {
    const headers = { ...baseHeaders }
    if (variant === 'with') {
      if (origin) headers['Origin'] = origin
      if (referer) headers['Referer'] = referer
    }
    const opts: RequestInit & { dispatcher?: any } = { headers, signal }
    if (dispatcher) opts.dispatcher = dispatcher
    return opts as RequestInit
  }

  // 没有防盗链头可省 → 两路完全一样，没必要并发
  if (!origin && !referer) return fetchWithRetry(targetUrl, buildOpts('with'))

  const host = hostKey(targetUrl)
  const cached = readHeaderMode(host)
  if (cached) {
    try {
      const res = await fetchWithRetry(targetUrl, buildOpts(cached))
      if (res.ok) return res
      // 缓存的方式失效了（源站改策略 / 换了签名）→ 丢弃缓存，下面重新探测
      void res.body?.cancel().catch(() => {})
      headerModeCache.delete(host)
    } catch {
      headerModeCache.delete(host)
    }
  }

  // 两路并发探测
  const variants: HeaderVariant[] = ['with', 'without']
  const attempts = variants.map(variant => {
    const ctrl = new AbortController()
    return { variant, ctrl, p: fetchWithRetry(targetUrl, buildOpts(variant, ctrl.signal)) }
  })

  const { variant, res } = await firstSuccess(attempts)

  // 放弃另一路：中止连接 + 取消 body，别占着连接池
  for (const a of attempts) {
    if (a.variant === variant) continue
    try { a.ctrl.abort() } catch {}
    a.p.then(r => r.body?.cancel().catch(() => {}), () => {})
  }

  if (res.ok) {
    headerModeCache.set(host, { variant, at: Date.now() })
    console.log(`[proxy] header probe: ${host} → ${variant === 'with' ? 'Origin/Referer' : '裸请求'}`)
  }
  return res
}

/** 取第一个 2xx 的结果；全都不是 2xx 就返回第一个拿到的响应；全都抛错就抛最后一个错。 */
function firstSuccess(
  attempts: Array<{ variant: HeaderVariant; p: Promise<Response> }>,
): Promise<{ variant: HeaderVariant; res: Response }> {
  return new Promise((resolve, reject) => {
    let left = attempts.length
    let fallback: { variant: HeaderVariant; res: Response } | null = null
    let lastErr: any
    let done = false

    for (const a of attempts) {
      a.p.then(
        res => {
          if (done) return
          if (res.ok) { done = true; resolve({ variant: a.variant, res }); return }
          if (!fallback) fallback = { variant: a.variant, res }
        },
        err => { lastErr = err },
      ).finally(() => {
        if (done || --left > 0) return
        done = true
        if (fallback) resolve(fallback)
        else reject(lastErr ?? new Error('all header variants failed'))
      })
    }
  })
}

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
      // 被探测逻辑主动中止（另一路已胜出）→ 立刻放弃，别再重试浪费连接
      if (opts.signal?.aborted) throw e
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
