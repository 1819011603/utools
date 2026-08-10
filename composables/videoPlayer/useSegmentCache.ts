/**
 * HLS 分片预取缓存（L1 内存，模块级单例）：TTL 过期 + 内存上限 LRU 淘汰 + seek 时批量取消。
 *
 * 缓存跨组件卸载/重挂载存活——「点回去」/ 重播 / seek 同一视频时直接命中内存，不重新下载。
 * 清除规则（按需求固定）：当前视频的缓存任何时候都不清，只在两种情况清——
 *   ① TTL 1 天过期；② 切换到别的视频 URL。
 * 注意：内存缓存无法跨「刷新页面」存活（JS 堆天生随刷新销毁），这是浏览器机制，非本模块可控。
 *
 * 只管「存/取/淘汰/取消」，不涉及决定预取哪些分片（那是 useHlsPrefetch 的职责）。
 */
interface PrefetchEntry { buf: ArrayBuffer; ts: number }   // 带时间戳，用于 TTL 过期
// bytes = 缓存占的字节数。分片数看不出内存压力（各站分片大小差一个量级），
// 而这个缓存正是播放页发卡时最该先看的那个数
export interface PrefetchInfo { bufferSecs: number; threads: number; cached: number; pending: number; bytes: number }

const PREFETCH_TTL_MS = 24 * 60 * 60 * 1000  // 缓存过期时间：1 天

// 模块级单例：跨组件卸载/重挂载存活。键是分片完整代理 URL（每视频每分片唯一），
// 不同视频天然不冲突；内存由 TTL(1天)+LRU(maxBufferSizeMB) 兜底。
const segPrefetchCache = new Map<string, PrefetchEntry>()       // 已预取完成的缓存
const segPrefetching = new Map<string, Promise<ArrayBuffer>>()  // 正在预取中
const segPrefetchAborts = new Map<string, AbortController>()    // 正在预取的 AbortController，seek 时取消
let cachedVideoUrl = ''                                         // 当前缓存归属的视频 URL

/**
 * 「下一集」的分片暂存区（见 useVideoPrewarm 的第四段）。
 *
 * 为什么不能直接写进 segPrefetchCache：切集时 `useCacheForVideo(新地址)` 会整块 clear，
 * 把刚预热好的下一集分片一起清掉——预热白做。所以先存在这儿、按视频地址归档，
 * 等 useCacheForVideo 换到那个地址时再搬进去（adopt）。
 *
 * 自带上限与 TTL：它跟主缓存不同，主缓存的量由播放头和 LRU 管着，
 * 而这里的分片可能永远用不上（用户没点下一集就关了页面），不封顶就是第二个内存黑洞。
 */
const STAGE_TTL_MS = 5 * 60 * 1000
const STAGE_MAX_BYTES = 64 * 1024 * 1024
let staged: { videoUrl: string; at: number; entries: Map<string, ArrayBuffer> } | null = null

export function useSegmentCache(opts: { getMaxBufferSizeMB: () => number }) {
  const prefetchInfo = ref<PrefetchInfo>({ bufferSecs: 0, threads: 0, cached: 0, pending: 0, bytes: 0 })

  // 缓存占用字节数。条目数量级 ~1000（1GB / 1MB 一片），每秒遍历一次可忽略，
  // 不值得为它维护一份「增删都要记得同步」的计数器——那种漏改一处就长期偏差
  const cacheBytes = () => {
    let n = 0
    for (const entry of segPrefetchCache.values()) n += entry.buf.byteLength
    return n
  }

  /** 把分片数与字节数一次写好。心跳每秒调一次，UI 只读这一个 ref */
  const refreshCacheStats = () => {
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.bytes = cacheBytes()
  }

  /**
   * 按谓词删除缓存项，返回释放量。
   *
   * 本模块**不认识 hls 也不认识播放头**（它只管存/取/淘汰/取消），
   * 「哪些算已播」由上层算好后用谓词传进来——反过来在这里 import 上层会立刻变成循环依赖。
   */
  const purgeCache = (shouldKeep: (url: string) => boolean) => {
    let removed = 0
    let freedBytes = 0
    for (const [url, entry] of segPrefetchCache) {
      if (shouldKeep(url)) continue
      freedBytes += entry.buf.byteLength
      removed++
      segPrefetchCache.delete(url)
    }
    refreshCacheStats()
    return { removed, freedBytes }
  }

  /**
   * 预热好的下一集分片先存这儿，等切过去时由 useCacheForVideo 搬进主缓存。
   * 只留最新一份：同时预备两集没有意义（用户只会点一次下一集），留着白占内存。
   */
  const stageSegments = (videoUrl: string, entries: Array<[string, ArrayBuffer]>) => {
    if (!videoUrl || !entries.length) return
    let bytes = 0
    const kept = new Map<string, ArrayBuffer>()
    for (const [url, buf] of entries) {
      if (bytes + buf.byteLength > STAGE_MAX_BYTES) break
      bytes += buf.byteLength
      kept.set(url, buf)
    }
    staged = { videoUrl, at: Date.now(), entries: kept }
  }

  const clearStagedSegments = () => { staged = null }

  // 换视频时调用：URL 变了 → 旧缓存全属于上个视频，整块清掉（含在途请求）；
  // 同一视频（重播 / 点回去）→ 原样保留，直接命中内存。
  const useCacheForVideo = (videoUrl: string) => {
    if (videoUrl === cachedVideoUrl) return
    for (const ctrl of segPrefetchAborts.values()) { try { ctrl.abort() } catch {} }
    segPrefetchAborts.clear()
    segPrefetching.clear()
    segPrefetchCache.clear()
    cachedVideoUrl = videoUrl
    // 清空之后再搬：暂存区里那几片正是这个新地址的，搬进来切集就能立刻起播。
    // 顺序反了会被上面的 clear 一起扔掉（预热白做）。
    if (staged) {
      const fresh = staged.videoUrl === videoUrl && Date.now() - staged.at < STAGE_TTL_MS
      if (fresh) {
        const ts = Date.now()
        for (const [url, buf] of staged.entries) segPrefetchCache.set(url, { buf, ts })
        console.log(`用预热好的 ${staged.entries.size} 个分片，切集可立即起播`)
      }
      staged = null   // 用过/过期/换了别的地址 → 一律扔掉，绝不留到下一集
    }
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.bytes = cacheBytes()
  }

  // 取消所有正在预取的 fetch（seek 后位置改变，旧的预取无意义）
  const abortAllPrefetches = () => {
    for (const ctrl of segPrefetchAborts.values()) {
      try { ctrl.abort() } catch {}
    }
    segPrefetchAborts.clear()
    segPrefetching.clear()
  }

  // 取缓存：自动剔除过期项，命中即返回 ArrayBuffer，未命中或过期返回 null
  const getPrefetchedBuf = (url: string): ArrayBuffer | null => {
    const entry = segPrefetchCache.get(url)
    if (!entry) return null
    if (Date.now() - entry.ts > PREFETCH_TTL_MS) {
      segPrefetchCache.delete(url)
      return null
    }
    return entry.buf
  }

  // 周期清理已过期的缓存项（每 5 分钟扫一次）
  let prefetchCleanupTimer: ReturnType<typeof setInterval> | null = null
  const startPrefetchCleanup = () => {
    if (prefetchCleanupTimer) return
    prefetchCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [url, entry] of segPrefetchCache) {
        if (now - entry.ts > PREFETCH_TTL_MS) segPrefetchCache.delete(url)
      }
      refreshCacheStats()
    }, 5 * 60 * 1000)
  }
  const stopPrefetchCleanup = () => {
    if (prefetchCleanupTimer) {
      clearInterval(prefetchCleanupTimer)
      prefetchCleanupTimer = null
    }
  }

  // LRU 淘汰：先剔除已过期项，再按 maxBufferSizeMB 控制总大小
  const evictPrefetchCache = () => {
    const now = Date.now()
    // 先清过期
    for (const [url, entry] of segPrefetchCache) {
      if (now - entry.ts > PREFETCH_TTL_MS) segPrefetchCache.delete(url)
    }
    const limitBytes = opts.getMaxBufferSizeMB() * 1024 * 1024
    let totalBytes = cacheBytes()
    if (totalBytes <= limitBytes) {
      refreshCacheStats()
      return
    }
    for (const [key, entry] of segPrefetchCache) {
      if (totalBytes <= limitBytes) break
      totalBytes -= entry.buf.byteLength
      segPrefetchCache.delete(key)
    }
    refreshCacheStats()
  }

  return {
    segPrefetchCache,
    segPrefetching,
    segPrefetchAborts,
    prefetchInfo,
    useCacheForVideo,
    getPrefetchedBuf,
    abortAllPrefetches,
    startPrefetchCleanup,
    stopPrefetchCleanup,
    evictPrefetchCache,
    refreshCacheStats,
    purgeCache,
    stageSegments,
    clearStagedSegments,
  }
}
