/**
 * 预取调度：发起分片请求（`spawnPrefetch`）、按目标并发补片（`startOnePrefetch` / `fillPrefetch`）、
 * 每次缓冲事件后的自适应触发（`triggerAdaptivePrefetch`）、实时心跳（`tick`）、起播预热（`primePrefetch`）、
 * 已播分片清理（`purgePlayedSegments`）。
 *
 * 从 `useHlsPrefetch` 拆出来：这一半只做「取哪一片、怎么取」，不决定「该开几条」——
 * 目标并发由 `useConcurrencyStrategy` 现算后传进来。两者共享的可变状态
 * （hostConcurrencyCap / segDurSecs）收在 `runtime` 里。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type HlsType from 'hls.js'
import type { useSegmentCache } from '../useSegmentCache'
import type { BandwidthModel } from './bandwidth'
import type { LaneControl } from './lanes'
import type { ConcurrencyStrategy, PrefetchRuntime } from './strategy'
import { MAX_CONN } from './tuning'
import { currentFrags } from '../engine/hlsFrags'
import { fetchBodyWithStallWatch } from './fetchBody'

/**
 * 这一拍还能再发几条预取：既不超过目标并发，也**不挤占关键片的连接槽**。
 *
 * `inflightTotal` 含 fragLoader 为 hls.js 正在等的那一片起的竞速连接。只看「预取自己几条」时，
 * 预取补满 hostCap 之后关键片的对冲再起一条，就超出浏览器每 origin 的 6 条 → 那一条在浏览器里
 * 排队、排在一堆远处分片后面，对冲等于白开。所以总在途到顶时预取让路，关键片先走。
 */
export const prefetchSlots = (target: number, prefetching: number, inflightTotal: number, hostCap: number): number =>
  Math.max(0, Math.min(target - prefetching, hostCap - inflightTotal))

export interface PrefetchSchedulerDeps {
  getHls: () => HlsType | null
  getVideoEl: () => HTMLVideoElement | undefined
  cache: ReturnType<typeof useSegmentCache>
  bw: BandwidthModel
  lanes: LaneControl
  strategy: ConcurrencyStrategy
  runtime: PrefetchRuntime
  /** 量测起点：起播定位未到位时是 pendingStartPos，否则是真实播放头 */
  anchorTime: (video: HTMLVideoElement) => number
  getAheadBuffered: (video: HTMLVideoElement) => number
  getCachedAhead: (video: HTMLVideoElement) => number
}

export function usePrefetchScheduler(deps: PrefetchSchedulerDeps) {
  const { getHls, getVideoEl, cache, bw, lanes, strategy, runtime, anchorTime, getAheadBuffered, getCachedAhead } = deps
  const { getAdaptivePrefetchCount, effectivePrefetchTarget, updateHealthZone } = strategy
  const { getLaneCount, acquireLane, releaseLane, markLaneOk, markLaneFail, getInflightTotal, markInflight, avgInflightSince } = lanes
  const { sampleSpeed, sampleBitrate } = bw

  const {
    segPrefetchCache, segPrefetching, segPrefetchAborts,
    prefetchInfo, getPrefetchedBuf, evictPrefetchCache, purgeCache,
  } = cache

  // ── 在途下载计时（诊断「哪个分片卡住、下了多久」）──
  // url → 该分片本次下载的起始 performance.now()。发起时登记，成功/失败/中止时删除。
  // 与 fLoader 共用同一份（见 createFragLoaderFactory 的 segInflightStart）。
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

  /** 已缓存或下载中 → 不重复下载。 */
  const isHandled = (url: string): boolean => getPrefetchedBuf(url) !== null || segPrefetching.has(url)

  /** 已达有效预取深度 → 停取（0）。四个入口共用同一判据。 */
  const capAtTarget = (cachedAhead: number, count: number): number =>
    cachedAhead >= effectivePrefetchTarget() ? 0 : count

  /**
   * 把要展示的四个读数一次写好。`bytes` 由 refreshCacheStats 单独刷（遍历一遍缓存，不值得在这条
   * 热路径上重算），这里不碰它——**用「逐字段改」而不是「换整个对象」**，就不会像以前那样漏带 bytes。
   */
  const writePrefetchInfo = (mseAhead: number, count: number) => {
    prefetchInfo.value.bufferSecs = Math.round(mseAhead * 10) / 10
    prefetchInfo.value.threads = count
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.pending = segPrefetching.size
  }

  /**
   * 按未来分片的 host 分布算并发上限：多 CDN 每 host 6 连接、双通道再 +6（都封顶 12）。
   * 触发与心跳两处都调——原来只在 FRAG_BUFFERED 里算，卡顿期间（没有 FRAG_BUFFERED）会一直用旧值。
   */
  const updateHostCap = (frags: any[], fromIdx: number) => {
    const lookahead = frags.slice(Math.max(0, fromIdx), fromIdx + 24)
    const hosts = new Set<string>()
    for (const f of lookahead) { try { hosts.add(new URL(f.url).host) } catch {} }
    let cap = Math.min(12, Math.max(1, hosts.size) * MAX_CONN)
    // 双通道：代理是额外一个 origin（本站），再加 6 条
    if (getLaneCount(lookahead[0]?.url) > 1) cap = Math.min(12, cap + MAX_CONN)
    runtime.hostConcurrencyCap = cap
  }

  /**
   * 一拍的「量 → 判 → 记」：读两个缓冲指标、刷新健康区、算目标并发、到目标即停取、写面板读数。
   * 四个入口（FRAG_BUFFERED 触发 / 补片回调 / 心跳 / 起播预热）共用，别各写一份再漂开。
   * 双指标：mseAhead（真实可播）驱动健康区/降速/跳片；cachedAhead（含预取缓存）驱动并发与停取。
   */
  const evaluateCount = (video: HTMLVideoElement): number => {
    const mseAhead = getAheadBuffered(video)
    const cachedAhead = getCachedAhead(video)
    updateHealthZone(mseAhead, cachedAhead)   // 健康区（只驱动抗卡动作，不参与并发）
    const count = capAtTarget(cachedAhead, getAdaptivePrefetchCount(cachedAhead))
    writePrefetchInfo(mseAhead, count)
    return count
  }

  // 发起一个分片预取请求（带 1 次轻量重试，减少「空洞」导致的临播卡顿）
  // durationSec = 该分片代表的视频秒数，用于实测码率
  const PREFETCH_TIMEOUT_MS = 300000   // 单分片总上限(5分钟)：兜底，防「卡死连接永久占位」
  const PREFETCH_STALL_MS = 20000      // 无进展看门狗(20s)：连接挂着不吐数据 → 判死，别干等到总上限
  const spawnPrefetch = (url: string, durationSec: number, onDone: () => void) => {
    const attemptFetch = (attempt: number): Promise<ArrayBuffer> => {
      const ctrl = new AbortController()
      segPrefetchAborts.set(url, ctrl)
      const timer = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS)
      const aStart = performance.now()
      const { lane, laneUrl, laneCount } = acquireLane(url)   // 直连/代理分流：取在途最少的 lane
      segInflightStart.set(url, aStart)            // 计时：登记在途（重试则刷新起点）
      const mark = markInflight()               // 分档用全程平均在途数（预取 + 关键片），不是发起那一刻的
      return fetchBodyWithStallWatch(ctrl, laneUrl, PREFETCH_STALL_MS)
        .then(buf => {
          clearTimeout(timer)
          const conc = avgInflightSince(mark)
          releaseLane(lane); markLaneOk(lane)
          sampleSpeed(buf.byteLength, performance.now() - aStart, conc, aStart)
          return buf
        })
        .catch(e => {
          clearTimeout(timer); releaseLane(lane)
          // 中止（seek/竞速已有赢家）不算 lane 的账；**卡死（StallError）算**——那条 lane 该被避开
          if (e?.name !== 'AbortError') markLaneFail(lane, laneCount)
          // 卡死可以换条 lane 再试一次；总超时(AbortError)不重试（换个 lane 也是白等）
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
    const video = getVideoEl()
    const cur = currentFrags(getHls())
    if (!video || !cur) return
    const { frags, details: levelDetails } = cur
    const startIdx = frags.findIndex((f: any) => f.sn === lastFragSn) + 1
    if (startIdx <= 0) return

    // 分片时长：desiredConn 用它算「缺口还装得下几片」。取清单的 targetduration
    // （它就是「最长的一片」，用来算上限正合适），拿不到就退回真实分片的 duration
    runtime.segDurSecs = levelDetails.targetduration || frags[startIdx]?.duration || runtime.segDurSecs

    // 探测未来分片的 host 分布：多 CDN / 双通道时放宽并发上限
    updateHostCap(frags, startIdx)

    const count = evaluateCount(video)
    if (count === 0) return

    const canStart = prefetchSlots(count, segPrefetching.size, getInflightTotal(), runtime.hostConcurrencyCap)
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
      if (!url || isHandled(url)) continue   // 已缓存/下载中 → 不重复下载
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      started++
    }

    prefetchInfo.value.pending = segPrefetching.size
    // 收尾不再 evict：真正入缓存发生在 spawnPrefetch 完成时（那边每个分片落地都 evict），
    // 此刻还没有新分片进缓存，再扫一遍纯属白跑。
  }

  // 完成1个分片后补充1个，基于当前播放进度定位下一个未下载分片。
  //
  // `countOverride`：调用方（tick / primePrefetch）已经算好目标并发时传进来——它们本来就要
  // 在循环里反复调这个函数，不传的话每调一次都要把整条策略链（①–⑨）重跑一遍、还重复写
  // `prefetchInfo`（目标 6 条时一秒 7 遍）。作为 `spawnPrefetch` 的 onDone 回调（无参）时才现算。
  const startOnePrefetch = (countOverride?: number) => {
    const video = getVideoEl()
    if (!video) return
    // 传了 countOverride：读数与 prefetchInfo 由调用方统一写好，这里只负责补片
    const count = countOverride ?? evaluateCount(video)

    if (prefetchSlots(count, segPrefetching.size, getInflightTotal(), runtime.hostConcurrencyCap) === 0) return

    const cur = currentFrags(getHls())
    if (!cur || !cur.frags.length) return
    const frags = cur.frags

    // 从锚点（起播定位期间=pendingStartPos，否则=播放头）往后找第一个未缓存、未下载中的分片
    const currentTime = anchorTime(video)
    for (const frag of frags) {
      if (frag.start < currentTime) continue
      const url: string = frag.url
      if (!url || isHandled(url)) continue   // 已缓存/下载中 → 不重复下载
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      prefetchInfo.value.pending = segPrefetching.size
      break  // 只补1个
    }
  }

  /** 把在途预取补足到 `count` 条（`startOnePrefetch` 同步占位，循环安全）。tick / primePrefetch 共用。 */
  const fillPrefetch = (count: number) => {
    let guard = 0
    while (segPrefetching.size < count && guard++ < count) {
      const before = segPrefetching.size
      startOnePrefetch(count)
      if (segPrefetching.size === before) break   // 没有可补的分片了
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
    const video = getVideoEl()
    const cur = currentFrags(getHls())
    if (!video || !cur || !cur.frags.length) return { removed: 0, freedBytes: 0 }
    const frags = cur.frags

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
    const video = getVideoEl()
    if (!video) return
    const now = Date.now()
    if (!lastAutoPurge) lastAutoPurge = now
    else if (now - lastAutoPurge >= AUTO_PURGE_MS) {
      lastAutoPurge = now
      purgePlayedSegments()
    }
    // 心跳也刷一次并发上限：卡顿期间没有 FRAG_BUFFERED，否则会一直用旧值
    const cf = currentFrags(getHls())
    if (cf?.frags.length) {
      const idx = cf.frags.findIndex((f: any) => f.end > anchorTime(video))
      updateHostCap(cf.frags, idx >= 0 ? idx : 0)
    }
    // 补足到目标并发（count 传下去，别在循环里重算策略链）
    fillPrefetch(evaluateCount(video))
  }

  // 起播/seek 预热：并行预取后续分片。
  const primePrefetch = () => {
    const video = getVideoEl()
    fillPrefetch(video ? evaluateCount(video) : capAtTarget(0, getAdaptivePrefetchCount(0)))
  }

  /** 换视频/CDN 时重置调度状态（只清在途计时表；每小时自动清理的计时跨流保留，同原实现）。 */
  const reset = () => {
    segInflightStart.clear()
  }

  return {
    triggerAdaptivePrefetch, startOnePrefetch, tick, primePrefetch,
    purgePlayedSegments, getStuckSegment, segInflightStart, reset,
  }
}

export type PrefetchScheduler = ReturnType<typeof usePrefetchScheduler>
