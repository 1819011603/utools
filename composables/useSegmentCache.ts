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
export interface PrefetchInfo { bufferSecs: number; threads: number; cached: number; pending: number }

const PREFETCH_TTL_MS = 24 * 60 * 60 * 1000  // 缓存过期时间：1 天

// 模块级单例：跨组件卸载/重挂载存活。键是分片完整代理 URL（每视频每分片唯一），
// 不同视频天然不冲突；内存由 TTL(1天)+LRU(maxBufferSizeMB) 兜底。
const segPrefetchCache = new Map<string, PrefetchEntry>()       // 已预取完成的缓存
const segPrefetching = new Map<string, Promise<ArrayBuffer>>()  // 正在预取中
const segPrefetchAborts = new Map<string, AbortController>()    // 正在预取的 AbortController，seek 时取消
let cachedVideoUrl = ''                                         // 当前缓存归属的视频 URL

export function useSegmentCache(opts: { getMaxBufferSizeMB: () => number }) {
  const prefetchInfo = ref<PrefetchInfo>({ bufferSecs: 0, threads: 0, cached: 0, pending: 0 })

  // 换视频时调用：URL 变了 → 旧缓存全属于上个视频，整块清掉（含在途请求）；
  // 同一视频（重播 / 点回去）→ 原样保留，直接命中内存。
  const useCacheForVideo = (videoUrl: string) => {
    if (videoUrl === cachedVideoUrl) return
    for (const ctrl of segPrefetchAborts.values()) { try { ctrl.abort() } catch {} }
    segPrefetchAborts.clear()
    segPrefetching.clear()
    segPrefetchCache.clear()
    cachedVideoUrl = videoUrl
    prefetchInfo.value.cached = 0
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
    useCacheForVideo,
    getPrefetchedBuf,
    abortAllPrefetches,
    startPrefetchCleanup,
    stopPrefetchCleanup,
    evictPrefetchCache,
  }
}
