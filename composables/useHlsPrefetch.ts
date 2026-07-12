import type HlsType from 'hls.js'
import type { useSegmentCache } from './useSegmentCache'
import { SERVER_TIERS, DEFAULT_TIER, type ServerTier, type TierParams } from './videoSiteRules'

export type HealthZone = 'panic' | 'low' | 'healthy'

/**
 * HLS 自适应并行预取：
 *  - createHlsFragLoader：自定义 fLoader，命中预取缓存即时返回，miss 则 fetch
 *  - triggerAdaptivePrefetch：每次 FRAG_BUFFERED 后按缓冲健康度补预取
 *  - startOnePrefetch：完成 1 个补 1 个
 *
 * 通过 getHls/getVideoEl 惰性读取播放器实例（避免持有过期引用），
 * 缓存读写委托给 useSegmentCache。
 */
export interface HlsPrefetchOptions {
  getHls: () => HlsType | null
  getVideoEl: () => HTMLVideoElement | undefined
  getProxyUrl: (url: string) => string
  cache: ReturnType<typeof useSegmentCache>
  // 站点规则的 playbackConcurrency：作为并发「下限/手动兜底」（默认 3），引擎可按需再往上到 6
  getConcurrencyCap: () => number
  // 当前倍速（倍速越高需要越大带宽），默认 1
  getPlaybackRate?: () => number
  // 预取深度上限（秒）：真实前向缓冲达到此值即停止预取，默认 Infinity（不限）
  getPrefetchTargetSecs?: () => number
  // 起播锚点（秒）：恢复进度/刷新时，播放头还停在 0、但我们要起播的位置在 pendingStartPos。
  // 预取以 max(currentTime, 此值) 为起点——起播即在正确位置全力并行预取，既不浪费带宽下开头，
  // 也不会退化成「只有 hls.js 串行下 1 片」。播放头到位/用户跳转后返回 0（改用 currentTime）。默认 0。
  getStartPosition?: () => number
  // 连接 lane：返回同一分片在「不同 origin」下的多个 URL（如 [直连CDN, /api/proxy]）。
  // 浏览器 per-origin 只给 6 条连接，分属两个 origin 即可并行 ~12 条。默认单 lane（当前 getProxyUrl 结果）。
  getLaneUrls?: (url: string) => string[]
  // 当前服务器档位参数（好/中/差预设 + 页面覆盖）。不设则用中档兜底。
  // 抗卡阈值(panicSecs/lowSecs)、安全系数、对冲/跳片超时、并发下限、预取深度全从这里读。
  getTierParams?: () => TierParams
}

export interface StrategySnapshot {
  perConnKBps: number     // 实测每连接速度
  segMbps: number         // 实测视频码率
  targetConn: number      // 当前目标并发
  maxFluentRate: number   // 当前带宽最高可流畅倍速
  aggregateScales: boolean // 聚合是否随线程增长（true=每连接限速可并行；false=每IP硬顶不可并行）
  healthZone: HealthZone  // 基于真实 MSE 的缓冲健康区（panic 触发抗卡降速/跳片）
}

const MAX_CONN = 6               // 浏览器同 host 连接上限（HTTP/1.1，硬顶）
const LOW_BUFFER_MAX_CONN = 3    // 不可并行(每IP硬顶)且吃紧时最多并发：集中带宽拿紧邻分片，别被远处预取抢占

export function useHlsPrefetch(opts: HlsPrefetchOptions) {
  const { getProxyUrl, cache, getConcurrencyCap } = opts
  const getPlaybackRate = opts.getPlaybackRate ?? (() => 1)
  const getPrefetchTargetSecs = opts.getPrefetchTargetSecs ?? (() => Infinity)
  const getStartPosition = opts.getStartPosition ?? (() => 0)
  const getLaneUrls = opts.getLaneUrls ?? ((url: string) => [getProxyUrl(url)])
  // 档位参数：好/中/差预设，抗卡阈值/超时/安全系数全从这里取（默认中档）
  const tier = (): TierParams => opts.getTierParams?.() ?? SERVER_TIERS[DEFAULT_TIER]
  // 并发下限：站点规则 playbackConcurrency 与档位 concurrencyFloor 取大
  const floorConn = (): number => Math.max(1, getConcurrencyCap(), tier().concurrencyFloor)
  // 有效预取深度：只认用户「预加载时长」（maxBufferLength）。档位不收窄它——
  // 否则快源缓存一到档位深度就停、预取线程掉 0。想省内存请调小「预加载时长」。
  const effectivePrefetchTarget = (): number => getPrefetchTargetSecs()

  // 预取锚点：起播定位未到位时用 pendingStartPos，否则用真实播放头。所有「从哪往后预取」的判断都基于它。
  const anchorTime = (video: HTMLVideoElement): number => Math.max(video.currentTime, getStartPosition())

  // ── 连接 lane 负载均衡（直连+代理双通道）──
  // 每条新连接分到「在途最少」的 lane，使各 origin 都不超过浏览器 6 条上限，聚合达到 lane 数 × 6。
  // fLoader（hls.js 自身分片）与预取共用同一个均衡器，避免两者各自打满同一个 origin。
  const laneInflight: number[] = []
  const acquireLane = (url: string): { lane: number; laneUrl: string } => {
    const urls = getLaneUrls(url)
    let lane = 0
    for (let i = 1; i < urls.length; i++) {
      if ((laneInflight[i] ?? 0) < (laneInflight[lane] ?? 0)) lane = i
    }
    laneInflight[lane] = (laneInflight[lane] ?? 0) + 1
    return { lane, laneUrl: urls[lane] }
  }
  const releaseLane = (lane: number) => {
    if ((laneInflight[lane] ?? 0) > 0) laneInflight[lane]--
  }

  // ── 在途下载计时（诊断「哪个分片卡住、下了多久」）──
  // url → 该分片本次下载的起始 performance.now()。发起时登记，成功/失败/中止时删除。
  const segInflightStart = new Map<string, number>()
  const shortName = (url: string): string => {
    try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || url) } catch { return url }
  }
  // 返回当前在途下载里耗时最长的一个（最可能是卡住播放的那片），附在途总数。
  const getStuckSegment = (): { name: string; elapsedMs: number; count: number } | null => {
    if (segInflightStart.size === 0) return null
    const now = performance.now()
    let worstUrl = '', worst = -1
    for (const [u, t] of segInflightStart) { const el = now - t; if (el > worst) { worst = el; worstUrl = u } }
    return { name: shortName(worstUrl), elapsedMs: worst, count: segInflightStart.size }
  }
  // 当前流的 lane 数（用一个代表性 URL 探测），用于放宽并发上限
  const getLaneCount = (sampleUrl?: string): number => (sampleUrl ? getLaneUrls(sampleUrl).length : 1)

  // 跳过卡死的分片：把播放头挪到该分片之后，让 hls.js 从下一片重新加载（下一片多半已预取，秒恢复）。
  // 只在「确实卡在播放头附近」时跳，避免把提前缓冲的远处分片误当卡点跳掉。返回是否真的跳了。
  const skipSegment = (frag: any): boolean => {
    const video = opts.getVideoEl()
    if (!video || !frag) return false
    const ahead = getAheadBuffered(video)
    if (ahead > 1.5) return false                               // 播放还没吃紧 → 不是真卡点，不跳
    // 抗卡阶梯「先降速再跳片」：倍速>1 时优先靠降速守卫救场，不急着跳；
    // 但已几乎冻结(<0.3s)则无论倍速都跳——冻结比一次画面跳变更糟。
    if (getPlaybackRate() > 1.05 && ahead > 0.3) return false
    if ((frag.start ?? 0) > video.currentTime + 2) return false // 该片在播放头前方较远（提前缓冲）→ 不跳
    const target = (frag.start ?? video.currentTime) + (frag.duration ?? 2) + 0.1
    if (target > video.currentTime && (!video.duration || target < video.duration - 0.5)) {
      video.currentTime = target
      return true
    }
    return false
  }
  const {
    segPrefetchCache, segPrefetching, segPrefetchAborts,
    prefetchInfo, getPrefetchedBuf, evictPrefetchCache,
  } = cache

  // ── 实测采样（EWMA）：每连接速度 + 视频码率，驱动动态并发 ──
  let perConnBps = 0   // 实测每连接速度（bps）
  let segBitrate = 0   // 实测视频码率（bps）
  // 聚合可并行探针：分别记「低并发时」与「高并发时」的每连接速度。
  // 若高并发下每连接速度基本持平 → 每连接限速、加线程聚合线性增长（可并行）；
  // 若高并发下每连接速度骤降 → 每 IP 总量硬顶、加线程只是分摊（不可并行）。
  let perConnLow = 0   // 并发 ≤2 时的每连接速度
  let perConnHigh = 0  // 并发 ≥5 时的每连接速度
  const ewma = (prev: number, cur: number) => (prev ? prev * 0.7 + cur * 0.3 : cur)
  const sampleSpeed = (bytes: number, ms: number, concurrency = 0) => {
    // 只采样真实网络传输：过滤缓存命中（极快）、过小分片、离谱值，避免污染实测
    if (bytes < 100_000 || ms < 50) return
    const bps = (bytes * 8) / (ms / 1000)
    if (bps > 500_000_000) return   // >500Mbps 基本是缓存/异常，丢弃
    perConnBps = ewma(perConnBps, bps)
    if (concurrency > 0 && concurrency <= 2) perConnLow = ewma(perConnLow, bps)
    else if (concurrency >= 5) perConnHigh = ewma(perConnHigh, bps)
  }
  // 聚合是否随线程增长：两档都有数据时比较，否则乐观按「可并行」（多数 CDN 如此）
  const getAggregateScales = (): boolean => {
    if (perConnLow > 0 && perConnHigh > 0) return perConnHigh >= perConnLow * 0.55
    return true
  }
  const sampleBitrate = (bytes: number, sec: number) => {
    if (bytes > 0 && sec > 0) segBitrate = ewma(segBitrate, (bytes * 8) / sec)
  }

  // ── 最高流畅倍速：用实测带宽 ÷ 码率直接算（见 refreshStrategy）──
  // 早期靠「缓冲增长率」反推，但预取到「预加载时长」封顶后缓冲不再增长、增长率≈0，
  // 会把可持续倍速误判成 1x。改为纯带宽模型：满并发聚合带宽能喂几倍码率就是几倍。

  const strategy = ref<StrategySnapshot>({ perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0, aggregateScales: true, healthZone: 'healthy' })

  // 并发上限：默认单 host 6；多 CDN（分片跨多个 host）时按 host 数放宽（每 host 6，封顶 12）
  let hostConcurrencyCap = MAX_CONN

  // 闭环控制状态：以「缓冲是否在掉」为反馈调并发，比开环测速更抗卡顿、天然适配倍速
  let ctrlConn = 0                        // 当前受控并发（0=未初始化）
  let lastAhead = -1                      // 上次的前向缓冲秒数
  let lastHealthZone: HealthZone = 'healthy'  // 基于真实 MSE 的健康区（驱动 UI 与降速守卫）

  // 切换视频/CDN 时重置实测与控制器，避免用上个流的数据误判新流
  const resetStrategy = () => {
    perConnBps = 0
    segBitrate = 0
    perConnLow = 0
    perConnHigh = 0
    hostConcurrencyCap = MAX_CONN
    ctrlConn = 0
    lastAhead = -1
    lastHealthZone = 'healthy'
    laneInflight.length = 0
    segInflightStart.clear()
    strategy.value = { perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0, aggregateScales: true, healthZone: 'healthy' }
  }

  // 实测驱动的目标并发：需要带宽 = 码率 × 倍速 × 安全系数；并发 = ⌈需要 / 每连接速度⌉
  const computeTargetConcurrency = (): number => {
    const floor = floorConn()
    if (!perConnBps || !segBitrate) return Math.min(hostConcurrencyCap, Math.max(floor, 4))  // 冷启动：乐观
    const required = segBitrate * getPlaybackRate() * tier().safety
    const need = Math.ceil(required / perConnBps)
    return Math.min(hostConcurrencyCap, Math.max(2, need, floor))
  }

  // 刷新对外策略快照（供 UI 展示与倍速可行性判断）
  const refreshStrategy = (targetConn: number) => {
    // 最高流畅倍速 = 满并发聚合带宽 ÷ (码率 × 安全系数)，向下对齐 0.25 档（保守，不过度承诺）。
    // 与并发模型（computeTargetConcurrency）一致：满并发时能喂几倍码率就是几倍。
    // 冷启动（还没测出每连接带宽或码率）先按「当前倍速」展示，而非 0。
    const sustainable = (!perConnBps || !segBitrate)
      ? Math.max(1, Math.round(getPlaybackRate() / 0.25) * 0.25)
      : Math.max(1, Math.floor((perConnBps * hostConcurrencyCap) / (segBitrate * tier().safety) / 0.25) * 0.25)
    strategy.value = {
      perConnKBps: Math.round(perConnBps / 8 / 1024),
      segMbps: Math.round((segBitrate / 1e6) * 10) / 10,
      targetConn,
      maxFluentRate: sustainable,
      aggregateScales: getAggregateScales(),
      healthZone: lastHealthZone,
    }
  }

  // 计算当前播放位置前方的缓冲秒数（仅 MSE，真实可立即播放的量）。
  // 抗卡顿闭环/自适应并发必须用这个，不能掺预取缓存（否则误判缓冲充足而停下载）。
  const getAheadBuffered = (video: HTMLVideoElement): number => {
    const ct = video.currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= ct + 0.1 && ct <= video.buffered.end(i)) {
        return video.buffered.end(i) - ct
      }
    }
    return 0
  }

  // 有效已缓冲时长（秒）：从当前播放位置往后，能「无需再下载」连续播出去的秒数。
  // 一片算「可播」的条件：已在 MSE 里（播放器已有）或在 JS 预取缓存里（一拖就命中）——
  // 两者都不需要再下载。逐片累加，直到遇到第一个「还需要下载」的分片（既不在 MSE 也没预取）为止。
  const getCachedAhead = (video: HTMLVideoElement): number => {
    const ct = anchorTime(video)   // 起播定位期间从 pendingStartPos 量起，反映恢复位置的真实缓冲
    const hls = opts.getHls()
    const level = hls && hls.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = (hls as any)?.levels?.[level]?.details?.fragments ?? []
    if (!frags.length) return getAheadBuffered(video)

    // 某时间点是否已落在 MSE 已缓冲区间内（已下载进播放器，无需再取）
    const inMSE = (t: number): boolean => {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.1 && t < video.buffered.end(i) + 0.1) return true
      }
      return false
    }

    let reach = ct
    for (const frag of frags) {
      if (frag.end <= ct + 0.1) continue                     // 播放头之前的分片，跳过
      if (frag.start > reach + 0.5) break                     // 与已达区间不连续（真空洞）→ 停
      const mid = (frag.start + frag.end) / 2
      const available = getPrefetchedBuf(frag.url) !== null || inMSE(mid)
      if (!available) break                                   // 该分片还需下载 → 停
      reach = frag.end                                        // 可播 → 延伸
    }
    return Math.max(0, reach - ct)
  }

  // 闭环控制步进（双指标各司其职）：
  //   · 健康区(healthZone)：按「真实 MSE 前向可播」(mseAhead) 分档——濒卡/吃紧/健康，驱动降速守卫与跳片。
  //   · 并发爬坡：按「有效已缓冲」(cachedAhead：MSE + 预取缓存) 决定下载激进度——
  //     缓存很少→拉满猛下；偏低/在掉→+1；接近预取目标→−1 省带宽。
  //   分开的原因：并发只影响「下载」，缓存足了再多线程也没用（如 MSE 小但缓存巨大时，瓶颈在 append 非下载）；
  //   而卡不卡只看 MSE。阈值全取自当前档位。
  const stepControl = (mseAhead: number, cachedAhead: number) => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()   // 冷启动用实测估算作初值
    const t = tier()
    // 健康区：真实可播秒数决定是否濒卡（触发降速/跳片，由 video-player 消费）
    lastHealthZone = mseAhead < t.panicSecs ? 'panic' : (mseAhead < t.lowSecs ? 'low' : 'healthy')
    // 并发爬坡：按有效缓存趋势
    const drained = lastAhead >= 0 && cachedAhead < lastAhead - 0.5
    lastAhead = cachedAhead
    const target = effectivePrefetchTarget()
    if (cachedAhead < t.panicSecs) ctrlConn = hostConcurrencyCap                                    // 缓存极少：拉满猛下
    else if (cachedAhead < t.lowSecs || drained) ctrlConn = Math.min(hostConcurrencyCap, ctrlConn + 1) // 偏低/在掉：加
    else if (Number.isFinite(target) && cachedAhead > target * 0.75) ctrlConn = Math.max(2, ctrlConn - 1) // 接近目标：省
    // 中间且未在掉：维持
  }

  // 返回当前目标并发（受控值，双重钳制在 [2, hostCap]）。只读，供两个预取入口共用。
  // 注意：永远保持并行预取后续分片，绝不因当前分片慢而停掉后面的（否则退化成串行/卡死）。
  const getAdaptivePrefetchCount = (cachedAhead?: number): number => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()
    // 暂停时带宽全空闲 → 顶格并发猛缓存后续分片（下到 JS 预取缓存，恢复播放即命中）。
    // 播放时按闭环受控值走，钳制在 [floor, hostCap]。
    const paused = opts.getVideoEl()?.paused ?? false
    let target = paused ? hostConcurrencyCap : Math.min(hostConcurrencyCap, Math.max(floorConn(), ctrlConn))
    // 仅当「聚合不随线程增长」(每 IP 硬顶) 且吃紧时才收敛到 3 线程：此时多开连接只是分摊同一份带宽，
    // 集中拿播放头紧邻分片更快恢复。可并行(每连接限速)时相反——低缓冲更该多开线程做满聚合，不收敛。
    if (cachedAhead !== undefined && cachedAhead < tier().lowSecs && !getAggregateScales()) {
      target = Math.min(target, LOW_BUFFER_MAX_CONN)
    }
    refreshStrategy(target)
    return target
  }

  // 不限制预取"触达距离"：始终让 count 个连接并行下载最近的 count 个未缓存分片。
  // （近处慢时远处也照下，保持并行聚合吞吐；否则退化成串行，太慢。）

  // 创建自定义 HLS 分片加载器（fLoader）
  // 优先从预取缓存返回数据，cache miss 时走 fetch 正常加载
  const createHlsFragLoader = () => {
    return class PrefetchFragLoader {
      context: any
      // hls.js 在创建 loader 实例后立刻执行 frag.stats = loader.stats，
      // 时机早于 load() 调用。若此处不提前初始化，frag.stats 会是 undefined，
      // AbrController 的 setInterval 轮询时读 frag.stats.loading 直接崩溃。
      stats: any = {
        aborted: false, loaded: 0, total: 0,
        retry: 0, chunkCount: 0, bwEstimate: 0,
        loading:   { start: 0, first: 0, end: 0 },
        parsing:   { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      private ctrl: AbortController | null = null

      load(context: any, config: any, callbacks: any): void {
        this.context = context
        const url: string = context.url
        const t0 = performance.now()

        // 重置 stats 字段（必须原地修改，不能替换整个对象）
        // frag.stats 持有的是同一个对象引用，替换会导致 frag.stats 仍指向旧的 undefined
        this.stats.aborted = false
        this.stats.loaded = 0
        this.stats.total = 0
        this.stats.retry = 0
        this.stats.chunkCount = 0
        this.stats.bwEstimate = 0
        this.stats.loading.start = t0
        this.stats.loading.first = 0
        this.stats.loading.end   = 0
        this.stats.parsing.start = 0
        this.stats.parsing.end   = 0
        this.stats.buffering.start = 0
        this.stats.buffering.first = 0
        this.stats.buffering.end   = 0

        const succeed = (data: ArrayBuffer) => {
          // seek/换源后 hls.js 会 abort 旧 loader；此时再回调 onSuccess
          // 会污染 hls.js 的内部状态，让播放卡住几十秒。必须在这里短路。
          if (this.stats.aborted) return
          const t1 = performance.now()
          this.stats.loaded = data.byteLength
          this.stats.total  = data.byteLength
          this.stats.chunkCount = 1
          if (!this.stats.loading.first) this.stats.loading.first = t0 + 1
          this.stats.loading.end = t1
          callbacks.onSuccess({ data, url }, this.stats, context)
        }

        const fail = (e: Error) => {
          if (this.stats.aborted) return
          this.stats.loading.end = performance.now()
          callbacks.onError({ code: 0, text: e.message }, context, null, this.stats)
        }

        // 1. 命中预取缓存（且未过期）→ 即时返回，并刷新 LRU 顺序与访问时间
        const cachedBuf = getPrefetchedBuf(url)
        if (cachedBuf) {
          segPrefetchCache.delete(url)
          segPrefetchCache.set(url, { buf: cachedBuf, ts: Date.now() })
          prefetchInfo.value.cached = segPrefetchCache.size
          succeed(cachedBuf)
          return
        }

        // 2 & 3. 关键分片（hls.js 正在等的这片，直接决定能不能播）→ 限时保障加载：
        //   对冲竞速（换连接绕开死连接）+ 硬超时跳过（绝不整段冻结）。见 hedgedLoad。
        this.hedgedLoad(url, context, succeed, fail)
      }

      // 关键分片加载：一条不行就再起一条并行抢，谁先回用谁；久拿不到就跳过。
      //   · 已有预取在途 → 先让它参与竞速（不新开连接），但只等 hedgeMs，不无限等死连接；
      //   · 每 hedgeMs 追加一条新连接并行竞速（对冲单条死连接）；单条失败立刻换一条重试；
      //   · skipMs 仍拿不到 → 跳过该片（挪播放头到下一片），避免多分钟冻结。（超时值取自当前档位）
      private hedgedLoad(url: string, context: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void) {
        if (this.stats.aborted) return
        let settled = false
        let racers = 0
        const ctrls: AbortController[] = []
        const timers: ReturnType<typeof setTimeout>[] = []
        const cleanup = () => {
          timers.forEach(clearTimeout)
          ctrls.forEach(c => { try { c.abort() } catch {} })
          segInflightStart.delete(url)
        }
        this._cancelHedge = () => { if (!settled) { settled = true; cleanup() } }

        const win = (buf: ArrayBuffer) => {
          if (settled || this.stats.aborted) return
          settled = true
          cleanup()
          segPrefetchCache.set(url, { buf, ts: Date.now() })   // 存缓存，后续命中不再下载
          segPrefetching.delete(url)
          prefetchInfo.value.cached = segPrefetchCache.size
          prefetchInfo.value.pending = segPrefetching.size
          evictPrefetchCache()
          if (!this.stats.loading.first) this.stats.loading.first = performance.now()
          succeed(buf)
        }

        const tp = tier()   // 本次加载用当前档位的对冲/跳片超时（hedgeMs/skipMs/maxRacers）
        // 起一条新竞速连接（换 lane、换连接，绕开卡死的那条）
        const race = () => {
          if (settled || this.stats.aborted || racers >= tp.maxRacers) return
          racers++
          const ctrl = new AbortController(); ctrls.push(ctrl)
          const { lane, laneUrl } = acquireLane(url)
          const t = performance.now()
          if (!segInflightStart.has(url)) segInflightStart.set(url, t)   // 计时：登记在途（诊断用）
          const conc = racers   // 采样时的并发（竞速条数），供聚合可并行探针分档
          fetch(laneUrl, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); if (!this.stats.loading.first) this.stats.loading.first = performance.now(); return r.arrayBuffer() })
            .then(buf => { releaseLane(lane); sampleSpeed(buf.byteLength, performance.now() - t, conc); win(buf) })
            .catch(() => { releaseLane(lane); if (!settled && !this.stats.aborted) timers.push(setTimeout(race, 500)) })  // 这条失败 → 快速换一条
        }

        // 已有预取在途：先让它竞速（省一条连接），但别无限等——hedgeMs 后照常追加新连接抢
        const pf = segPrefetching.get(url)
        if (pf) pf.then(buf => { if (buf && buf.byteLength > 0) win(buf) }).catch(() => {})
        else race()

        timers.push(setTimeout(race, tp.hedgeMs))         // 还没赢 → 加一条并行（对冲死连接）
        timers.push(setTimeout(race, tp.hedgeMs * 2))     // 再加一条
        timers.push(setTimeout(() => {                    // 硬超时 → 跳过，别冻结
          if (settled || this.stats.aborted) return
          settled = true
          cleanup()
          const skipped = skipSegment(context?.frag)
          fail(new Error(skipped ? 'segment skipped (too slow)' : 'segment fetch timeout'))
        }, tp.skipMs))
      }

      private _cancelHedge: (() => void) | null = null
      abort(): void {
        this.ctrl?.abort()
        this._cancelHedge?.()
        if (this.stats) this.stats.aborted = true
      }
      destroy(): void { this.abort() }
    }
  }

  // 发起一个分片预取请求（带 1 次轻量重试，减少「空洞」导致的临播卡顿）
  // durationSec = 该分片代表的视频秒数，用于实测码率
  const PREFETCH_TIMEOUT_MS = 300000   // 单分片下载上限(5分钟)：无此保护会导致个别卡死连接永久占位，形成永不填补的「缓冲缺口」
  const spawnPrefetch = (url: string, durationSec: number, onDone: () => void) => {
    const attemptFetch = (attempt: number): Promise<ArrayBuffer> => {
      const ctrl = new AbortController()
      segPrefetchAborts.set(url, ctrl)
      const timer = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS)
      const aStart = performance.now()
      const { lane, laneUrl } = acquireLane(url)   // 直连/代理分流：取在途最少的 lane
      segInflightStart.set(url, aStart)            // 计时：登记在途（重试则刷新起点）
      const conc = segPrefetching.size             // 采样时的在途并发数，供聚合可并行探针分档
      return fetch(laneUrl, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(buf => { clearTimeout(timer); releaseLane(lane); sampleSpeed(buf.byteLength, performance.now() - aStart, conc); return buf })
        .catch(e => {
          clearTimeout(timer); releaseLane(lane)
          if (e?.name === 'AbortError' || attempt >= 1) throw e
          return new Promise<ArrayBuffer>((resolve, reject) => {
            setTimeout(() => {
              // seek 后 abortAllPrefetches 会清空 segPrefetching；此时不再重试，避免占用连接池
              if (!segPrefetching.has(url)) { reject(new DOMException('aborted', 'AbortError')); return }
              attemptFetch(attempt + 1).then(resolve, reject)
            }, 400)
          })
        })
    }
    const promise = attemptFetch(0)
      .then(buf => {
        sampleBitrate(buf.byteLength, durationSec)   // 实测视频码率
        segInflightStart.delete(url)
        segPrefetchAborts.delete(url)
        segPrefetchCache.set(url, { buf, ts: Date.now() })
        segPrefetching.delete(url)
        prefetchInfo.value.cached = segPrefetchCache.size
        prefetchInfo.value.pending = segPrefetching.size
        evictPrefetchCache()
        onDone()
        return buf
      })
      .catch(() => {
        segInflightStart.delete(url)
        segPrefetchAborts.delete(url)
        segPrefetching.delete(url)
        prefetchInfo.value.pending = segPrefetching.size
        return new ArrayBuffer(0)
      })
    segPrefetching.set(url, promise)
  }

  // 触发自适应预取（每次 FRAG_BUFFERED 后调用）
  const triggerAdaptivePrefetch = (lastFragSn: number) => {
    const hls = opts.getHls()
    const video = opts.getVideoEl()
    if (!hls || !video) return

    // 取当前画质的分片列表
    const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
    const levelDetails = (hls as any).levels?.[level]?.details
    if (!levelDetails) return

    const frags: any[] = levelDetails.fragments
    const startIdx = frags.findIndex((f: any) => f.sn === lastFragSn) + 1
    if (startIdx <= 0) return

    // 探测未来分片的 host 分布：多 CDN 时放宽并发上限（每 host 6 连接，封顶 12）
    const lookahead = frags.slice(startIdx, startIdx + 24)
    const hosts = new Set<string>()
    for (const f of lookahead) { try { hosts.add(new URL(f.url).host) } catch {} }
    hostConcurrencyCap = Math.min(12, Math.max(1, hosts.size) * MAX_CONN)
    // 双通道：代理是额外一个 origin（本站），再加 6 条（封顶 12）
    if (getLaneCount(lookahead[0]?.url) > 1) hostConcurrencyCap = Math.min(12, hostConcurrencyCap + MAX_CONN)

    // 双指标：mseAhead（真实可播）驱动健康区/降速/跳片；cachedAhead（含预取缓存）驱动并发爬坡与停取。
    const mseAhead = getAheadBuffered(video)
    const cachedAhead = getCachedAhead(video)
    stepControl(mseAhead, cachedAhead)             // 闭环：健康区按 MSE、并发按缓存
    let count = getAdaptivePrefetchCount(cachedAhead)
    if (cachedAhead >= effectivePrefetchTarget()) count = 0   // 已达有效预取深度 → 停止预取

    prefetchInfo.value = {
      bufferSecs: Math.round(mseAhead * 10) / 10,   // 「缓冲健康」仍展示 MSE 即时窗口
      threads: count,
      cached: segPrefetchCache.size,
      pending: segPrefetching.size,
    }

    if (count === 0) return

    // 计算还能发起几个新请求（不超过并发上限）
    const canStart = Math.max(0, count - segPrefetching.size)
    if (canStart === 0) return

    // 候选窗口：从 startIdx 往后扫描，最多看 count*3 个，足以跳过已缓存/下载中的
    const candidates = frags.slice(startIdx, startIdx + count * 3)

    const ct = anchorTime(video)
    let started = 0
    for (const frag of candidates) {
      if (started >= canStart) break
      if (frag.start < ct - 1) continue   // 跳过锚点之前的旧分片（seek 后 lastFragSn 可能是旧位置）
      const url: string = frag.url
      if (!url || getPrefetchedBuf(url) !== null || segPrefetching.has(url)) continue   // 已缓存/下载中 → 不重复下载
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      started++
    }

    prefetchInfo.value.pending = segPrefetching.size

    // 按内存上限 LRU 淘汰（在新分片加入后检查）
    evictPrefetchCache()
  }

  // 完成1个分片后补充1个，基于当前播放进度定位下一个未下载分片
  const startOnePrefetch = () => {
    const hls = opts.getHls()
    const video = opts.getVideoEl()
    if (!hls || !video) return
    const mseAhead = getAheadBuffered(video)
    const cachedAhead = getCachedAhead(video)
    let count = getAdaptivePrefetchCount(cachedAhead)
    if (cachedAhead >= effectivePrefetchTarget()) count = 0   // 已达有效预取深度 → 停止预取

    prefetchInfo.value.bufferSecs = Math.round(mseAhead * 10) / 10
    prefetchInfo.value.threads = count
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.pending = segPrefetching.size

    if (count === 0 || segPrefetching.size >= count) return

    const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = (hls as any).levels?.[level]?.details?.fragments ?? []
    if (!frags.length) return

    // 从锚点（起播定位期间=pendingStartPos，否则=播放头）往后找第一个未缓存、未下载中的分片
    const currentTime = anchorTime(video)
    for (const frag of frags) {
      if (frag.start < currentTime) continue
      const url: string = frag.url
      if (!url || getPrefetchedBuf(url) !== null || segPrefetching.has(url)) continue   // 已缓存/下载中 → 不重复下载
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      prefetchInfo.value.pending = segPrefetching.size
      break  // 只补1个
    }
  }

  // 实时心跳：由定时器/视频事件驱动（不依赖 FRAG_BUFFERED，避免卡顿时停更）。
  // 刷新缓冲读数、跑闭环控制、把在途预取补足到目标并发。
  const tick = () => {
    const video = opts.getVideoEl()
    if (!video) return
    const mseAhead = getAheadBuffered(video)
    const cachedAhead = getCachedAhead(video)
    stepControl(mseAhead, cachedAhead)
    let count = getAdaptivePrefetchCount(cachedAhead)
    if (cachedAhead >= effectivePrefetchTarget()) count = 0   // 已达有效预取深度 → 停止预取
    prefetchInfo.value.bufferSecs = Math.round(mseAhead * 10) / 10
    prefetchInfo.value.threads = count
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.pending = segPrefetching.size
    // 补足到目标并发（startOnePrefetch 同步占位，循环安全）
    let guard = 0
    while (segPrefetching.size < count && guard++ < count) {
      const before = segPrefetching.size
      startOnePrefetch()
      if (segPrefetching.size === before) break   // 没有可补的分片了
    }
  }

  // 起播/seek 预热：并行预取后续分片。
  const primePrefetch = () => {
    const video = opts.getVideoEl()
    const cachedAhead = video ? getCachedAhead(video) : 0
    let count = getAdaptivePrefetchCount(cachedAhead)
    if (cachedAhead >= effectivePrefetchTarget()) count = 0   // 已达有效预取深度 → 停止预取
    let guard = 0
    while (segPrefetching.size < count && guard++ < count) {
      const before = segPrefetching.size
      startOnePrefetch()
      if (segPrefetching.size === before) break
    }
  }

  return { getAheadBuffered, getCachedAhead, getAdaptivePrefetchCount, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick, primePrefetch, getStuckSegment }
}
