import { useM3u8 } from './useM3u8'

/**
 * 连接可达性探测：起播前用几个小请求实测出「manifest 轴」与「分片轴」各自能走哪条通道，
 * 取代过去那条「直连 → 失败重载 → 代理 → 失败重载 → 代理+防盗链」的线性盲试阶梯。
 *
 * 为什么必须两轴分开：manifest 与分片经常不在同一个 host
 * （实测源 manifest 在 bf.jisuziyuanbf.com:443、分片在 p.jisuts.com:999），
 * CORS 头、防盗链、端口、证书都是各自独立的，一根轴表达不了真实世界。
 */

// 四条通道，优先级从高到低（越靠前越省一跳）
export type Channel = 'direct' | 'disguise' | 'headers' | 'rootRef'
export const CHANNEL_ORDER: Channel[] = ['direct', 'disguise', 'headers', 'rootRef']
export const CHANNEL_LABEL: Record<Channel, string> = {
  direct: '直连',
  disguise: '代理·伪装',
  headers: '代理·防盗链',
  rootRef: '代理·防盗链·主域',
}

/**
 * 源站主域的 origin：`https://v3.ddys.ai` → `https://ddys.ai`。
 *
 * `headers` 通道注入的是视频地址自己的 origin，可不少站点的防盗链只认主域——
 * 播放页在 `ddys.ai`、视频在 `v3.ddys.ai`，注入三级域名照样 403（实测 ddys.ai 三条路全挂，
 * 手填 `https://ddys.ai` 立刻能播）。所以多备一条「主域」通道，前三条全不通时才试。
 *
 * 只剥一层子域：剥多了会命中公共后缀（`example.co.uk` 再剥就成了 `co.uk`，那不是任何人的站点）。
 * 端口也不带——播放页几乎不会跟媒体流共用非标端口。
 */
export function parentOrigin(url: string): string {
  try {
    const u = new URL(url.startsWith('//') ? 'https:' + url : url)
    const host = u.hostname
    if (host.includes('[') || /^[\d.]+$/.test(host)) return ''   // IP 没有主域可言
    const labels = host.split('.')
    if (labels.length < 3) return ''                             // 本来就是主域
    const parent = labels.slice(1).join('.')
    if (/^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/i.test(parent)) return ''   // 剥到公共后缀了
    return `${u.protocol}//${parent}`
  } catch { return '' }
}

// 'unknown' 专门留给「超时」——慢 ≠ 不可达，不能据此判死，否则慢源会被误判成要代理
// 'skip'    = 没探（前面已有更优通道胜出，省一轮请求）
export type Reach = 'ok' | 'fail' | 'unknown' | 'skip'

export interface AxisProbe {
  direct: Reach
  disguise: Reach
  headers: Reach
  rootRef: Reach
  ms: Partial<Record<Channel, number>>   // 各通道实测耗时，供 UI 展示与排查
}

export interface ProbeResult {
  at: number
  isHls: boolean
  manifest: AxisProbe
  segment: AxisProbe
  manifestChannel: Channel | null   // null = 三条路全不通
  segmentChannel: Channel | null
  dualChannel: boolean              // 分片「直连 + 代理」双向可达且最终走直连 → 双通道有效
  degraded: boolean                 // 探测本身没结论（全 unknown/全败）→ 调用方退回线性阶梯兜底
  segmentUrl?: string
  keyUrl?: string
  rootOrigin?: string               // rootRef 通道实际注入的主域 origin（空=该源没有主域可剥）
  // headers 通道实际注入的那一对头。可能来自用户填的候选值，也可能是从视频地址推出来的，
  // 结论要连着证据一起带走——否则 resolveConnConfig 只能猜，猜错就变成「探的是 A、用的是 B」
  hdrOrigin?: string
  hdrReferer?: string
  /**
   * 源站已被官方下线（不是通道问题，换哪条都一样）。由代理回的 451 认出来，
   * 见 `server/api/proxy.ts` 的 `DEAD_SOURCE_LANDINGS`。
   */
  deadSource?: boolean
  /**
   * 胜出通道那次拉到的 m3u8 原文 + 它实际请求的 URL。
   *
   * 探测为了数分片，本来就把 manifest 整个 body 下下来了；而紧接着 hls.js 又会去拉同一个 URL。
   * 代理通道靠浏览器 HTTP 缓存能命中（/api/proxy 对点播 m3u8 发 1 天缓存头），
   * 但**直连通道多数 CDN 的 m3u8 是 no-cache**，那就是白等一个 RTT。
   * 带上原文，引擎的 pLoader 就能把这一发直接喂给 hls.js（见 useVideoEngine.createHlsPlaylistLoader）。
   *
   * 只在「下钻到媒体列表」这一层记：master 列表对 hls.js 没有省事的价值，
   * 而且它会自己再下钻一次，喂错层级只会打乱它的画质选择。
   */
  manifestText?: string
  manifestRequestUrl?: string
}

/** 代理对「已被官方下线的源」回这个码（451 Unavailable For Legal Reasons） */
const SOURCE_GONE_STATUS = 451

const DEFAULT_TIMEOUT = 8000     // 单条通道超时
const OVERALL_TIMEOUT = 12000    // 整轮探测硬上限（探测阻塞起播，不能让多个超时叠加）
const emptyAxis = (): AxisProbe => ({ direct: 'skip', disguise: 'skip', headers: 'skip', rootRef: 'skip', ms: {} })

// 「代理·防盗链」是倒数第二档：只有直连和伪装都没通才值得试。
// 绝大多数源站根本不校验防盗链，无脑并发探它只会白等一个 8s 超时尾巴（实测 sintel 就卡在这）。
const needsHeadersChannel = (axis: AxisProbe): boolean => axis.direct !== 'ok' && axis.disguise !== 'ok'
// 「主域」是压箱底的一档：前三条全不通才试，且得真有主域可剥（见 parentOrigin）
const needsRootRefChannel = (axis: AxisProbe): boolean => needsHeadersChannel(axis) && axis.headers !== 'ok'

// ── 通道 URL 构造 ──
// 必须与 useVideoProxy.getProxyUrl 生成的 URL 形态一一对应，否则「探通了但播不了」。
//   direct   → 裸地址
//   disguise → /api/proxy?url=&noref=1        （manifest 额外 noseg=1，让分片留直连地址）
//   headers  → /api/proxy?url=&origin=&referer=（同上）
export function buildChannelUrl(
  url: string,
  channel: Channel,
  opts: { origin?: string; referer?: string; noseg?: boolean } = {},
): string {
  if (channel === 'direct') return url
  const params = new URLSearchParams({ url })
  if (channel === 'disguise') {
    params.set('noref', '1')
  } else {
    if (opts.origin) params.set('origin', opts.origin)
    if (opts.referer) params.set('referer', opts.referer)
  }
  if (opts.noseg) params.set('noseg', '1')
  return '/api/proxy?' + params.toString()
}

// https 页面上的 http 地址 = mixed content，浏览器直接拦截。
// 提前短路判死：既省一个必然失败的请求，也少一条 console 报错。
function isMixedContent(url: string): boolean {
  if (typeof location === 'undefined') return false
  return location.protocol === 'https:' && url.startsWith('http://')
}

/**
 * 探一个 URL 是否可达。只等响应头，拿到 status 立刻取消 body——分片有几百 KB，不能整片下下来。
 *
 * 关键：绝不能加 Range 头做「只取前几字节」。跨域带自定义头会触发 CORS 预检 OPTIONS，
 * 很多 CDN 不处理预检 → 探测假阴性；而真实的分片请求（useHlsPrefetch 里的 fetch）
 * 是不带任何自定义头的 simple request。探测必须与真实请求完全同形才有意义。
 */
async function probeUrl(
  url: string, timeoutMs: number, signal?: AbortSignal,
): Promise<{ reach: Reach; ms: number; status?: number }> {
  if (isMixedContent(url)) return { reach: 'fail', ms: 0 }
  const t0 = performance.now()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
    void res.body?.cancel().catch(() => {})
    return { reach: res.ok ? 'ok' : 'fail', ms: Math.round(performance.now() - t0), status: res.status }
  } catch {
    // 超时 / 撞上整体截止 → unknown（没拿到答案，不能判死，否则慢源会被误判成要代理）；
    // CORS 拒绝 / 网络错误 / 证书问题 → fail
    return { reach: timedOut || signal?.aborted ? 'unknown' : 'fail', ms: Math.round(performance.now() - t0) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

// 按优先级取第一条可达通道（unknown 不算可达，但也不阻止后面的通道胜出）
function pickChannel(axis: AxisProbe): Channel | null {
  for (const c of CHANNEL_ORDER) if (axis[c] === 'ok') return c
  return null
}

/**
 * 执行完整探测。
 *
 * Phase 1：manifest 三路并发（代理两路带 noseg=1，服务端会把分片 URI 解析成绝对地址，
 *          省得从 /api/proxy?... 反推 baseUrl 出错）。
 * Phase 2：从胜出的 manifest 里取第一个分片 + AES key，再三路并发探分片轴。
 */
export async function probeReachability(
  rawUrl: string,
  opts: { origin?: string; referer?: string; timeoutMs?: number; overallMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl
  // 整体截止：探测会阻塞起播，绝不能因为「几条路各自超时叠加」让用户干等半分钟。
  // 到点还没结论就带着已知的部分返回，调用方按 degraded 退回线性阶梯。
  const overall = new AbortController()
  const overallTimer = setTimeout(() => overall.abort(), opts.overallMs ?? OVERALL_TIMEOUT)
  const onOuter = () => overall.abort()
  opts.signal?.addEventListener('abort', onOuter)
  const deadline = overall.signal
  const expired = () => deadline.aborted
  try {
    return await runProbe()
  } finally {
    clearTimeout(overallTimer)
    opts.signal?.removeEventListener('abort', onOuter)
  }

  async function runProbe(): Promise<ProbeResult> {
  const isHls = isM3u8Url(url)

  // 防盗链通道注入什么：用户填了候选值就先试他的（有些站点的 Referer 根本推不出来，
  // 比如视频在 vod1.maowushi.com 而防盗链认的是 aeete.com——那是两个毫不相干的域名）；
  // 没填就退回从视频地址推出的 origin。
  let selfOrigin = opts.origin?.trim() ?? ''
  try { if (!selfOrigin) selfOrigin = new URL(url).origin } catch {}
  const referer = opts.referer?.trim() || (selfOrigin ? selfOrigin.replace(/\/$/, '') + '/' : '')
  // 主域兜底照常保留：用户填的候选值也可能是错的，多一条压箱底的路没坏处
  const rootOrigin = parentOrigin(url)
  // rootRef 与 headers 只差注入哪一对头，URL 形态完全相同
  const hdrFor = (c: Channel) => c === 'rootRef'
    ? { origin: rootOrigin, referer: rootOrigin + '/' }
    : { origin: selfOrigin, referer }

  const result: ProbeResult = {
    at: Date.now(), isHls,
    manifest: emptyAxis(), segment: emptyAxis(),
    manifestChannel: null, segmentChannel: null,
    dualChannel: false, degraded: false,
    rootOrigin, hdrOrigin: selfOrigin, hdrReferer: referer,
  }

  // 探一根轴：直连 + 伪装并发，两者都没通才追加防盗链，防盗链也没通才试主域
  const probeAxis = async (axis: AxisProbe, urlOf: (c: Channel) => string) => {
    const run = async (c: Channel) => {
      const { reach, ms, status } = await probeUrl(urlOf(c), timeoutMs, deadline)
      axis[c] = reach
      axis.ms[c] = ms
      // 代理认出「源站已被官方下线」→ 记在结论上。这一条比「四条通道全不可达」有用得多：
      // 后者听起来像还能换条路试试，前者说明换源之外没有别的办法
      if (status === SOURCE_GONE_STATUS) result.deadSource = true
    }
    await Promise.all([run('direct'), run('disguise')])
    if (needsHeadersChannel(axis) && !expired()) await run('headers')
    if (rootOrigin && needsRootRefChannel(axis) && !expired()) await run('rootRef')
  }

  // ── 非 HLS（MP4 等）：只有一根轴，探文件本身即可，两轴同值 ──
  if (!isHls) {
    await probeAxis(result.manifest, c => buildChannelUrl(url, c, hdrFor(c)))
    result.segment = { ...result.manifest, ms: { ...result.manifest.ms } }
    result.manifestChannel = result.segmentChannel = pickChannel(result.manifest)
    result.degraded = result.manifestChannel === null
    return result
  }

  // ── Phase 1：manifest 多路并发 ──
  // 复用 useM3u8：它对 /api/proxy 开头的 URL 原样使用，正好能喂任意通道的成品 URL。
  const { fetchM3u8Manifest, pickBestVariant, resolveUrl } = useM3u8(u => u)

  const loadManifest = async (channel: Channel) => {
    const target = buildChannelUrl(url, channel, { ...hdrFor(channel), noseg: true })
    if (isMixedContent(target)) return { reach: 'fail' as Reach, ms: 0 }
    const t0 = performance.now()
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    const onDeadline = () => ctrl.abort()
    deadline.addEventListener('abort', onDeadline)
    try {
      let { manifest, baseUrl, text, requestUrl } = await fetchM3u8Manifest(target, ctrl.signal)
      // master 列表：下钻一层拿真正的媒体列表（变体 URI 含 .m3u8，代理会把它重写成代理 URL，可直接再喂回去）
      const best = pickBestVariant(manifest)
      if (best?.uri) {
        ({ manifest, baseUrl, text, requestUrl } = await fetchM3u8Manifest(resolveUrl(baseUrl, best.uri), ctrl.signal))
      }
      const seg = manifest?.segments?.[0]
      // 拿到了响应但里面一个分片都没有 → 判 fail，不能算这条通道「可达」。
      // 源站的错误页（403/404 的 HTML）经代理回来仍是 200，m3u8-parser 也不会抛错，
      // 只是解析出一个空清单；判成 ok 会让后面整轮分片探测被跳过，最终选中一条根本播不了的通道。
      if (!seg?.uri) return { reach: 'fail' as Reach, ms: Math.round(performance.now() - t0) }
      return {
        reach: 'ok' as Reach, ms: Math.round(performance.now() - t0),
        segmentUrl: resolveUrl(baseUrl, seg.uri),
        keyUrl: seg?.key?.uri ? resolveUrl(baseUrl, seg.key.uri) : undefined,
        // 只在「没有 master 需要下钻」时才把原文交出去：有 master 时 hls.js 拿到的第一份是
        // master 本身，喂媒体列表给它等于替它做了画质选择，会打乱 ABR
        manifestText: best?.uri ? undefined : text,
        manifestRequestUrl: best?.uri ? undefined : requestUrl,
      }
    } catch {
      return {
        reach: (timedOut || deadline.aborted ? 'unknown' : 'fail') as Reach,
        ms: Math.round(performance.now() - t0),
      }
    } finally {
      clearTimeout(timer)
      deadline.removeEventListener('abort', onDeadline)
    }
  }

  type ManifestRun = Awaited<ReturnType<typeof loadManifest>>
  const runs: Partial<Record<Channel, ManifestRun>> = {}
  const runManifest = async (c: Channel) => {
    const r = await loadManifest(c)
    runs[c] = r
    result.manifest[c] = r.reach
    result.manifest.ms[c] = r.ms
  }
  // manifest 先只探直连。代理通道慢得多（要绕服务端回源，实测某些源 >10s），
  // 而它只在两种情况下才用得上：直连不通，或分片得走代理（那时 manifest 也必须过代理）。
  // 后者要到 Phase 2 才知道，所以放到那之后按需补测——常见的全直连源就完全不用等这一路。
  await runManifest('direct')
  if (result.manifest.direct !== 'ok') {
    // 直连已经不通了，这里再串行等两个超时会把首访拖到二三十秒 → 两路一起上
    await Promise.all([runManifest('disguise'), runManifest('headers')])
    // 三条都不通才试主域：多数站点的防盗链认自己的 origin，这一路平时是纯浪费
    if (rootOrigin && needsRootRefChannel(result.manifest) && !expired()) await runManifest('rootRef')
  }
  result.manifestChannel = pickChannel(result.manifest)

  // 分片地址取自最高优先级的成功通道（各路解析出的绝对地址应当一致）
  const winner = CHANNEL_ORDER.map(c => runs[c]).find(r => r?.reach === 'ok')
  result.segmentUrl = winner?.segmentUrl
  result.keyUrl = winner?.keyUrl
  // 顺手把胜出那次的 m3u8 原文带走，省掉 hls.js 重拉一遍（见 ProbeResult.manifestText）。
  // 注意胜出通道可能在 Phase 2 之后被改（分片必须走代理时会补测），那时这份原文就对不上了——
  // 所以下面重算 manifestChannel 时要一并作废。
  result.manifestText = winner?.manifestText
  result.manifestRequestUrl = winner?.manifestRequestUrl

  if (!result.manifestChannel) {
    result.degraded = true              // manifest 三条路全不通 → 没结论，交回兜底
    return result
  }
  if (!result.segmentUrl) {
    // manifest 通了但没解析出分片（master 下钻失败 / 空列表）。
    // 别把好不容易测出的 manifest 结论也扔掉——让分片跟随 manifest 通道即可：
    // manifest 直连 → 分片本就是裸地址；manifest 走代理 → noseg=0 让服务端把分片一并改写成代理地址。
    result.segmentChannel = result.manifestChannel
    result.dualChannel = false          // 没实测过分片，不冒险开双通道
    return result
  }

  // ── Phase 2：分片轴 ──
  // AES key 折进分片轴：noseg=1 时服务端只重写 .m3u8，key 会留成直连地址、由浏览器直接取，
  // 所以 key 跟分片走同一条通道。key 这条通道不通 → 整条通道判不可用（自然降级到需要代理的通道）。
  await probeAxis(result.segment, c => buildChannelUrl(result.segmentUrl!, c, hdrFor(c)))
  if (result.keyUrl) {
    const keyUrl = result.keyUrl
    await Promise.all(CHANNEL_ORDER.filter(c => result.segment[c] === 'ok').map(async c => {
      const key = await probeUrl(buildChannelUrl(keyUrl, c, hdrFor(c)), timeoutMs, deadline)
      if (key.reach !== 'ok') result.segment[c] = key.reach
      result.segment.ms[c] = Math.max(result.segment.ms[c] ?? 0, key.ms)
    }))
  }
  result.segmentChannel = pickChannel(result.segment)

  // 分片得走代理 → manifest 也必须过代理（分片 URL 只能由服务端 rewriteM3u8 改写）。
  // 这时才补测之前跳过的 manifest 代理通道。
  if (result.segmentChannel && result.segmentChannel !== 'direct' && !expired()) {
    const pending: Array<Promise<void>> = []
    if (result.manifest.disguise === 'skip') pending.push(runManifest('disguise'))
    if (result.manifest.headers === 'skip' && result.segment.headers === 'ok') pending.push(runManifest('headers'))
    if (result.manifest.rootRef === 'skip' && result.segment.rootRef === 'ok' && rootOrigin) pending.push(runManifest('rootRef'))
    await Promise.all(pending)
    result.manifestChannel = pickChannel(result.manifest)
    // 胜出通道换人了 → 原文跟着换（对不上就作废）。留着别人通道的原文不会出错
    //（pLoader 按完整 URL 匹配，对不上自然 miss），但会让人误以为这次能命中
    const finalRun = result.manifestChannel ? runs[result.manifestChannel] : undefined
    result.manifestText = finalRun?.manifestText
    result.manifestRequestUrl = finalRun?.manifestRequestUrl
  }

  // 双通道判据：分片「直连」和「代理·伪装」双向都实测通，且最终就走直连。
  // 分片必须走代理时直连 lane 必 403/CORS，开了等于一半连接白扔。
  result.dualChannel = result.segment.direct === 'ok'
    && result.segment.disguise === 'ok'
    && result.segmentChannel === 'direct'

  result.degraded = result.manifestChannel === null || result.segmentChannel === null
  return result
  }
}

/**
 * 探测结论 → 实际连接配置。
 *
 * 3×3 收敛成 5 种有效组合，靠一条归一化规则：
 *   · 分片要代理 → manifest 必须走同一种代理（分片 URL 的重写只发生在服务端 rewriteM3u8，
 *     manifest 不过代理就没法把分片指向代理），所以「manifest 直连 + 分片代理」没有独立价值。
 *   · 分片可直连 → manifest 用自己最优的那条，靠 noseg=1 保住分片直连。
 */
export interface ConnConfig {
  disguiseAsDownloader: boolean
  requestOrigin: string
  requestReferer: string
  manifestOnly: boolean
  dualChannel: boolean
}

export function resolveConnConfig(r: ProbeResult, selfOrigin: string): ConnConfig | null {
  const seg = r.segmentChannel
  const man = r.manifestChannel
  if (!seg || !man) return null

  // 两条注入头的通道各用各的那一对：headers 用探测当时实际注入的（用户候选值或从地址推的），
  // rootRef 用主域。selfOrigin 只作为老缓存（没记 hdrOrigin）的兜底。
  const hdr = (c: Channel): { origin: string; referer: string } => {
    const origin = c === 'rootRef' ? (r.rootOrigin || selfOrigin) : (r.hdrOrigin ?? selfOrigin)
    const referer = c === 'rootRef'
      ? (origin ? origin.replace(/\/$/, '') + '/' : '')
      : (r.hdrReferer ?? (origin ? origin.replace(/\/$/, '') + '/' : ''))
    return { origin, referer }
  }
  const withHeaders = (manifestOnly: boolean, c: Channel): ConnConfig => ({
    disguiseAsDownloader: false,
    requestOrigin: hdr(c).origin,
    requestReferer: hdr(c).referer,
    manifestOnly,
    dualChannel: r.dualChannel,
  })
  const asDisguise = (manifestOnly: boolean): ConnConfig =>
    ({ disguiseAsDownloader: true, requestOrigin: '', requestReferer: '', manifestOnly, dualChannel: manifestOnly ? r.dualChannel : false })

  if (seg !== 'direct') {
    // 分片要代理 → manifest 也必须过代理（分片 URL 的重写只发生在服务端 rewriteM3u8）。
    // 所以只能选一种「manifest 和分片同时可达」的代理口味；一种都凑不齐就判没结论，交回兜底。
    if (seg === 'disguise' && r.manifest.disguise === 'ok') return asDisguise(false)
    if (seg === 'rootRef' && r.manifest.rootRef === 'ok') return withHeaders(false, 'rootRef')
    if (r.manifest.headers === 'ok' && r.segment.headers === 'ok') return withHeaders(false, 'headers')
    if (r.manifest.rootRef === 'ok' && r.segment.rootRef === 'ok') return withHeaders(false, 'rootRef')
    if (r.manifest.disguise === 'ok' && r.segment.disguise === 'ok') return asDisguise(false)
    return null
  }

  // 分片直连：manifest 各走各的最优
  if (man === 'direct') {
    return { disguiseAsDownloader: false, requestOrigin: '', requestReferer: '', manifestOnly: false, dualChannel: r.dualChannel }
  }
  if (man === 'disguise') {
    // 「代理·伪装 manifest + 分片直连」——旧线性阶梯根本表达不出来的组合
    return { disguiseAsDownloader: true, requestOrigin: '', requestReferer: '', manifestOnly: true, dualChannel: r.dualChannel }
  }
  return withHeaders(true, man)
}

// ── 结论判读（播放器与解析页共用）──
//
// 判读独立成函数而不是散在各调用点：同一份矩阵有三个读者（播放器起播前的提醒、
// 折叠区的探测矩阵、解析页的「可达性检测」按钮），各写一遍必然漂移——
// 尤其「四条通道全 fail」和「没测过（全 skip）」这两种长得像但含义相反的情况（见 axisMeasured）。

const axisAnyOk = (a: AxisProbe): boolean => CHANNEL_ORDER.some(c => a[c] === 'ok')

/**
 * 这根轴到底测过没有。清单通了但没解析出分片时（master 下钻失败 / 空列表）probeAxis 压根不会跑，
 * 四个通道全留在 'skip'——那是「没测」不是「测过不通」，拿它当证据会把结论说反（踩过）。
 */
export const axisMeasured = (a: AxisProbe): boolean => CHANNEL_ORDER.some(c => (a[c] ?? 'skip') !== 'skip')

/** 测过、且每一条测过的通道都实测失败（没有 ok、也没有 unknown 可以指望）→ 已被证伪，重试无意义 */
const axisAllFailed = (a: AxisProbe): boolean =>
  axisMeasured(a)
  && CHANNEL_ORDER.some(c => a[c] === 'fail')
  && CHANNEL_ORDER.every(c => a[c] === 'fail' || (a[c] ?? 'skip') === 'skip')

export type ProbeIssue =
  'ok' | 'source-gone' | 'manifest-unreachable' | 'segment-unreachable' | 'combo-missing' | 'inconclusive'

export interface ProbeVerdict {
  /** fatal = 实测证伪，再等/再试都没用，值得立刻告诉用户；warn = 没结论，照常尝试 */
  severity: 'ok' | 'warn' | 'fatal'
  issue: ProbeIssue
  title: string
  detail: string
}

const INCONCLUSIVE: Omit<ProbeVerdict, 'title'> = {
  severity: 'warn', issue: 'inconclusive',
  detail: '有通道到超时都没响应（慢源常见，慢 ≠ 不可达），播放器会照常加载并在失败时逐级降级。',
}

/**
 * 矩阵 → 一句结论 + 一段原因。
 *
 * 关键是把 `fatal` 摘出来：清单能取到、分片四条通道全 403 这种情况在探测结束的那一刻
 * 就已经注定播不了，而后面还要跑 5 级线性阶梯盲试、每级一次 15s 加载超时——
 * 用户盯着转圈一分多钟才看到一句「加载超时」。结论早就有了，就该早说。
 */
export function diagnoseProbe(r: ProbeResult | null): ProbeVerdict {
  if (!r) return { ...INCONCLUSIVE, title: '尚未探测' }
  const segName = r.isHls ? '分片' : '视频'
  const advice = '多为地址已过期、源站换了防盗链规则，或 CDN 拒了我们的出口 IP。换一条线路或重新解析即可。'

  // 已经确知原因就别说「不可达」这种废话——用户问的是「为什么播不了」，
  // 而这一条的答案是「跟连接方式无关，这个源被下线了」
  if (r.deadSource) {
    return {
      severity: 'fatal', issue: 'source-gone',
      title: '这个源已被 Cloudflare 以违反服务条款下线',
      detail: '源站内容被整个换成了一张「This content has been restricted」的占位图（我们照原样播只会一直闪），'
        + '换通道、改 Origin/Referer 都没有用。只能换一条线路或换个片源。',
    }
  }

  if (!axisAnyOk(r.manifest)) {
    if (axisAllFailed(r.manifest)) {
      return {
        severity: 'fatal', issue: 'manifest-unreachable',
        title: r.isHls ? 'm3u8 清单四条通道全部不可达' : '视频地址四条通道全部不可达',
        detail: `直连与代理（伪装 / 防盗链 / 主域）全部失败，这条地址取不下来。${advice}`,
      }
    }
    return { ...INCONCLUSIVE, title: r.isHls ? '清单探测未拿到结论' : '探测未拿到结论' }
  }

  // 分片轴没测过（全 skip）= 让分片跟随清单通道，不是问题，别报
  if (axisMeasured(r.segment) && !axisAnyOk(r.segment)) {
    if (axisAllFailed(r.segment)) {
      return {
        severity: 'fatal', issue: 'segment-unreachable',
        title: `清单能取到，但${segName}四条通道全部不可达`,
        detail: `第一个${segName}在直连和代理（伪装 / 防盗链 / 主域）上全部失败，播进去只会一直转圈。${advice}`,
      }
    }
    return { ...INCONCLUSIVE, title: `${segName}探测未拿到结论` }
  }

  // 两轴各自都有可达通道，却凑不出一种「清单与分片同时可达」的组合（见 resolveConnConfig 的归一化）
  if (!resolveConnConfig(r, '')) {
    return {
      severity: 'warn', issue: 'combo-missing',
      title: '清单与分片的可达通道凑不出组合',
      detail: '典型是「清单只能直连、分片只能走代理」这类方向相反的不对称要求，无法同时满足，播放器会退回线性阶梯盲试。',
    }
  }

  return { severity: 'ok', issue: 'ok', title: '可以播放 · ' + describeProbe(r), detail: '' }
}

export interface ProbeMatrixRow {
  name: string
  cells: Array<{ channel: Channel; label: string; reach: Reach; ms?: number }>
}

/** 矩阵读数（两轴 × 四通道），供 `<ProbeMatrix>` 渲染 */
export function probeMatrixRows(r: ProbeResult | null): ProbeMatrixRow[] {
  if (!r) return []
  const axes: Array<{ name: string; axis: AxisProbe }> = r.isHls
    ? [{ name: '清单', axis: r.manifest }, { name: '分片', axis: r.segment }]
    : [{ name: '视频', axis: r.segment }]
  return axes.map(({ name, axis }) => ({
    name,
    // axis[c] 兜 'skip'：加通道之前写进 localStorage 的旧探测结果没有新字段，
    // 直接渲染 undefined 会得到一个没有底色、也没有 title 的空格子
    cells: CHANNEL_ORDER.map(c => ({ channel: c, label: CHANNEL_LABEL[c], reach: axis[c] ?? 'skip', ms: axis.ms[c] })),
  }))
}

// 探测结论的一句话描述，供 UI 展示
export function describeProbe(r: ProbeResult | null): string {
  if (!r) return ''
  if (!r.manifestChannel || !r.segmentChannel) return '探测未通'
  const parts = r.isHls
    ? [`清单${CHANNEL_LABEL[r.manifestChannel]}`, `分片${CHANNEL_LABEL[r.segmentChannel]}`]
    : [CHANNEL_LABEL[r.segmentChannel]]
  if (r.dualChannel) parts.push('双通道')
  return parts.join(' / ')
}
