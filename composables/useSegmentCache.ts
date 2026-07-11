/**
 * HLS 分片预取缓存：TTL 过期 + 内存上限 LRU 淘汰 + seek 时批量取消。
 *
 * 只管「存/取/淘汰/取消」，不涉及决定预取哪些分片（那是 useHlsPrefetch 的职责）。
 */
interface PrefetchEntry { buf: ArrayBuffer; ts: number }   // 带时间戳，用于 TTL 过期
export interface PrefetchInfo { bufferSecs: number; threads: number; cached: number; pending: number }

export function useSegmentCache(opts: { getMaxBufferSizeMB: () => number }) {
  const segPrefetchCache = new Map<string, PrefetchEntry>()       // 已预取完成的缓存
  const segPrefetching = new Map<string, Promise<ArrayBuffer>>()  // 正在预取中
  const segPrefetchAborts = new Map<string, AbortController>()    // 正在预取的 AbortController，seek 时取消
  const prefetchInfo = ref<PrefetchInfo>({ bufferSecs: 0, threads: 0, cached: 0, pending: 0 })
  const PREFETCH_TTL_MS = 24 * 60 * 60 * 1000  // 缓存过期时间：1 天

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
      prefetchInfo.value.cached = segPrefetchCache.size
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
    let totalBytes = 0
    for (const entry of segPrefetchCache.values()) totalBytes += entry.buf.byteLength
    if (totalBytes <= limitBytes) {
      prefetchInfo.value.cached = segPrefetchCache.size
      return
    }
    for (const [key, entry] of segPrefetchCache) {
      if (totalBytes <= limitBytes) break
      totalBytes -= entry.buf.byteLength
      segPrefetchCache.delete(key)
    }
    prefetchInfo.value.cached = segPrefetchCache.size
  }

  return {
    segPrefetchCache,
    segPrefetching,
    segPrefetchAborts,
    prefetchInfo,
    getPrefetchedBuf,
    abortAllPrefetches,
    startPrefetchCleanup,
    stopPrefetchCleanup,
    evictPrefetchCache,
  }
}
