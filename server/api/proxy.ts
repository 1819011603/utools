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

import { isM3u8Url } from '../../utils/mediaUrl'

/**
 * 「这个 zone 已经被下线」的落地页域名。落在这上面的响应一律判上游失败，
 * 不能当内容返回——它是 200 + 一张真图片，会一路骗过 res.ok 判定（详见下方调用处）。
 *
 * 只放**含义明确、全球一致**的官方落地页；一般的跳转 CDN 绝不能进这张表
 *（签名边缘节点天天跨 host 重定向，误判会把好源判死）。
 */
const DEAD_SOURCE_LANDINGS = ['cloudflare-terms-of-service-abuse.com']

const hostOfUrl = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase() } catch { return '' }
}

/**
 * 动态获取 undici Dispatcher（仅在 Node 可用）。
 * 用变量包裹 specifier + @vite-ignore 防止 Vite/Nitro 在 CF 构建时静态解析。
 *
 * **本接口有两类流量，出口选择恰好相反，所以备两个 dispatcher**（`?site=1` 区分）：
 *
 *  · **媒体流**（清单/分片/key，默认）：本地开发时**不一定该走代理**——出口 IP 一变很多 CDN 直接 403
 *    （实测 vip.ffzy-play10.com：本机直连 200、经本地代理 403，且与 Referer 完全无关）。
 *    这种 403 极难归因：页面上是「分片红一片」，很容易误判成防盗链或连接策略写错了。
 *    故留 `MEDIA_NO_PROXY=1` 让媒体流直连（也可用 `MEDIA_HTTPS_PROXY` 单独指定媒体出口）。
 *  · **站点资源**（`?site=1`：解析链路要取的站点自己的 js/wasm、签名取址接口）：**必须能走代理**，
 *    因为目标站点在本机往往被 DNS 污染／压根连不通（同 siteFetch.ts 的理由）。
 *
 * 这两件事曾经共用一个 dispatcher，于是 `MEDIA_NO_PROXY=1` 把解析链路一起按成直连，
 * 表现是**解析页能出选集、一取址就全 502**（`UND_ERR_CONNECT_TIMEOUT`）。
 * 实测 4kvm：`/static/wasm/*.js` 直连超时、经本机代理 1.2s 200。踩过，别再合并。
 *
 * CF Pages 上这些环境变量都不存在，两个 dispatcher 都是直连，行为一致。
 */
const _dispatchers = new Map<string, any>()   // 'media' | 'site' → dispatcher（undefined 也要存，表示已查过）
async function getNodeDispatcher(kind: 'media' | 'site'): Promise<any> {
  if (_dispatchers.has(kind)) return _dispatchers.get(kind)
  _dispatchers.set(kind, undefined)
  // CF Workers 没有 process；只在 Node 进程里尝试加载 undici
  // @ts-ignore globalThis.process 在 CF 上不存在
  if (typeof globalThis.process === 'undefined' || !globalThis.process?.versions?.node) return undefined
  try {
    const spec = 'undici'
    const undici = await import(/* @vite-ignore */ spec)
    const opts = {
      connect: { rejectUnauthorized: false, timeout: 15000 },
      // 与客户端「单分片 5 分钟」上限一致：慢源大分片别在服务端被 30s 提前掐断。
      // headersTimeout=首字节等待；bodyTimeout=body 分块间的空闲上限（都设 5 分钟）。
      bodyTimeout: 300000,
      headersTimeout: 300000,
      connections: 64,             // 每 origin 最大连接数（默认 10，太低会让 hls.js + 预取互相堵）
      pipelining: 1,
    }
    // @ts-ignore CF Workers 上没有 process
    const env = globalThis.process?.env ?? {}
    const generic = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
    // 站点资源：MEDIA_NO_PROXY 管不着它，有代理就走
    const proxyUri = kind === 'site' ? generic
      : (env.MEDIA_NO_PROXY === '1' ? '' : (env.MEDIA_HTTPS_PROXY || generic))
    let d: any
    if (proxyUri && undici?.ProxyAgent) {
      d = new undici.ProxyAgent({ uri: proxyUri, ...opts })
      console.log(`[proxy] ${kind} 走代理转发：${proxyUri}`)
    } else if (undici?.Agent) {
      d = new undici.Agent(opts)
      if (kind === 'media' && env.MEDIA_NO_PROXY === '1') console.log('[proxy] MEDIA_NO_PROXY=1：媒体流直连出口，不走本地代理')
    }
    _dispatchers.set(kind, d)
  } catch {
    // 加载失败就降级为原生 fetch
  }
  return _dispatchers.get(kind)
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

  // site=1：解析链路要取的站点资源（js/wasm/取址接口），出口选择与媒体流相反，见 getNodeDispatcher
  const dispatcher = await getNodeDispatcher(query.site === '1' ? 'site' : 'media')

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

  // ── 源站已被下线：跟随重定向后落在「域名违规」落地页 ──
  //
  // 实测 ylsp「大陆3线」的分片 host `tssn.r2tsbf.top`：**任何**请求（带头 / 不带头 / 换 Referer /
  // 换 UA 全试过）都 302 到 `https://www.cloudflare-terms-of-service-abuse.com/stream.jpg`——
  // Cloudflare 把违规 zone 的内容整个换成了那张 20KB 的诱饵图，对所有人一视同仁。
  // 而 fetch 默认跟随重定向，于是我们**以 200 + image/jpeg 把诱饵图当分片返回**，一路假阳性：
  //   · 可达性探测只看 `res.ok` → 代理通道判 `ok`（直连通道倒是天然 fail：落地页没有 ACAO）；
  //   · hls.js 每片拿到同一张图片 → 解不出帧 → fatal MEDIA_ERROR → recoverMediaError → 再拿一遍，
  //     页面**一直在闪**、永远出不来画面。
  // 只有服务端看得见最终 URL（浏览器侧跨域响应读不到重定向链），所以这一刀必须在这里落。
  // 状态码换成 502 后，探测那四条通道就会全判 fail，diagnoseProbe 直接报「分片全部不可达」。
  const finalHost = hostOfUrl(response.url) || hostOfUrl(targetUrl)
  const deadLanding = DEAD_SOURCE_LANDINGS.find(d => finalHost === d || finalHost.endsWith('.' + d))
  // 状态码用 **451 Unavailable For Legal Reasons** 而不是笼统的 502：客户端探测据此把结论
  // 从「四条通道全部不可达」升级成「源站已被官方下线」——后者才回答了用户的问题（换通道没用，只能换源）
  if (deadLanding) {
    void response.body?.cancel().catch(() => {})
    console.warn('[proxy] 源站已下线（重定向到违规落地页）:', targetUrl, '→', response.url)
    throw createError({ statusCode: 451, statusMessage: 'Upstream taken down: redirected to ' + deadLanding })
  }
  // 合法的跨 host 重定向（签名 CDN 边缘节点很常见）照常放过，只把落点记在响应头上：
  // 「明明探测通了却播不了」这类问题，最终落在哪个 host 是第一手线索
  if (finalHost && finalHost !== hostOfUrl(targetUrl)) {
    setResponseHeader(event, 'X-Proxy-Final-Host', finalHost)
  }

  // ── 上游非 2xx：原样把状态码透回去，绝不进 m3u8 改写 ──
  //
  // 不这么做的后果极其隐蔽（实测 vip.ffzy-play10.com）：源站对不带 Referer 的请求回 403 + 一页 HTML，
  // 而这段 HTML 因为请求的是 .m3u8 会被 rewriteM3u8 逐行当成相对 URI 拼上 baseUrl，
  // 最后以 **200 + application/vnd.apple.mpegurl** 返回。于是：
  //   · 可达性探测的 `fetchM3u8Manifest` 不报错 → 该通道被判成 `ok`（假阳性）；
  //   · 但解析出来 0 个分片 → `segmentUrl` 为空 → 分片轴整轮跳过，四格全 `skip`；
  //   · 结论只好让分片跟随清单，最终选了一条实际 403 的通道，播放器满屏红。
  // 「分片轴全 skip + 清单显示可达」这个诡异现象追了三轮，根子就在这里。
  if (!response.ok) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
    setResponseHeader(event, 'Cache-Control', 'no-store')
    if (contentType) setResponseHeader(event, 'Content-Type', contentType)
    setResponseStatus(event, response.status)
    return response.body
  }

  // ── m3u8：改写内部 URL ──
  // 判据用 isM3u8Url 而不是 includes('.m3u8')：分片路径里可能带 .m3u8 目录名，
  // 误判会让二进制分片走下面的 response.text()，返回乱码（见 utils/mediaUrl.ts）
  if (
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl') ||
    isM3u8Url(targetUrl)
  ) {
    const text = await response.text()
    // ── 相对分片 URI 的基准必须是**重定向之后**的最终地址，不是我们请求的那个 ──
    //
    // 浏览器和 hls.js 天然按最终地址还原相对 URI（RFC 3986 的 base 就是最终 URI），
    // 这里跟着来才对得上。客户端那条路早已这么做了（useM3u8 取 res.url、
    // playlistLoader 把 finalUrl 交给 hls.js），漏的一直是服务端这一半。
    //
    // 实测 ncat22 这条流：清单在 `64.112.77.160:21305`，一请求就 302 到同 IP 的 `:11305`，
    // 而 `:21305` 是个**健康检查口** —— 对 `.ts` 一律回
    // **200 + `content-type: video/mp2t` + 3 字节正文 `OK\n`**。于是拿错基准的后果是：
    //   · 分片被拼回 `:21305` → 每片都 200、还带着视频 MIME；
    //   · 可达性探测只看 `res.ok` → 分片轴判 `ok`（假阳性，比 403 难查得多）；
    //   · hls.js 把 3 字节 "OK" 当 TS 解 → fatal MEDIA_ERROR，
    //     报出来是「取回的数据不是可播的视频，换一条线路试试」，看着像源站挂了或正则写坏了。
    // 只有服务端看得见重定向链（跨域响应在浏览器侧读不到），所以这一刀只能落在这。
    const baseUrl = (response.url || targetUrl).replace(/\/[^/?#]*(\?.*)?$/, '/')
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
          if (noseg && !isM3u8Url(abs)) return `URI="${abs}"`
          return `URI="${buildProxyUrl(abs, origin, referer, noref, noseg)}"`
        })
      }

      const abs = resolveUrl(baseUrl, trimmed)
      if (noseg && !isM3u8Url(abs)) return abs
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
