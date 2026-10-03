import type HlsType from 'hls.js'
import type { useSegmentCache } from './useSegmentCache'
import { SERVER_TIERS, DEFAULT_TIER, type TierParams } from '../videoSiteRules'
import { useLaneControl } from './prefetch/lanes'
import { useBandwidthModel } from './prefetch/bandwidth'
import { createFragLoaderFactory } from './prefetch/fragLoader'
import { useBufferMeter } from './prefetch/bufferMeter'
import { useConcurrencyStrategy, type PrefetchRuntime } from './prefetch/strategy'
import { usePrefetchScheduler } from './prefetch/scheduler'
import { MAX_CONN, SAFE_WALL_SECS } from './prefetch/tuning'
import { isOffline } from './engine/netWatch'

export type { HealthZone, StrategySnapshot } from './prefetch/strategy'

/**
 * HLS 自适应并行预取（装配层）：
 *  - createHlsFragLoader：自定义 fLoader，命中预取缓存即时返回，miss 则 fetch
 *  - triggerAdaptivePrefetch：每次 FRAG_BUFFERED 后按缓冲健康度补预取
 *  - startOnePrefetch：完成 1 个补 1 个
 *
 * 通过 getHls/getVideoEl 惰性读取播放器实例（避免持有过期引用），
 * 缓存读写委托给 useSegmentCache。
 *
 * 实现按职责拆到 `./prefetch/`：
 *  - `tuning.ts`   并发调参常量
 *  - `strategy.ts` 并发策略（基值 desiredConn + 九级调度顺序 + 策略快照）
 *  - `caps.ts`     各级帽子与地板的算式（存货阶梯 / 卡顿守卫 / 摊薄 / 单条够快 / 拐点 / 地板）
 *  - `scheduler.ts` 预取调度（取哪一片 / 心跳 / 预热 / 清理）
 *  - `bandwidth.ts` / `lanes.ts` / `bufferMeter.ts` / `fragLoader.ts` 量测与取数
 * 本文件只做装配：把 opts、共享状态（runtime）与上面几块接起来。
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
   * 上一次**真实卡顿**的时间戳（`performance.now()`，0=没卡过；**不是** `Date.now()`，见 stallGuard）。来自 useStallTracker——
   * 它以 `<video>` 的实际停顿为地面真值（排除 seek 与用户 pause），比任何带宽估算都可信，
   * 所以卡顿守卫排在缺口/聚合那些「省流量」的判据前面（见 stallGuard）。
   */
  getLastStallAt?: () => number
  /** 关键片拿不到、真的跳过了一片（本机播放记录用） */
  onSegmentSkipped?: () => void
}

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

  // 预取锚点：起播定位未到位时用 pendingStartPos，否则用真实播放头。所有「从哪往后预取」的判断都基于它。
  const anchorTime = (video: HTMLVideoElement): number => Math.max(video.currentTime, getStartPosition())

  // ── 连接 lane：负载均衡 + 熔断（实现见 ./prefetch/lanes.ts）──
  // fLoader（hls.js 自身分片）与预取共用同一个均衡器，避免两者各自打满同一个 origin。
  const laneControl = useLaneControl(getLaneUrls)
  const { laneDead, resetLanes, reviveLanes } = laneControl

  // ── 实测采样：每连接速度 / 码率 / 聚合能否并行 / 最高流畅倍速（实现见 ./prefetch/bandwidth.ts）──
  const bw = useBandwidthModel()

  // 策略与调度共享的少量可变状态（见 PrefetchRuntime）。装配层创建，两边读写同一份。
  const runtime: PrefetchRuntime = { hostConcurrencyCap: MAX_CONN, segDurSecs: 0 }

  // 缓冲量测（实现见 ./prefetch/bufferMeter.ts）：
  //   getAheadBuffered = 仅 MSE（跳片用）；getCachedAhead = MSE + 预取缓存（分档/并发/倍速用）
  const { getAheadBuffered, getCachedAhead } = useBufferMeter({
    getHls: opts.getHls,
    getPrefetchedBuf: cache.getPrefetchedBuf,
    anchorTime,
  })

  // 跳过卡死的分片：把播放头挪到该分片之后，让 hls.js 从下一片重新加载（下一片多半已预取，秒恢复）。
  // 只在「确实卡在播放头附近」时跳，避免把提前缓冲的远处分片误当卡点跳掉。返回是否真的跳了。
  const skipSegment = (frag: any): boolean => {
    const video = opts.getVideoEl()
    if (!video || !frag) return false
    // 断网时跳片纯属有害：下一片同样下不来，跳一次就白扔一片缓存、画面还硬跳一下。
    // 什么都不做，等网络回来（见 useVideoEngine 的 online 处理）才是对的
    if (isOffline()) return false
    const ahead = getAheadBuffered(video)
    if (ahead > 1.5) return false                               // 播放还没吃紧 → 不是真卡点，不跳
    // 抗卡阶梯「先降速再跳片」：倍速>1 时优先靠降速守卫救场，不急着跳；
    // 但已几乎冻结(<0.3s)则无论倍速都跳——冻结比一次画面跳变更糟。
    if (getPlaybackRate() > 1.05 && ahead > 0.3) return false
    if ((frag.start ?? 0) > video.currentTime + 2) return false // 该片在播放头前方较远（提前缓冲）→ 不跳
    const target = (frag.start ?? video.currentTime) + (frag.duration ?? 2) + 0.1
    if (target > video.currentTime && (!video.duration || target < video.duration - 0.5)) {
      video.currentTime = target
      opts.onSegmentSkipped?.()
      return true
    }
    return false
  }

  // ── 并发策略：把「这一拍该开几条」算出来（实现见 ./prefetch/strategy.ts）──
  const strategyCtl = useConcurrencyStrategy({
    bw,
    runtime,
    tier,
    getPlaybackRate,
    getPrefetchTargetSecs,
    getSafeWallSecs,
    getColdStartConn: () => opts.getColdStartConn?.() ?? 0,
    getLastStallAt: () => opts.getLastStallAt?.() ?? 0,
  })
  const { strategy, getAdaptivePrefetchCount, resetConcurrencyRamp, getConnTrace } = strategyCtl

  // ── 预取调度：取哪一片、怎么取（实现见 ./prefetch/scheduler.ts）──
  const scheduler = usePrefetchScheduler({
    getHls: opts.getHls,
    getVideoEl: opts.getVideoEl,
    cache,
    bw,
    lanes: laneControl,
    strategy: strategyCtl,
    runtime,
    anchorTime,
    getAheadBuffered,
    getCachedAhead,
  })
  const {
    triggerAdaptivePrefetch, startOnePrefetch, tick, primePrefetch,
    purgePlayedSegments, getStuckSegment, segInflightStart,
  } = scheduler

  // hls.js 正在等的那一片：命中预取缓存即时返回，miss 走对冲竞速 + 硬超时跳片。
  // 实现见 ./prefetch/fragLoader.ts（它可以抢连接，不受「存货不够就少开线程」的预取上限约束）
  const { createHlsFragLoader, getLoaderActivity } = createFragLoaderFactory({
    cache,
    lanes: laneControl,
    tier,
    sampleSpeed: bw.sampleSpeed,
    segInflightStart,
    skipSegment,
  })

  // 切换视频/CDN 时重置实测与控制器，避免用上个流的数据误判新流
  const resetStrategy = () => {
    bw.resetSamples()
    runtime.hostConcurrencyCap = MAX_CONN
    runtime.segDurSecs = 0
    strategyCtl.reset()
    scheduler.reset()
    resetLanes()
  }

  return {
    getAheadBuffered, getCachedAhead, getAdaptivePrefetchCount, createHlsFragLoader, getConnTrace,
    triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, resetConcurrencyRamp,
    tick, primePrefetch, getStuckSegment, laneDead, reviveLanes, purgePlayedSegments, getLoaderActivity,
    isSegCached: (url: string) => cache.getPrefetchedBuf(url) !== null,
    getSegBuf: (url: string) => cache.getPrefetchedBuf(url),
  }
}
