import { useM3u8 } from './useM3u8'
import { isDirectDead, markDirectDead, clearDirectDead } from './probeStore'
import { describeLevel } from './videoDiag'
import { makeAxisWaiter, emptyAxis, needsHeadersChannel, isMixedContent, probeUrl, pickChannel, SOURCE_GONE_STATUS, DEFAULT_TIMEOUT, OVERALL_TIMEOUT, HEDGE_DELAY, PRIORITY_BUDGET } from './probe/probeHttp'

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
  /**
   * 迟到的双通道结论：两条 lane 的探测有一条没在预算内回来时，等它回来再判一次。
   * 起播**不等**它（双通道只是预取加速），上层拿到 true 再把第二条 lane 打开。
   * 不做成 `dualChannel` 的一部分，是因为那个字段还要落进跨页缓存，promise 序列化不了。
   */
  dualChannelLate?: Promise<boolean>
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
  /**
   * 胜出通道的清单里带出来的清晰度（master 列表才有——分辨率/码率写在 `EXT-X-STREAM-INF`
   * 的 variant 上，媒体列表本身没有这个信息）。复用 `describeLevel` 而不是自己再格式化一遍，
   * 保证跟播放器信息条里那枚清晰度徽标是同一句话
   */
  variantRes?: string
}

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

  /**
   * 探一根轴：直连 + 伪装并发，两者都没通才追加防盗链。
   *
   * 返回 `{ pair, raw }` 供调用方做「迟到证据」用：
   * `axis` 里 `'skip'` 的语义是**没等到**（不是测过不通），这条语义有别处在用（needsHeadersChannel），
   * 所以迟到的结论不能回填进 axis；`raw` 是不受收工影响的原始结论，只作证据、不参与选通道。
   */
  const probeAxis = async (axis: AxisProbe, urlOf: (c: Channel) => string) => {
    // 上次在这个 host 上直连是黑洞（超时不返回）→ 这回照样发探测，但**一分钟预算都不给它**，
    // 结论不等它（见 probeStore 的 isDirectDead：负面记忆 + 自愈，通了就清）
    const budgetMs = isDirectDead(probeHost) ? 0 : PRIORITY_BUDGET
    const axisT0 = performance.now()
    const w = makeAxisWaiter(expired, budgetMs)
    const raw: Partial<Record<Channel, Reach>> = {}
    const run = async (c: Channel) => {
      const { reach, ms, status } = await probeUrl(urlOf(c), timeoutMs, deadline)
      raw[c] = reach                    // 原始结论恒记：收工与否只影响「用不用它选通道」，不影响它是不是事实
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
    } else if (!w.st.settled && !expired()) {
      /*
       * **HEDGE_DELAY 只用来决定「要不要补防盗链」，不能用它来收工。**
       *
       * 它（250ms）比本轴预算（PRIORITY_BUDGET 400ms）短，所以上面那次 wait 恒因 maxWait 返回，
       * 预算那句 `hasOk && now - since >= budgetMs` 在常见路径上**一次都跑不到** —— 等于预算是死代码。
       * 后果不是「少等一会儿」，而是**拿一份缺页的矩阵下判断**：慢的那条通道此刻还是 `skip`，
       * 它的结果几百毫秒后才写进 axis（那时 pickChannel/dualChannel 早算完了）。
       *
       * 实测 mux 那条流：分片 disguise 158ms ok、direct 597ms ok，判定发生在 250ms，
       * 于是 `segmentChannel = disguise`（**明明能直连却被按到代理上**，每片多绕一跳、吃我们的出口流量，
       * 还可能撞上「经代理反而 403」那类源），`dualChannel` 也永远是 false —— 它的判据要求
       * 直连与伪装两条都**实测** ok。矩阵事后看起来两条全 ok，最难查就在这儿。
       *
       * 所以：两条都还没齐时再等到本轴预算用完为止（从轴开始算，不与对冲窗口叠加）。
       * 过时仍不候 —— 语义还是那一句「直连有 PRIORITY_BUDGET，过时不候」。
       */
      await w.wait(pair, Math.max(0, budgetMs - (performance.now() - axisT0)))
    }
    return { pair, raw }
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
      // 清晰度只写在 master 的 variant 属性上，下钻之后这份信息就没了，先摘出来
      const variantRes = best?.attributes
        ? describeLevel({ height: best.attributes.RESOLUTION?.height, bitrate: best.attributes.BANDWIDTH })
        : undefined
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
        variantRes: variantRes === '自动' ? undefined : variantRes,
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
  result.variantRes = winner?.variantRes

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
  const segAxis = await probeAxis(result.segment, c => buildChannelUrl(result.segmentUrl!, c, hdrFor(c)))
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
    result.variantRes = finalRun?.variantRes
  }

  // 双通道判据：分片「直连」和「代理·伪装」双向都实测通，且最终就走直连。
  // 分片必须走代理时直连 lane 必 403/CORS，开了等于一半连接白扔。
  result.dualChannel = result.segment.direct === 'ok'
    && result.segment.disguise === 'ok'
    && result.segmentChannel === 'direct'

  /*
   * 两条 lane 的证据常常凑不齐 —— 谁先回来就在预算内定了通道，另一条还在路上
   * （实测同一条流两次跑：一次 disguise 158ms/direct 597ms，一次 direct 268ms/disguise 更晚）。
   * **但双通道只影响预取分流，不影响能不能起播**，所以绝不为它多等一毫秒：
   * 把「等齐之后再判一次」交出去，迟到就迟到，上层收到再把第二条 lane 打开。
   * 判据里仍要求最终走直连；万一那条代理 lane 其实不通，还有 markLaneFail 连续失败 3 次熔断兜底。
   */
  if (!result.dualChannel && result.segmentChannel === 'direct') {
    result.dualChannelLate = segAxis.pair.then(() =>
      segAxis.raw.direct === 'ok' && segAxis.raw.disguise === 'ok' && result.segmentChannel === 'direct')
  }

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
