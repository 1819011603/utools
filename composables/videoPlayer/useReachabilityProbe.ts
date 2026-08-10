import { useM3u8 } from './useM3u8'
import { isDirectDead, markDirectDead, clearDirectDead } from './probeStore'

/**
 * 连接可达性探测：起播前用几个小请求实测出「manifest 轴」与「分片轴」各自能走哪条通道，
 * 取代过去那条「直连 → 失败重载 → 代理 → 失败重载 → 代理+防盗链」的线性盲试阶梯。
 *
 * 为什么必须两轴分开：manifest 与分片经常不在同一个 host
 * （实测源 manifest 在 bf.jisuziyuanbf.com:443、分片在 p.jisuts.com:999），
 * CORS 头、防盗链、端口、证书都是各自独立的，一根轴表达不了真实世界。
 */

/**
 * 三条通道，优先级从高到低（越靠前越省一跳）。
 *
 * 曾经有第四条 `rootRef`（代理·防盗链·主域，把 `v3.ddys.ai` 剥成 `ddys.ai` 再注入），
 * 已删。它只对「防盗链只认主域」那一小类站点有用，代价却是每次都可能多等一个 8s 超时，
 * 而**能力并没有丢**：这类站点手填 Origin/Referer 候选值即可（候选值会喂进 headers 通道），
 * ddys.ai 当年就是这么发现的。
 */
export type Channel = 'direct' | 'disguise' | 'headers'
export const CHANNEL_ORDER: Channel[] = ['direct', 'disguise', 'headers']
export const CHANNEL_LABEL: Record<Channel, string> = {
  direct: '直连',
  disguise: '代理·伪装',
  headers: '代理·防盗链',
}

// 'unknown' 专门留给「超时」——慢 ≠ 不可达，不能据此判死，否则慢源会被误判成要代理
// 'skip'    = 没探（前面已有更优通道胜出，省一轮请求）
export type Reach = 'ok' | 'fail' | 'unknown' | 'skip'

export interface AxisProbe {
  direct: Reach
  disguise: Reach
  headers: Reach
  ms: Partial<Record<Channel, number>>   // 各通道实测耗时，供 UI 展示与排查
}

export interface ProbeResult {
  at: number
  /**
   * 整轮探测的墙钟耗时（ms）。摆在页面上是为了让「慢在哪」可归因——
   * 各通道的 ms 是并发跑的，加起来跟总耗时没有关系（实测分片轴 946+5637 却只花 5.6s），
   * 光看单元格根本看不出这一轮到底等了多久。
   */
  totalMs?: number
  isHls: boolean
  manifest: AxisProbe
  segment: AxisProbe
  manifestChannel: Channel | null   // null = 三条路全不通
  segmentChannel: Channel | null
  dualChannel: boolean              // 分片「直连 + 代理」双向可达且最终走直连 → 双通道有效
  degraded: boolean                 // 探测本身没结论（全 unknown/全败）→ 调用方退回线性阶梯兜底
  segmentUrl?: string
  keyUrl?: string
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
  /** 我们**请求**的那个地址。用来跟 hls.js 要的 `context.url` 严格比对，决定这份原文能不能用 */
  manifestRequestUrl?: string
  /**
   * **重定向之后**的最终地址。必须跟着一起带走：hls.js 拿 `response.url` 当基准来还原
   * 清单里的相对分片 URI，而真实的 XHR 给它的恒是最终地址。
   *
   * 实测 ncat22 的源：清单地址是 `142.248.96.195:21306/...`，一请求就 302 到
   * `142.248.96.194:11306/...`（换了 IP 也换了端口）。只把请求地址交给 hls.js 的话，
   * 相对分片会被还原到 `.195:21306` 上——那台机器给的不是这条流的分片，
   * 于是「分片全 200、解码持续失败」，报出来是「取回的数据不是可播的视频」（踩过）。
   */
  manifestFinalUrl?: string
}

/** 代理对「已被官方下线的源」回这个码（451 Unavailable For Legal Reasons） */
const SOURCE_GONE_STATUS = 451

const DEFAULT_TIMEOUT = 8000     // 单条通道超时
const OVERALL_TIMEOUT = 12000    // 整轮探测硬上限（探测阻塞起播，不能让多个超时叠加）
/**
 * 对冲延迟（**只用于分片轴**）：直连+伪装超过这么久还没结论，就把「代理·防盗链」也并发发出去，
 * 不干等前两条各自的 8s 超时。
 *
 * 清单轴不用它——那边已经改成三路同时发（见发起处的账目），一个等待期都没有。
 * 分片轴保留「先两路、必要时补第三路」是因为绝大多数源根本不校验防盗链，
 * 无脑并发探它只会白发一个必然失败的分片请求（实测 sintel 卡在这条上）。
 */
const HEDGE_DELAY = 250
/**
 * 优先级预算：**从这根轴开始计时**，高优先级通道总共只有这么久的机会。
 * 预算烧完后，只要手上已经有可达通道，就按已有结论收工，不再等还在跑的那几条。
 *
 * 实测截图（分片轴）：`伪装 946ms ✓ / 直连 5637ms ✗`。两路本来就并发，可整根轴仍花了 5.6s
 * ——946ms 那一刻结论其实已经定了（最终就走伪装），后面 4.7s 全在干等一条注定失败的直连。
 *
 * 为什么不干脆「谁先 ok 就立刻收工」：直连慢一点但可用时（首次 TLS 握手、冷 DNS），
 * 按优先级它才是该选的那条——少一跳、不吃服务器出口流量、不受「代理出口 IP 被 CDN 拒」影响。
 *
 * **为什么是「从轴开始算的预算」而不是「从第一个 ok 之后再等一段」**：后者会和对冲窗口叠加，
 * 等于把机会给了同一条通道两次——`250(对冲) + 26(代理RTT) + 300(再等) = 576ms`，
 * 而直连实际拿到了 576ms 的窗口。改成总预算后同样这一轮只花 400ms，且语义只有一句话：
 * 「直连有 400ms，过时不候」。对冲仍然独立存在，它管的是**什么时候发**，不是**什么时候收工**。
 *
 * 收工后迟到的答案一律**不采纳**（那条通道留在 `'skip'` = 没等到，不是测过不通）；
 * 请求本身不去 abort，它自己会在 8s 超时里结束，只是没人要它的结果了。
 */
const PRIORITY_BUDGET = 400
const GRACE_TICK = 50            // 预算的检查粒度
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * 一根轴的等待器：带「优先级宽限」的收工判定。清单轴与分片轴共用一份实现——
 * 两边各写一遍必然漂移，而清单轴恰恰是漏掉它才留下「直连黑洞就白等 8s」那个洞。
 *
 * `wait(all, maxWait)` 在三种情况下返回：
 *  · all 全部落定 → 正常结束
 *  · 已有通道通 + 宽限烧完（或撞整轮截止）→ **收工**（settled=true，迟到的答案不再采纳）
 *  · 到了 maxWait（对冲窗口）→ 返回但**不收工**，让调用方去补下一条通道，在跑的照样能写进来
 */
function makeAxisWaiter(expired: () => boolean, budgetMs: number) {
  const st = { settled: false, hasOk: false, since: performance.now() }
  return {
    st,
    noteOk: () => { st.hasOk = true },
    /** 补测阶段要重新开闸：收工过的等待器直接复用会把补测结果整个丢掉（=> 结论变 degraded）。
     *  预算也重新起算——那是新的一轮，凭什么用上一轮烧掉的额度 */
    reopen: () => { st.settled = false; st.hasOk = false; st.since = performance.now() },
    wait: async (all: Promise<unknown>, maxWait = Infinity) => {
      const t0 = performance.now()
      const done = all.then(() => true as const)
      while (true) {
        if (await Promise.race([done, sleep(GRACE_TICK).then(() => false as const)])) return
        if (expired()) { st.settled = true; return }
        // 已有可达通道 + 高优先级通道的预算烧完 → 收工。预算从本轴开始算（不与对冲窗口叠加），
        // budgetMs=0 即「首个可达通道就收工」
        if (st.hasOk && performance.now() - st.since >= budgetMs) { st.settled = true; return }
        if (performance.now() - t0 >= maxWait) return
      }
    },
  }
}
const emptyAxis = (): AxisProbe => ({ direct: 'skip', disguise: 'skip', headers: 'skip', ms: {} })

// 「代理·防盗链」是倒数第二档：只有直连和伪装都没通才值得试。
// 绝大多数源站根本不校验防盗链，无脑并发探它只会白等一个 8s 超时尾巴（实测 sintel 就卡在这）。
const needsHeadersChannel = (axis: AxisProbe): boolean => axis.direct !== 'ok' && axis.disguise !== 'ok'

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
  const startedAt = performance.now()
  try {
    const r = await runProbe()
    r.totalMs = Math.round(performance.now() - startedAt)
    return r
  } finally {
    clearTimeout(overallTimer)
    opts.signal?.removeEventListener('abort', onOuter)
  }

  async function runProbe(): Promise<ProbeResult> {
  const isHls = isM3u8Url(url)
  // 「直连黑洞」按 host 记，而两轴常常不在同一个 host（本模块存在的前提就是这个），
  // 所以每次进 probeAxis 时按它当时探的那个地址取——分片轴用分片的 host，别拿清单的冒充
  let probeHost = ''
  const hostOf = (u: string): string => { try { return new URL(u).host } catch { return '' } }

  // 防盗链通道注入什么：用户填了候选值就先试他的（有些站点的 Referer 根本推不出来，
  // 比如视频在 vod1.maowushi.com 而防盗链认的是 aeete.com——那是两个毫不相干的域名）；
  // 没填就退回从视频地址推出的 origin。
  let selfOrigin = opts.origin?.trim() ?? ''
  try { if (!selfOrigin) selfOrigin = new URL(url).origin } catch {}
  const referer = opts.referer?.trim() || (selfOrigin ? selfOrigin.replace(/\/$/, '') + '/' : '')
  // 只有 headers 一条通道要注入头，各通道的 URL 构造仍统一走这个函数
  const hdrFor = (_c: Channel) => ({ origin: selfOrigin, referer })

  const result: ProbeResult = {
    at: Date.now(), isHls,
    manifest: emptyAxis(), segment: emptyAxis(),
    manifestChannel: null, segmentChannel: null,
    dualChannel: false, degraded: false,
    hdrOrigin: selfOrigin, hdrReferer: referer,
  }

  // 探一根轴：直连 + 伪装并发，两者都没通才追加防盗链
  const probeAxis = async (axis: AxisProbe, urlOf: (c: Channel) => string) => {
    // 上次在这个 host 上直连是黑洞（超时不返回）→ 这回照样发探测，但**一分钟预算都不给它**，
    // 结论不等它（见 probeStore 的 isDirectDead：负面记忆 + 自愈，通了就清）
    const w = makeAxisWaiter(expired, isDirectDead(probeHost) ? 0 : PRIORITY_BUDGET)
    const run = async (c: Channel) => {
      const { reach, ms, status } = await probeUrl(urlOf(c), timeoutMs, deadline)
      if (w.st.settled) return          // 已收工：这条留在 'skip'（没等到，不是测过不通）
      axis[c] = reach
      axis.ms[c] = ms
      if (reach === 'ok') w.noteOk()
      // 直连的实测结果反哺那份「黑洞」记忆：超时才记（fail 是快速失败，不占等待时间，没必要记），
      // 一旦通了立刻清掉——网络环境变了就该恢复给它预算
      if (c === 'direct') {
        if (reach === 'unknown') markDirectDead(probeHost)
        else if (reach === 'ok') clearDirectDead(probeHost)
      }
      // 代理认出「源站已被官方下线」→ 记在结论上。这一条比「三条通道全不可达」有用得多：
      // 后者听起来像还能换条路试试，前者说明换源之外没有别的办法
      if (status === SOURCE_GONE_STATUS) result.deadSource = true
    }
    // 直连 + 伪装并发；到点还没结论就对冲补上防盗链，不等它们各自的 8s 超时（见 HEDGE_DELAY）。
    // 直连在这根轴上**保留优先级预算**（PRIORITY_BUDGET）：分片走直连才可能开双通道，
    // 而那个判据要求「直连也实测到 ok」——一有代理通了就立刻收工的话，双通道再也开不起来
    const pair = Promise.all([run('direct'), run('disguise')])
    await w.wait(pair, HEDGE_DELAY)
    if (!w.st.settled && needsHeadersChannel(axis) && !expired()) {
      await w.wait(Promise.all([pair, run('headers')]))
    }
  }

  // ── 非 HLS（MP4 等）：只有一根轴，探文件本身即可，两轴同值 ──
  if (!isHls) {
    probeHost = hostOf(url)
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
      let { manifest, baseUrl, text, requestUrl, finalUrl } = await fetchM3u8Manifest(target, ctrl.signal)
      // master 列表：下钻一层拿真正的媒体列表（变体 URI 含 .m3u8，代理会把它重写成代理 URL，可直接再喂回去）
      const best = pickBestVariant(manifest)
      if (best?.uri) {
        ({ manifest, baseUrl, text, requestUrl, finalUrl } = await fetchM3u8Manifest(resolveUrl(baseUrl, best.uri), ctrl.signal))
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
        manifestFinalUrl: best?.uri ? undefined : finalUrl,
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
  // 清单轴的等待器，预算 0 = **首个可达通道就收工**，不给直连额外等待期（理由见下面发起处）
  const mw = makeAxisWaiter(expired, 0)
  const runManifest = async (c: Channel) => {
    const r = await loadManifest(c)
    if (mw.st.settled) return                 // 已收工：这条留 'skip'，也别覆盖 runs（原文要跟胜出通道对得上）
    runs[c] = r
    result.manifest[c] = r.reach
    result.manifest.ms[c] = r.ms
    if (r.reach === 'ok') mw.noteOk()
  }
  /**
   * 清单轴：**三路同时发，谁先可达就收工**，不给任何通道额外等待期。
   *
   * 这里曾经是「先只发直连 → 对冲 250ms → 再给宽限 300ms」。三级台阶叠出来的账（实测）：
   * `对冲 250 + 代理 26 + 宽限 300 = 576ms`，其中 550ms 全在等一条**黑洞直连**
   *（压根不返回，连快速失败都不是）。清单探测本身只要 26ms。
   *
   * 代价是每次加载多发两份清单请求（清单探测不是 HEAD，会把整份清单读下来）。这笔钱值得付：
   * 它换掉的是**每次起播前都要付的几百毫秒**，而清单一般只有几 KB，代理侧还有 1 天缓存。
   * 分片轴不这么做——那边还要靠「直连也测到 ok」来判双通道，见 PRIORITY_BUDGET。
   *
   * **判定仍按优先级**（pickChannel 按 CHANNEL_ORDER 取），只是不再为此付等待时间：
   * 直连若和代理几乎同时回来，胜出的还是直连。
   */
  await mw.wait(Promise.all([runManifest('direct'), runManifest('disguise'), runManifest('headers')]))
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
  result.manifestFinalUrl = winner?.manifestFinalUrl

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
  probeHost = hostOf(result.segmentUrl!)
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
    mw.reopen()   // 上面可能已收工；不重新开闸的话补测结果会被当成「迟到」丢掉 → 结论变 degraded
    const pending: Array<Promise<void>> = []
    if (result.manifest.disguise === 'skip') pending.push(runManifest('disguise'))
    if (result.manifest.headers === 'skip' && result.segment.headers === 'ok') pending.push(runManifest('headers'))
    await Promise.all(pending)
    result.manifestChannel = pickChannel(result.manifest)
    // 胜出通道换人了 → 原文跟着换（对不上就作废）。留着别人通道的原文不会出错
    //（pLoader 按完整 URL 匹配，对不上自然 miss），但会让人误以为这次能命中
    const finalRun = result.manifestChannel ? runs[result.manifestChannel] : undefined
    result.manifestText = finalRun?.manifestText
    result.manifestRequestUrl = finalRun?.manifestRequestUrl
    result.manifestFinalUrl = finalRun?.manifestFinalUrl
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

  // headers 通道用探测当时**实际注入**的那一对（用户候选值或从地址推的）——结论必须连着证据走，
  // 否则就成了「探的是 A、用的是 B」。selfOrigin 只作为老缓存（没记 hdrOrigin）的兜底。
  const hdrOrigin = r.hdrOrigin ?? selfOrigin
  const withHeaders = (manifestOnly: boolean): ConnConfig => ({
    disguiseAsDownloader: false,
    requestOrigin: hdrOrigin,
    requestReferer: r.hdrReferer ?? (hdrOrigin ? hdrOrigin.replace(/\/$/, '') + '/' : ''),
    manifestOnly,
    dualChannel: r.dualChannel,
  })
  const asDisguise = (manifestOnly: boolean): ConnConfig =>
    ({ disguiseAsDownloader: true, requestOrigin: '', requestReferer: '', manifestOnly, dualChannel: manifestOnly ? r.dualChannel : false })

  if (seg !== 'direct') {
    // 分片要代理 → manifest 也必须过代理（分片 URL 的重写只发生在服务端 rewriteM3u8）。
    // 所以只能选一种「manifest 和分片同时可达」的代理口味；一种都凑不齐就判没结论，交回兜底。
    if (seg === 'disguise' && r.manifest.disguise === 'ok') return asDisguise(false)
    if (r.manifest.headers === 'ok' && r.segment.headers === 'ok') return withHeaders(false)
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
  return withHeaders(true)
}

// ── 结论判读（播放器与解析页共用）──
//
// 判读独立成函数而不是散在各调用点：同一份矩阵有三个读者（播放器起播前的提醒、
// 折叠区的探测矩阵、解析页的「可达性检测」按钮），各写一遍必然漂移——
// 尤其「三条通道全 fail」和「没测过（全 skip）」这两种长得像但含义相反的情况（见 axisMeasured）。

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
 * 关键是把 `fatal` 摘出来：清单能取到、分片三条通道全 403 这种情况在探测结束的那一刻
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
        title: r.isHls ? 'm3u8 清单三条通道全部不可达' : '视频地址三条通道全部不可达',
        detail: `直连与代理（伪装 / 防盗链）全部失败，这条地址取不下来。${advice}`,
      }
    }
    return { ...INCONCLUSIVE, title: r.isHls ? '清单探测未拿到结论' : '探测未拿到结论' }
  }

  // 分片轴没测过（全 skip）= 让分片跟随清单通道，不是问题，别报
  if (axisMeasured(r.segment) && !axisAnyOk(r.segment)) {
    if (axisAllFailed(r.segment)) {
      return {
        severity: 'fatal', issue: 'segment-unreachable',
        title: `清单能取到，但${segName}三条通道全部不可达`,
        detail: `第一个${segName}在直连和代理（伪装 / 防盗链）上全部失败，播进去只会一直转圈。${advice}`,
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
