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
  // 并发下限的外部兜底（站点规则已删除，现恒为 1）；实际下限取档位的 concurrencyFloor
  getConcurrencyCap: () => number
  // 当前倍速（倍速越高需要越大带宽），默认 1
  getPlaybackRate?: () => number
  // 预取深度上限（秒）：真实前向缓冲达到此值即停止预取，默认 Infinity（不限）
  getPrefetchTargetSecs?: () => number
  // 起播锚点（秒）：恢复进度/刷新时，播放头还停在 0、但我们要起播的位置在 pendingStartPos。
  // 预取以 max(currentTime, 此值) 为起点——起播即在正确位置全力并行预取，既不浪费带宽下开头，
  // 也不会退化成「只有 hls.js 串行下 1 片」。播放头到位/用户跳转后返回 0（改用 currentTime）。默认 0。
  getStartPosition?: () => number
  // 「存货保险线」（秒，墙钟）：缓存够播的秒数低于它就把预取线程收敛到 2~3（见 SAFE_WALL_SECS）。
  // 由「HLS 配置」里的 safeWallSecs 提供，不设则用兜底值。
  getSafeWallSecs?: () => number
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
  healthZone: HealthZone  // 缓冲健康区（按「有效可播」分档，panic 触发抗卡降速）
  playableSecs: number    // 有效可播秒数（MSE + 预取缓存），倍速决策的经验依据
}

const MAX_CONN = 6               // 浏览器同 host 连接上限（HTTP/1.1，硬顶）
/**
 * 「手上的存货还够播几秒」不足时的并发上限：< SAFE_WALL_SECS 收到 3 条，< 2 秒再收到 2 条。
 *
 * **判据是墙钟秒数（缓存秒数 ÷ 倍速），不是缓存秒数**——3x 下缓存 6 秒只够播 2 秒。
 * 与起播门槛（见 useVideoEvents.autoPlayTarget）用的是同一把尺子。
 *
 * 为什么存货少反而要少开线程（反直觉，但实测如此）：决定「现在能不能播下去」的只有紧邻
 * 播放头那一两片，而浏览器同 host 只给 6 个连接槽。多开的每一条都在下更远的分片，
 * 却要跟那一片抢连接和带宽——**越缺越多开，最需要的那一片反而越晚到**。
 * 用户截图里就是这么坏的：源站被判「差」档（concurrencyFloor=6）、标着「可并行」，
 * 卡到已缓冲 0.3s 仍在跑 6 线程，而聚合速度 2.10 MB/s（16.8 Mbps）是码率 2.1 Mbps 的八倍
 * ——带宽压根不是瓶颈，摊薄才是。
 *
 * 这一条统一覆盖三种场景（刚起播 / 刚拖完进度 / 播着播着要卡了）：它们的共同点正是
 * 「存货不够播 5 秒」。所以不需要另做一个「起播窄口」计时器——那种时间窗口既要上膛又要解除，
 * 上膛早了会在真正开始要分片之前就烧完（踩过）。
 *
 * 它排在 floorConn 之后生效，好压过档位给的并发下限——「差」档那个 6 正是要压的对象。
 * 注意它只管**预取**：hls.js 正在等的那一片走 fLoader 的对冲竞速（hedgedLoad），
 * 该抢连接时照样抢，不受这里限制。
 *
 * 这条线可在「HLS 配置」里调（`hlsConfig.safeWallSecs`），这里的 5 只是没配置时的兜底。
 */
const SAFE_WALL_SECS = 5
/** 濒卡线固定取保险线的 40%（5s → 2s）：跟着一起调，省一个用户看不懂的输入框 */
const PANIC_WALL_RATIO = 0.4
const PANIC_MAX_CONN = 2
const LOW_BUFFER_MAX_CONN = 3

export function useHlsPrefetch(opts: HlsPrefetchOptions) {
  const { getProxyUrl, cache, getConcurrencyCap } = opts
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
  // 并发下限：外部兜底值与档位 concurrencyFloor 取大
  const floorConn = (): number => Math.max(1, getConcurrencyCap(), tier().concurrencyFloor)
  // 有效预取深度：只认用户「预加载时长」（maxBufferLength）。档位不收窄它——
  // 否则快源缓存一到档位深度就停、预取线程掉 0。想省内存请调小「预加载时长」。
  const effectivePrefetchTarget = (): number => getPrefetchTargetSecs()

  // 预取锚点：起播定位未到位时用 pendingStartPos，否则用真实播放头。所有「从哪往后预取」的判断都基于它。
  const anchorTime = (video: HTMLVideoElement): number => Math.max(video.currentTime, getStartPosition())

  // ── 连接 lane：负载均衡 + 熔断（实现见 ./prefetch/lanes.ts）──
  // fLoader（hls.js 自身分片）与预取共用同一个均衡器，避免两者各自打满同一个 origin。
  const laneControl = useLaneControl(getLaneUrls)
  const { laneDead, acquireLane, releaseLane, markLaneOk, markLaneFail, resetLanes, getLaneCount } = laneControl

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
  let lastAhead = -1                      // 上次的前向缓冲秒数
  let lastHealthZone: HealthZone = 'healthy'  // 健康区（驱动 UI 与降速守卫）
  let lastPlayable = 0                    // 上次量到的有效可播秒数（MSE + 预取缓存）

  // 切换视频/CDN 时重置实测与控制器，避免用上个流的数据误判新流
  const resetStrategy = () => {
    bw.resetSamples()
    hostConcurrencyCap = MAX_CONN
    ctrlConn = 0
    lastAhead = -1
    lastHealthZone = 'healthy'
    lastPlayable = 0
    resetLanes()
    segInflightStart.clear()
    strategy.value = { perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0, aggregateScales: true, healthZone: 'healthy', playableSecs: 0 }
  }

  // 实测驱动的目标并发：需要带宽 = 码率 × 倍速 × 安全系数；并发 = ⌈需要 / 每连接速度⌉
  const computeTargetConcurrency = (): number => {
    const floor = floorConn()
    if (!bw.hasSamples()) return Math.min(hostConcurrencyCap, Math.max(floor, 4))  // 冷启动：乐观
    const need = bw.requiredConn(getPlaybackRate(), tier().safety)
    return Math.min(hostConcurrencyCap, Math.max(2, need, floor))
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
  //   · 健康区(healthZone)：濒卡/吃紧/健康，驱动降速守卫与双通道自动开。
  //   · 并发爬坡：缓存很少→拉满猛下；偏低/在掉→+1；接近预取目标→−1 省带宽。
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
    //
    const paused = opts.getVideoEl()?.paused ?? false
    let target = paused ? hostConcurrencyCap : Math.min(hostConcurrencyCap, Math.max(floorConn(), ctrlConn))
    // 存货不够播 5 秒就收敛到 2~3 条，把连接和带宽让给紧邻播放头那一片（理由见 SAFE_WALL_SECS）。
    // 放在最后，好压过 `paused → 顶格` 和档位的 concurrencyFloor（「差」档给的是 6）——
    // 起播那一刻正是「还没 play() 所以 paused 为真」+「缓存为 0」同时成立，两条都得压住。
    if (cachedAhead !== undefined) {
      const wall = cachedAhead / Math.max(1, getPlaybackRate())
      const safe = getSafeWallSecs()
      if (wall < safe * PANIC_WALL_RATIO) target = Math.min(target, PANIC_MAX_CONN)
      else if (wall < safe) target = Math.min(target, LOW_BUFFER_MAX_CONN)
    }
    refreshStrategy(target)
    return target
  }

  // 不限制预取"触达距离"：始终让 count 个连接并行下载最近的 count 个未缓存分片。
  // （近处慢时远处也照下，保持并行聚合吞吐；否则退化成串行，太慢。）

  // hls.js 正在等的那一片：命中预取缓存即时返回，miss 走对冲竞速 + 硬超时跳片。
  // 实现见 ./prefetch/fragLoader.ts（它可以抢连接，不受下面「存货不够就少开线程」的预取上限约束）
  const { createHlsFragLoader } = createFragLoaderFactory({
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

  return { getAheadBuffered, getCachedAhead, getAdaptivePrefetchCount, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick, primePrefetch, getStuckSegment, laneDead, purgePlayedSegments }
}
