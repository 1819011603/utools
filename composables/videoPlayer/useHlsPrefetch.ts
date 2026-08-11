import type HlsType from 'hls.js'
import type { useSegmentCache } from './useSegmentCache'
import { SERVER_TIERS, DEFAULT_TIER, type ServerTier, type TierParams } from '../videoSiteRules'
import { useLaneControl } from './prefetch/lanes'
import { useBandwidthModel } from './prefetch/bandwidth'
import { createFragLoaderFactory } from './prefetch/fragLoader'
import { useBufferMeter } from './prefetch/bufferMeter'

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
  // 当前倍速（倍速越高需要越大带宽），默认 1
  getPlaybackRate?: () => number
  // 预取深度上限（秒）：真实前向缓冲达到此值即停止预取，默认 Infinity（不限）
  getPrefetchTargetSecs?: () => number
  // 起播锚点（秒）：恢复进度/刷新时，播放头还停在 0、但我们要起播的位置在 pendingStartPos。
  // 预取以 max(currentTime, 此值) 为起点——起播即在正确位置全力并行预取，既不浪费带宽下开头，
  // 也不会退化成「只有 hls.js 串行下 1 片」。播放头到位/用户跳转后返回 0（改用 currentTime）。默认 0。
  getStartPosition?: () => number
  // 「存货保险线」（秒，墙钟）：缓存够播的秒数低于它就按阶梯收敛并发（见 WALL_CONN_STEPS）。
  // 由「HLS 配置」里的 safeWallSecs 提供，不设则用兜底值。
  getSafeWallSecs?: () => number
  // 冷启动并发先验：按 host 学到的 bestConcurrency。切集/换流清掉实测样本后，
  // 阶梯的地板拿它兜住慢源（见 catchUpFloor）。0/不设 = 没学过，交给阶梯。
  getColdStartConn?: () => number
  // 连接 lane：返回同一分片在「不同 origin」下的多个 URL（如 [直连CDN, /api/proxy]）。
  // 浏览器 per-origin 只给 6 条连接，分属两个 origin 即可并行 ~12 条。默认单 lane（当前 getProxyUrl 结果）。
  getLaneUrls?: (url: string) => string[]
  // 当前服务器档位参数（好/中/差预设 + 页面覆盖）。不设则用中档兜底。
  // 抗卡阈值(panicSecs/lowSecs)、安全系数、对冲/跳片超时、并发下限、预取深度全从这里读。
  getTierParams?: () => TierParams
  /**
   * 上一次**真实卡顿**的时间戳（`Date.now()`，0=没卡过）。来自 useStallTracker——
   * 它以 `<video>` 的实际停顿为地面真值（排除 seek 与用户 pause），比任何带宽估算都可信，
   * 所以卡顿守卫排在缺口/聚合那些「省流量」的判据前面（见 stallGuard）。
   */
  getLastStallAt?: () => number
}

export interface StrategySnapshot {
  perConnKBps: number     // 实测每连接速度
  segMbps: number         // 实测视频码率
  targetConn: number      // 当前目标并发
  maxFluentRate: number   // 当前带宽最高可流畅倍速
  aggregateScales: boolean // 聚合是否随线程增长（true=每连接限速可并行；false=每IP硬顶不可并行）
  healthZone: HealthZone  // 缓冲健康区（按「有效可播」分档，panic 触发抗卡降速）
  playableSecs: number    // 有效可播秒数（MSE + 预取缓存），倍速决策的经验依据
  avgSegLoadMs: number    // 一片平均下载耗时（ms）：判「每连接够不够快」比看瞬时速度直观
  aggKneeConn: number     // 实测到的聚合拐点并发（0=还没见到拐点）
}

const MAX_CONN = 6               // 浏览器同 host 连接上限（HTTP/1.1，硬顶）
/**
 * 「存货保险线」：手上的缓存还够播几秒。它是并发阶梯（WALL_CONN_STEPS）的标尺。
 *
 * **判据是墙钟秒数（缓存秒数 ÷ 倍速），不是缓存秒数**——3x 下缓存 6 秒只够播 2 秒。
 * 与起播门槛（见 useVideoEvents.autoPlayTarget）用的是同一把尺子。
 *
 * 为什么存货少反而要少开线程（反直觉，但实测如此）：决定「现在能不能播下去」的只有紧邻
 * 播放头那一两片，而浏览器同 host 只给 6 个连接槽。多开的每一条都在下更远的分片，
 * 却要跟那一片抢连接和带宽——**越缺越多开，最需要的那一片反而越晚到**。
 * 用户截图里就是这么坏的：源站被判「差」档（那时档位还带并发下限 6）、标着「可并行」，
 * 卡到已缓冲 0.3s 仍在跑 6 线程，而聚合速度 2.10 MB/s（16.8 Mbps）是码率 2.1 Mbps 的八倍
 * ——带宽压根不是瓶颈，摊薄才是。
 *
 * 这一条统一覆盖三种场景（刚起播 / 刚拖完进度 / 播着播着要卡了）：它们的共同点正是
 * 「存货不够播 5 秒」。所以不需要另做一个「起播窄口」计时器——那种时间窗口既要上膛又要解除，
 * 上膛早了会在真正开始要分片之前就烧完（踩过）。
 *
 * 注意它只管**预取**：hls.js 正在等的那一片走 fLoader 的对冲竞速（hedgedLoad），
 * 该抢连接时照样抢，不受这里限制。
 *
 * 这条线可在「HLS 配置」里调（`hlsConfig.safeWallSecs`），这里的 5 只是没配置时的兜底。
 */
const SAFE_WALL_SECS = 5
/**
 * 存货（够播几秒）→ 预取并发上限的阶梯，倍数是相对「存货保险线」的。
 * 读法：`wall < safe × 倍数` 就取该档的上限；全都不满足才放开（交给闭环 + 缺口上限）。
 *
 * **过线之后还要再压两档，不能一跨过保险线就放开**：保险线以下已经被压到 2~3 条，
 * 而闭环的受控值此时往往已经爬到顶（12），一放开就是「2 条 → 12 条」的跳变
 * ——刚补起来几秒存货就立刻把连接全占满，把紧邻播放头那一片又挤回去，缓冲原地塌回来。
 * 所以保险线 ~ 2 倍保险线这一段封在 4~6 条（默认 5s 线 → 5~7.5s 给 4 条、7.5~10s 给 6 条），
 * 存货攒到 2 倍保险线以上才放开。
 *
 * 阶梯只有一个可调量：「HLS 配置」里的存货保险线。填 0/负数 = 整条阶梯关闭（见 wallConnCap）。
 */
const WALL_CONN_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0.4, 2],   // 濒卡：不足保险线的 40% → 只留 2 条，其余带宽全让给眼前那一片
  [1.0, 3],   // 不足保险线 → 3 条
  [1.5, 4],   // 刚跑过保险线 → 4 条
  [2.0, 6],   // 再宽裕一档 → 6 条
]
/**
 * 量不到分片时长时的兜底值（秒）。只在冷启动那一两拍生效——那时缓存≈0、下面的
 * 「还差多少」远大于一片，这条上限压根不咬人，取多少都无所谓。
 */
const FALLBACK_SEG_SECS = 10
/**
 * 缺口的补齐期限（墙钟秒）：把「还差多少缓存」摊到这么多秒里补，而不是要求下一拍就填满。
 *
 * 这个数决定的是**斜坡有多缓**：小了就退化成「差一点也顶格猛下」（本来要治的就是这个），
 * 大了则接近目标时补得太慢、遇到带宽波动容易被吃穿。60s 的实际含义是
 * 「缺口相当于一分钟播放量时，只多开一倍于维持播放所需的线程」。
 */
const FILL_HORIZON_SECS = 60

/**
 * 「存货厚到可以躺着花」的墙钟余量（秒）：超过「存货阶梯放开线 + 它」就给到满折扣（见 headroomConnCap）。
 * 取 20s —— 阶梯放开线（默认 10s 墙钟）之上再攒够 20 秒，才算真的有余量可花。
 * 调大 = 更保守（更愿意为钉住预加载时长而多开连接），调小 = 更省连接、缓存更愿意往下滑。
 */
const COAST_WALL_SECS = 20

/**
 * 折扣的**收尾窗口**（墙钟秒）：缺口还够播这么久以上时，折扣一律为 0（全额供给）。
 *
 * 由来（踩过）：折扣只看「存货厚不厚」（`COAST_WALL_SECS`）时，任何缓了半分钟以上的流都拿满折
 * 0.9，于是 `needRate = rate×0.1 + gap/60`，解 `needRate = rate` 得**平衡点恒在
 * `预加载时长 − 0.9×rate×FILL_HORIZON`**（1x 下就是 −54s）——跟用户填多少无关。
 * 实测正是「预加载 300s，缓存卡在 240s 上不上下不下」：那不是慢，是折扣把供给正好抵成了持平。
 *
 * 折扣的立论只在「缺口已经很小」时成立（当初那个例子是 100s 里差 2s）。所以把它按
 * **缺口墙钟秒**线性淡入：缺口 ≥ 本窗口 → 折扣 0（照常往上补），缺口 → 0 → 给到满折
 * （不为把数字钉死在目标值而拉满连接，那才是本来要治的毛病）。
 * 新的平衡点解 `0.9(1 − gw/10)×FILL_HORIZON = gw` 得 gw ≈ 8.4s 墙钟，即缓存收在
 * 「预加载时长 − 8 秒左右」而不是 −54s，且**是一路缓慢爬上去的**。
 * 用墙钟而不是视频秒：3x 下 10 视频秒只值 3.3 秒余量，两边尺子要跟折扣本身一致。
 */
const COAST_GAP_WALL_SECS = 10

/**
 * **冷启动并发硬帽：3 条，无论有没有双通道。**
 *
 * 「还没有任何实测样本」= 不知道这个源是快是慢、每连接扛不扛得动、聚合能不能并行。
 * 这种时候开一堆连接是拿**最需要的那一片**去赌：同 host 只有 6 个槽（双通道 12），
 * 多开的每一条都在下更远的分片，跟紧邻播放头那一片抢带宽——越不确定越该少开。
 * 3 条是「够试探出聚合能不能并行」（bandwidth 的低并发档要 ≤2、高并发档要 ≥5，
 * 3 条正好不污染两档）与「不摊薄第一片」之间的折中。
 * 一有样本立刻按实测放开，代价至多一两片。
 */
const COLD_START_CONN_CAP = 3

/**
 * 卡顿守卫的观察窗（ms）：这段时间内发生过真实卡顿就算「近期在卡」。
 * 取 20s——比一次抗卡动作的生效周期长，短于「换了个源/换了段网络」的时间尺度。
 */
const STALL_WINDOW_MS = 20_000

export function useHlsPrefetch(opts: HlsPrefetchOptions) {
  const { getProxyUrl, cache } = opts
  const getPlaybackRate = opts.getPlaybackRate ?? (() => 1)
  const getPrefetchTargetSecs = opts.getPrefetchTargetSecs ?? (() => Infinity)
  const getStartPosition = opts.getStartPosition ?? (() => 0)
  // 用户填 0/负数视为「关掉这条保险」——那时一律按闭环原有的爬坡走
  const getSafeWallSecs = (): number => {
    const v = opts.getSafeWallSecs?.()
    return typeof v === 'number' && v >= 0 ? v : SAFE_WALL_SECS
  }
  const getLaneUrls = opts.getLaneUrls ?? ((url: string) => [getProxyUrl(url)])
  // 档位参数：好/中/差预设，抗卡阈值/超时/安全系数全从这里取（默认中档）
  const tier = (): TierParams => opts.getTierParams?.() ?? SERVER_TIERS[DEFAULT_TIER]
  // 有效预取深度：只认用户「预加载时长」（maxBufferLength）。档位不收窄它——
  // 否则快源缓存一到档位深度就停、预取线程掉 0。想省内存请调小「预加载时长」。
  const effectivePrefetchTarget = (): number => getPrefetchTargetSecs()

  // 预取锚点：起播定位未到位时用 pendingStartPos，否则用真实播放头。所有「从哪往后预取」的判断都基于它。
  const anchorTime = (video: HTMLVideoElement): number => Math.max(video.currentTime, getStartPosition())

  // ── 连接 lane：负载均衡 + 熔断（实现见 ./prefetch/lanes.ts）──
  // fLoader（hls.js 自身分片）与预取共用同一个均衡器，避免两者各自打满同一个 origin。
  const laneControl = useLaneControl(getLaneUrls)
  const { laneDead, acquireLane, releaseLane, markLaneOk, markLaneFail, resetLanes, reviveLanes, getLaneCount } = laneControl

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
  // 跳过卡死的分片：把播放头挪到该分片之后，让 hls.js 从下一片重新加载（下一片多半已预取，秒恢复）。
  // 只在「确实卡在播放头附近」时跳，避免把提前缓冲的远处分片误当卡点跳掉。返回是否真的跳了。
  const skipSegment = (frag: any): boolean => {
    const video = opts.getVideoEl()
    if (!video || !frag) return false
    // 断网时跳片纯属有害：下一片同样下不来，跳一次就白扔一片缓存、画面还硬跳一下。
    // 什么都不做，等网络回来（见 useVideoEngine 的 online 处理）才是对的
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
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
    prefetchInfo, getPrefetchedBuf, evictPrefetchCache, purgeCache,
  } = cache

  // ── 实测采样：每连接速度 / 码率 / 聚合能否并行 / 最高流畅倍速（实现见 ./prefetch/bandwidth.ts）──
  const bw = useBandwidthModel()
  const { sampleSpeed, sampleBitrate, getAggregateScales } = bw

  const strategy = ref<StrategySnapshot>({ perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0, aggregateScales: true, healthZone: 'healthy', playableSecs: 0 })

  // 并发上限：默认单 host 6；多 CDN（分片跨多个 host）时按 host 数放宽（每 host 6，封顶 12）
  let hostConcurrencyCap = MAX_CONN

  // 闭环控制状态：以「缓冲是否在掉」为反馈调并发，比开环测速更抗卡顿、天然适配倍速
  let ctrlConn = 0                        // 当前受控并发（0=未初始化）
  let lastTargetConn = 0                  // 上一拍算出的目标并发（卡顿守卫拿它判「带宽够不够」）
  let lastAhead = -1                      // 上次的前向缓冲秒数
  let lastHealthZone: HealthZone = 'healthy'  // 健康区（驱动 UI 与降速守卫）
  let lastPlayable = 0                    // 上次量到的有效可播秒数（MSE + 预取缓存）
  let segDurSecs = 0                      // 实测分片时长（秒，0=还没量到）：一条线程下一片就补这么多缓存

  // 切换视频/CDN 时重置实测与控制器，避免用上个流的数据误判新流
  const resetStrategy = () => {
    bw.resetSamples()
    hostConcurrencyCap = MAX_CONN
    ctrlConn = 0
    lastTargetConn = 0
    lastAhead = -1
    lastHealthZone = 'healthy'
    lastPlayable = 0
    segDurSecs = 0
    resetLanes()
    segInflightStart.clear()
    strategy.value = { perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0, aggregateScales: true, healthZone: 'healthy', playableSecs: 0, avgSegLoadMs: 0, aggKneeConn: 0 }
  }

  // 实测驱动的目标并发：需要带宽 = 码率 × 倍速 × 安全系数；并发 = ⌈需要 / 每连接速度⌉
  const computeTargetConcurrency = (): number => {
    // 冷启动（切集/换流刚清掉样本）：乐观值 4 起步，但按 host 学到的并发更可信就用它
    // ——慢站上 4 条一样喂不动，而阶梯的地板已经放开了，这里不跟上就等于白学（见 catchUpFloor）
    // 冷启动：**一律不超过 COLD_START_CONN_CAP**。按 host 学到的并发只用来「不低于」，
    // 不再用来突破那个帽子——学到的是上次稳态的值，而此刻还没起播，处境完全不同
    if (!bw.hasSamples()) {
      return Math.min(hostConcurrencyCap, COLD_START_CONN_CAP, Math.max(2, opts.getColdStartConn?.() ?? 0))
    }
    const need = bw.requiredConn(getPlaybackRate(), tier().safety)
    return Math.min(hostConcurrencyCap, Math.max(2, need))
  }

  // 刷新对外策略快照（供 UI 展示与倍速可行性判断）
  const refreshStrategy = (targetConn: number) => {
    const sustainable = bw.maxFluentRate(hostConcurrencyCap, tier().safety, getPlaybackRate())
    strategy.value = {
      perConnKBps: bw.perConnKBps(),
      segMbps: bw.segMbps(),
      targetConn,
      maxFluentRate: sustainable,
      aggregateScales: getAggregateScales(),
      healthZone: lastHealthZone,
      playableSecs: Math.round(lastPlayable),
      avgSegLoadMs: bw.avgSegLoadMs(),
      aggKneeConn: bw.bestAggConn(),
    }
  }

  // 缓冲量测（实现见 ./prefetch/bufferMeter.ts）：
  //   getAheadBuffered = 仅 MSE（跳片用）；getCachedAhead = MSE + 预取缓存（分档/并发/倍速用）
  const { getAheadBuffered, getCachedAhead } = useBufferMeter({
    getHls: opts.getHls,
    getPrefetchedBuf,
    anchorTime,
  })

  // 闭环控制步进（两个指标都按「有效已缓冲」cachedAhead = MSE + 预取缓存 来判，但用途不同）：
  //   · 健康区(healthZone)：濒卡/吃紧/健康。**只驱动抗卡动作**（降速守卫、双通道自动开、
  //     预热放行、面板徽标），不再参与并发——并发的低位判据统一交给存货阶梯（WALL_CONN_STEPS）。
  //     两者单位本就不同：panicSecs/lowSecs 是视频秒，阶梯量的是「还够播几秒」的墙钟秒。
  //   · 并发爬坡：偏低/在掉→+1；接近预取目标→−1 省带宽。
  //
  // 健康区曾按「真实 MSE 前向」(mseAhead) 分档，理由是「卡不卡只看 MSE」。**这是错的**：
  // 预取缓存里的分片由 fLoader 同步返回，hls.js 拿到即 append，不需要任何网络等待。
  // 而 MSE 前向本身有天花板（maxBufferLength / 浏览器 MSE 配额），深缓存时它会长期停在几十秒的平台上
  // ——那是正常稳态，不是吃紧。按它分档的后果：有效可播 651s、真实卡顿 0 次的情况下仍判「吃紧」，
  // 降速守卫永远等不到 healthy 就永远不解除，「自动最佳倍速」被死锁在 1x（踩过）。
  // 真正只看 MSE 的是跳片，它自己量（见 skipSegment），不走健康区。
  const stepControl = (mseAhead: number, cachedAhead: number) => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()   // 冷启动用实测估算作初值
    const t = tier()
    // 有效可播秒数分档。mseAhead 参与取大只为兜底：无分片列表时 getCachedAhead 会退化成 MSE 读数
    const playable = Math.max(mseAhead, cachedAhead)
    lastPlayable = playable
    lastHealthZone = playable < t.panicSecs ? 'panic' : (playable < t.lowSecs ? 'low' : 'healthy')
    // 并发爬坡：按有效缓存趋势
    const drained = lastAhead >= 0 && cachedAhead < lastAhead - 0.5
    lastAhead = cachedAhead
    const target = effectivePrefetchTarget()
    // 这里曾有一句「cachedAhead < panicSecs → ctrlConn = hostConcurrencyCap」（缓存极少就拉满）。
    // 已删：那一刻存货阶梯本来就把实际并发压在 2~3 条，拉满只是把**受控值**顶到 12 存着，
    // 等存货一过保险线就原形毕露——表现是「刚补起来几秒就从 2 条直接跳到 12 条」（用户报的就是这个）。
    // 缺存货时该做的是让眼前那一片先到（阶梯负责），而不是先把受控值攒满。现在一律 +1 慢慢爬。
    if (cachedAhead < t.lowSecs || drained) ctrlConn = Math.min(hostConcurrencyCap, ctrlConn + 1)      // 偏低/在掉：加
    else if (Number.isFinite(target) && cachedAhead > target * 0.75) ctrlConn = Math.max(2, ctrlConn - 1) // 接近目标：省
    // 中间且未在掉：维持
  }

  /**
   * 阶梯的**地板**：慢源上「少开线程」的前提不成立，这里兜住。
   *
   * 阶梯的立论是「带宽不是瓶颈，摊薄才是」——快源确实如此。但源站真慢时（每连接喂不动码率、
   * 靠并行才凑得出吞吐），2 条连接连维持播放都不够，**存货永远涨不到 2 倍保险线，阶梯就永远不放开**
   * ——自锁。表现最狠的是切集/拖进度：缓存归零，正好落在阶梯最低那一档。
   *
   * 所以地板取「维持当前倍速播放所需的连接数 × 2」：×1 只够不掉队、存货原地不动，
   * ×2 才是「一边播一边以约 1 秒/秒的速度攒存货」。快源上 requiredConn=1 → 地板 2，
   * 等于阶梯原样生效（防摊薄的目的不受影响）；慢源上 requiredConn=6 → 地板顶到 hostCap，等于拉满。
   *
   * **切集/换流会清空实测样本**（`resetStrategy`，换 CDN 用旧数据必跑偏），那一刻没有 requiredConn 可算，
   * 于是退回按 host 学到的 `bestConcurrency`（自愈环连续流畅 20s+ 时每 30s 写一份）——
   * 它本身就是当时的目标并发，不再翻倍。学过的慢站第二次进来即刻高并发，不用先卡一片。
   * 都没有（生面孔第一片）就交给阶梯：先按 2 条把第一片让过去，一有样本立刻按实测放开，代价是一片。
   */
  const catchUpFloor = (): number => {
    const need = bw.hasSamples()
      ? bw.requiredConn(getPlaybackRate(), tier().safety) * 2
      : (opts.getColdStartConn?.() ?? 0)
    return Math.min(hostConcurrencyCap, Math.max(0, need))
  }

  /** 存货阶梯（表见 WALL_CONN_STEPS）：wall = 还够播几秒。保险线填 0/负数 = 关掉整条阶梯 */
  const wallConnCap = (wall: number, safe: number): number => {
    if (safe <= 0) return hostConcurrencyCap
    for (const [ratio, cap] of WALL_CONN_STEPS) {
      if (wall < safe * ratio) return Math.max(cap, catchUpFloor())   // 地板兜住慢源，见 catchUpFloor
    }
    return hostConcurrencyCap
  }

  /**
   * 「还差多少就到预加载时长」换算出的并发上限。判据是**速率**，不是「缺口装得下几片」：
   *
   *     需要的吞吐 = 播放消耗（倍速）+ 缺口 ÷ 补齐期限
   *     线程数     = 需要的吞吐 × 码率 × 安全系数 ÷ 每连接实测速度    ← 就是 bw.requiredConn
   *
   * 按「缺口 ÷ 分片时长」算（本函数第一版）等于要求**下一拍就把缺口填满**，于是缺口一大就必然顶格；
   * 可缓存的意义本来就是「慢慢补上去也行」——只要补的速度快过播放消耗，缺口就在收窄。
   * 摊到 FILL_HORIZON_SECS 秒里补，线程数才跟「实际还差多少速度」挂钩，而不是跟「还差多少存量」。
   *
   * 它顺带自动含住了「一片要下多久」：每连接慢（一片要下好几秒）时 requiredConn 本来就大，
   * 快时就小，不必再单独量下载耗时。
   *
   * 两条性质：
   *  · **绝不会低于维持播放所需**（公式里播放消耗那项是全额的），所以这条上限压不出卡顿；
   *    缺口→0 时它正好收敛到「刚够跟上播放」的线程数（快源 1 条，慢源该几条给几条）。
   *  · 于是缓存稳稳停在预加载时长附近：不冲过头（多下的迟早被停取判定或 LRU 淘汰），
   *    缺口一张开线程也立刻跟着张开。**没有「充足」阈值可调**，目标就是用户填的预加载时长。
   *
   * 全程用「视频秒 / 墙钟秒」这个无量纲比值（倍速、缺口÷期限都是它），跟抗卡那两档
   * （墙钟「够播几秒」）各用各的尺子——两者管的是相反方向。
   *
   * 它**必须排在「暂停→顶格」之后**：预加载时长 100s、已有 98s 却钉在 6/12 条，就是档位那个
   * 已删掉的「并发下限 6」和「暂停→顶格」把闭环那句「接近目标就 −1」压回去了（踩过）。
   */
  const headroomConnCap = (cachedAhead: number): number => {
    const target = effectivePrefetchTarget()
    if (!Number.isFinite(target)) return hostConcurrencyCap   // 没设预加载时长 → 这条不参与
    const gap = target - cachedAhead
    if (gap <= 0) return 0                                     // 已到目标（上层还会再判一次停取）
    // 还没测出速度：退回「缺口装得下几片」。冷启动时缺口远大于一片，等于不限；
    // 但这样「快满了还开满线程」这个毛病就不依赖采样数据也不会犯
    if (!bw.hasSamples()) return Math.max(1, Math.ceil(gap / (segDurSecs || FALLBACK_SEG_SECS)))

    /*
     * 手上存货厚的时候，「播放消耗」那一项可以**打折**——余量本来就是拿来花的。
     *
     * 由来（实测）：预加载时长 100s、已经缓存 98s，线程却顶到 12。缺口只有 2s，
     * 摊到 60s 里补，那一项贡献 2/60 ≈ 0.03，**12 条全是「维持 3x 播放」算出来的**：
     * 慢源上每连接扛不动 3 倍码率，要不掉队就得这么多条。算式没错，但那一刻它答错了问题——
     * 已经攒下 98s÷3x ≈ 33 秒墙钟的余量，根本没必要为了把数字钉在 100 而拉满连接；
     * 少供一点、让缓存慢慢往下滑才是对的，滑到接近保险线时再全额补。
     *
     * 折扣按**墙钟余量**给（不是按视频秒——3x 下 98 视频秒只值 33 秒墙钟）：
     * 从「存货阶梯放开线」（保险线 ×2）起算，再多出 COAST_WALL_SECS 就给到满折。
     * 封顶 0.9 而不是 1：始终留一点供给，免得存货厚时干脆一条不开、跌下来又猛开的锯齿。
     * 余量掉回放开线以下时折扣归零 → 回到全额供给，所以这条仍然压不出卡顿。
     *
     * **但光看「存货厚不厚」会把平衡点永久钉在目标值下方**（`COAST_GAP_WALL_SECS` 那段注释里的
     * 300→240）：所以再乘一道「缺口快没了」的淡入系数，缺口还有 10 秒墙钟以上时折扣为 0，
     * 缓存于是一路缓慢往上爬，直到贴着目标值才开始躺着花。
     */
    const rate = getPlaybackRate()
    const wall = cachedAhead / Math.max(1, rate)          // 还够播几秒（墙钟）
    const releaseWall = Math.max(0, getSafeWallSecs()) * 2 // 存货阶梯的放开线，低于它一律全额供
    const thick = Math.min(0.9, Math.max(0, (wall - releaseWall) / COAST_WALL_SECS))
    const gapWall = gap / Math.max(1, rate)                          // 缺口还够播几秒（墙钟）
    const nearTarget = Math.max(0, 1 - gapWall / COAST_GAP_WALL_SECS) // 缺口 ≥10s 墙钟 → 不打折
    const credit = thick * nearTarget
    const needRate = rate * (1 - credit) + gap / FILL_HORIZON_SECS
    return Math.max(1, bw.requiredConn(needRate, tier().safety))
  }

  /**
   * 卡顿守卫：**卡顿是地面真值，比任何估算都可信**，所以它排在缺口/聚合那些「省流量」的判据前面。
   *
   * 但「卡了该加线程还是该减线程」没有唯一答案，取决于卡在哪：
   *   · **聚合速度已经够喂**（≥ 码率 × 倍速 × 安全系数）却还在卡 → 是**摊薄**：
   *     带宽不是瓶颈，是那 N 条连接把槽位和带宽摊给了远处的分片，紧邻播放头那一片反而最晚到。
   *     这时要**减到 2~3 条**，把资源让给眼前那一片。（实测截图：聚合 16.8Mbps、码率 2.1Mbps，
   *     跑着 6 线程却卡到已缓冲 0.3s。）
   *   · **聚合速度喂不动** → 是**真慢**：少开线程只会更慢，这时反过来把地板抬到 hostCap，
   *     能开多少开多少（慢源、拖进度后最常见）。
   * 判据用聚合而不是单连接速度：单连接慢但能并行的源（每连接限速的 CDN）恰恰要多开。
   * 单连接速度的位置在 requiredConn 里——它决定「喂饱需要几条」，是上面那个比较的分母。
   *
   * 返回 `{ cap, floor }`：不卡时两边都不咬人（cap=hostCap、floor=0）。
   */
  const stallGuard = (): { cap: number; floor: number } => {
    const stalledAt = opts.getLastStallAt?.() ?? 0
    const recentlyStalled = stalledAt > 0 && Date.now() - stalledAt < STALL_WINDOW_MS
    if (!recentlyStalled || !bw.hasSamples()) return { cap: hostConcurrencyCap, floor: 0 }
    // 「喂饱要几条」× 当前每连接速度 = 需要的聚合；拿实测聚合跟它比
    const need = bw.requiredConn(getPlaybackRate(), tier().safety)
    const bandwidthEnough = need <= Math.max(1, lastTargetConn)
    return bandwidthEnough
      ? { cap: 3, floor: 0 }                       // 摊薄型：收紧，让眼前那一片先到
      : { cap: hostConcurrencyCap, floor: hostConcurrencyCap }  // 真慢型：能开多少开多少
  }

  /**
   * 聚合拐点帽：**加线程却没换来吞吐，就别再加**（每 IP 限总量的源）。
   *
   * 数据来自 bandwidth 的 `aggByConn`（按并发档记聚合成绩）。拿到拐点后封在 `bestConn + 1`：
   * 留一档继续试探，网络变好时还能爬回去；锁死在最优档的话，一次偶发抖动就把上限永久压住了。
   */
  const aggregateKneeCap = (): number => {
    const knee = bw.bestAggConn()
    return knee > 0 ? Math.min(hostConcurrencyCap, knee + 1) : hostConcurrencyCap
  }

  // 返回当前目标并发（受控值，双重钳制在 [2, hostCap]）。只读，供两个预取入口共用。
  // 注意：永远保持并行预取后续分片，绝不因当前分片慢而停掉后面的（否则退化成串行/卡死）。
  const getAdaptivePrefetchCount = (cachedAhead?: number): number => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()
    // 暂停时带宽全空闲 → 顶格并发猛缓存后续分片（下到 JS 预取缓存，恢复播放即命中）。
    // 播放时按闭环受控值走，钳制在 [2, hostCap]。
    //
    const paused = opts.getVideoEl()?.paused ?? false
    let target = paused ? hostConcurrencyCap : Math.min(hostConcurrencyCap, ctrlConn)
    // 下面两条都排在「暂停→顶格」之后，好压过它：
    //   · 存货阶梯：还够播几秒 → 2/3/4/6 条，过 2 倍保险线才放开（见 WALL_CONN_STEPS）。
    //     起播那一刻正是「还没 play() 所以 paused 为真」+「缓存为 0」同时成立，压不住就是满并发抢第一片。
    //   · 快到预加载时长 → 按「播放消耗 + 缺口摊到 60s 补」所需的速率收（见 headroomConnCap）。
    /*
     * ── 并发决策的优先级阶梯 ──
     * 一律取 min（除了最后那道地板），**越靠前越「救命」，越靠后越只是「省」**：
     *   ① 冷启动帽    没有任何实测 → ≤3，无论双通道（拿第一片去赌是最亏的）
     *   ② 存货墙钟    还够播几秒 → 2/3/4/6（「现在能不能播下去」压倒一切）
     *   ③ 卡顿守卫    真卡过 → 摊薄型收紧到 3 / 真慢型抬地板到 hostCap
     *   ④ 聚合拐点    加线程不涨吞吐 → 封在拐点 +1
     *   ⑤ 缺口速率    接近预加载时长 → 按所需速率收（headroomConnCap，只省流量）
     *   ⑥ 地板        慢源兜底：catchUpFloor / 卡顿守卫的 floor（防「越缺越不敢开」自锁）
     */
    if (!bw.hasSamples()) target = Math.min(target, COLD_START_CONN_CAP)     // ①
    if (cachedAhead !== undefined) {
      const wall = cachedAhead / Math.max(1, getPlaybackRate())
      target = Math.min(target, wallConnCap(wall, getSafeWallSecs()))        // ②（内含 catchUpFloor 地板）
      const guard = stallGuard()                                            // ③
      target = Math.min(target, guard.cap)
      target = Math.min(target, aggregateKneeCap())                         // ④
      target = Math.min(target, headroomConnCap(cachedAhead))               // ⑤
      // ⑥ 地板只在「真慢型卡顿」时抬——它要压过上面所有的收紧，否则慢源永远补不回来。
      //    冷启动帽不受它影响：那时没样本，stallGuard 直接返回不咬人的值
      target = Math.max(target, Math.min(hostConcurrencyCap, guard.floor))
    }
    lastTargetConn = target
    refreshStrategy(target)
    return target
  }

  // 不限制预取"触达距离"：始终让 count 个连接并行下载最近的 count 个未缓存分片。
  // （近处慢时远处也照下，保持并行聚合吞吐；否则退化成串行，太慢。）

  // hls.js 正在等的那一片：命中预取缓存即时返回，miss 走对冲竞速 + 硬超时跳片。
  // 实现见 ./prefetch/fragLoader.ts（它可以抢连接，不受下面「存货不够就少开线程」的预取上限约束）
  const { createHlsFragLoader, getLoaderActivity } = createFragLoaderFactory({
    cache,
    lanes: laneControl,
    tier,
    sampleSpeed,
    segInflightStart,
    skipSegment,
  })

  // 发起一个分片预取请求（带 1 次轻量重试，减少「空洞」导致的临播卡顿）
  // durationSec = 该分片代表的视频秒数，用于实测码率
  const PREFETCH_TIMEOUT_MS = 300000   // 单分片下载上限(5分钟)：无此保护会导致个别卡死连接永久占位，形成永不填补的「缓冲缺口」
  const spawnPrefetch = (url: string, durationSec: number, onDone: () => void) => {
    const attemptFetch = (attempt: number): Promise<ArrayBuffer> => {
      const ctrl = new AbortController()
      segPrefetchAborts.set(url, ctrl)
      const timer = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS)
      const aStart = performance.now()
      const { lane, laneUrl, laneCount } = acquireLane(url)   // 直连/代理分流：取在途最少的 lane
      segInflightStart.set(url, aStart)            // 计时：登记在途（重试则刷新起点）
      const conc = segPrefetching.size             // 采样时的在途并发数，供聚合可并行探针分档
      return fetch(laneUrl, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(buf => { clearTimeout(timer); releaseLane(lane); markLaneOk(lane); sampleSpeed(buf.byteLength, performance.now() - aStart, conc); return buf })
        .catch(e => {
          clearTimeout(timer); releaseLane(lane)
          if (e?.name !== 'AbortError') markLaneFail(lane, laneCount)   // 超时/中止不算 lane 的账
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

    // 分片时长：headroomConnCap 用它算「缺口还装得下几片」。取清单的 targetduration
    // （它就是「最长的一片」，用来算上限正合适），拿不到就退回真实分片的 duration
    segDurSecs = levelDetails.targetduration || frags[startIdx]?.duration || segDurSecs

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
      // bytes 由每秒的 refreshCacheStats 算（遍历一遍缓存，不值得在这条热路径上重算）。
      // 但**必须原样带上**：整个对象是被替换掉的，漏了它「预取缓存 X MB」会闪回 0
      bytes: prefetchInfo.value.bytes,
    }

    if (count === 0) return

    // 计算还能发起几个新请求（不超过并发上限）
    const canStart = Math.max(0, count - segPrefetching.size)
    if (canStart === 0) return

    // 候选窗口：从 startIdx 往后扫描，最多看 count*3 个，足以跳过已缓存/下载中的。
    // 存货不够时 count 已被收到 2~3（见 SAFE_WALL_SECS），窗口自然跟着收窄、只取紧邻的几片
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

  /**
   * 清掉播放头后面的分片缓存（已经播过的那些），保留前方预取。
   *
   * 缓存的键恒为 `frag.url`（双通道的 lane 只影响真正 fetch 的地址、不进键），
   * 所以能拿分片表的 start/end 跟播放头精确对齐。
   *
   * 留 `keepBackSecs` 的回看余量：用户往回拖一点是常事，全清了就得重下。
   * **拿不到分片表时直接返回**——此时无从判断谁已播，一刀切等于把前方预取也清了，
   * 表现是「点一下清理立刻开始卡」。
   */
  const PURGE_KEEP_BACK_SECS = 30
  const purgePlayedSegments = (keepBackSecs = PURGE_KEEP_BACK_SECS) => {
    const hls = opts.getHls()
    const video = opts.getVideoEl()
    if (!hls || !video) return { removed: 0, freedBytes: 0 }
    const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = (hls as any).levels?.[level]?.details?.fragments ?? []
    if (!frags.length) return { removed: 0, freedBytes: 0 }

    const ct = anchorTime(video)
    const keep = new Set<string>()
    for (const frag of frags) {
      if (frag.end > ct - keepBackSecs && frag.url) keep.add(frag.url)
    }
    // 不在这张表里的残留（切过画质档位留下的另一档分片）也一并清掉：
    // 同一个视频，真要用到重下即可，留着只是白占内存
    return purgeCache(url => keep.has(url))
  }

  // 每小时自动清一次。**不另起定时器**：挂在心跳上，天然「不播就不清」，
  // 也不用管卸载时忘记 clearInterval。首次进入不立刻清（下面初始化成第一次 tick 的时刻）
  const AUTO_PURGE_MS = 60 * 60 * 1000
  let lastAutoPurge = 0

  // 实时心跳：由定时器/视频事件驱动（不依赖 FRAG_BUFFERED，避免卡顿时停更）。
  // 刷新缓冲读数、跑闭环控制、把在途预取补足到目标并发。
  const tick = () => {
    const video = opts.getVideoEl()
    if (!video) return
    const now = Date.now()
    if (!lastAutoPurge) lastAutoPurge = now
    else if (now - lastAutoPurge >= AUTO_PURGE_MS) {
      lastAutoPurge = now
      purgePlayedSegments()
    }
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

  return { getAheadBuffered, getCachedAhead, getAdaptivePrefetchCount, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick, primePrefetch, getStuckSegment, laneDead, reviveLanes, purgePlayedSegments, getLoaderActivity, isSegCached: (url: string) => getPrefetchedBuf(url) !== null }
}
