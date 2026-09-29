/**
 * `useSegmentCache.ts` 的行为钉子：TTL 过期、LRU 淘汰、换视频整块清空、暂存区搬运、周期清理。
 *
 * 模块级状态是单例（跨组件卸载/重挂载存活），每个 test 靠 `beforeEach` 里
 * `useCacheForVideo(唯一URL)` 强制切一次 URL 来清空 segPrefetchCache/segPrefetching/
 * segPrefetchAborts 并重置 cachedVideoUrl/staged，避免用例之间互相污染。
 *
 * 范围边界：`purgeCache` 只是通用谓词淘汰（本模块不认识 hls 也不认识播放头），
 * 「按已播分片淘汰」的 `purgePlayedSegments` 在 `prefetch/scheduler.ts`，不在本文件测试范围内。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSegmentCache } from './useSegmentCache'

const PREFETCH_TTL_MS = 24 * 60 * 60 * 1000
const STAGE_TTL_MS = 5 * 60 * 1000
const STAGE_MAX_BYTES = 64 * 1024 * 1024

const fakeBuf = (bytes: number) => ({ byteLength: bytes } as unknown as ArrayBuffer)
let uniqueSeq = 0
const uniqueUrl = () => `__reset__${++uniqueSeq}_${Math.random()}`

describe('useSegmentCache', () => {
  let maxMB = 1024
  let cache: ReturnType<typeof useSegmentCache>

  beforeEach(() => {
    maxMB = 1024
    cache = useSegmentCache({ getMaxBufferSizeMB: () => maxMB })
    // 单例状态跨用例存活：切到一个全新 URL，触发 clear 分支，把上一条用例留下的
    // segPrefetchCache/segPrefetching/segPrefetchAborts/staged 全部清干净。
    cache.useCacheForVideo(uniqueUrl())
  })

  it('useCacheForVideo 换 URL 全部清空', () => {
    cache.useCacheForVideo('A')
    cache.segPrefetchCache.set('fragUrlUnderA', { buf: new ArrayBuffer(10), ts: Date.now() })
    const abortFn = vi.fn()
    cache.segPrefetchAborts.set('fragUrlUnderA', { abort: abortFn } as unknown as AbortController)
    cache.segPrefetching.set('fragUrlUnderA', Promise.resolve(new ArrayBuffer(0)))

    cache.useCacheForVideo('B')

    expect(cache.segPrefetchCache.size).toBe(0)
    expect(cache.segPrefetchAborts.size).toBe(0)
    expect(cache.segPrefetching.size).toBe(0)
    expect(abortFn).toHaveBeenCalledTimes(1)
  })

  it('useCacheForVideo 同 URL 不清（提前 return）', () => {
    cache.useCacheForVideo('A')
    cache.segPrefetchCache.set('fragUrlUnderA', { buf: new ArrayBuffer(10), ts: Date.now() })

    cache.useCacheForVideo('A')

    expect(cache.segPrefetchCache.has('fragUrlUnderA')).toBe(true)
  })

  it('getPrefetchedBuf：TTL 过期返回 null 并惰性删除，未过期正常命中', () => {
    const oldTs = Date.now() - PREFETCH_TTL_MS - 1000
    cache.segPrefetchCache.set('expired', { buf: new ArrayBuffer(5), ts: oldTs })
    cache.segPrefetchCache.set('fresh', { buf: new ArrayBuffer(5), ts: Date.now() })

    expect(cache.getPrefetchedBuf('expired')).toBeNull()
    expect(cache.segPrefetchCache.has('expired')).toBe(false)
    expect(cache.getPrefetchedBuf('fresh')).toBeInstanceOf(ArrayBuffer)
  })

  it('evictPrefetchCache：TTL 清理优先于 LRU，未超字节也照样清过期项', () => {
    const oldTs = Date.now() - PREFETCH_TTL_MS - 1000
    cache.segPrefetchCache.set('expired1', { buf: new ArrayBuffer(10), ts: oldTs })
    cache.segPrefetchCache.set('expired2', { buf: new ArrayBuffer(10), ts: oldTs })
    cache.segPrefetchCache.set('fresh', { buf: new ArrayBuffer(10), ts: Date.now() })

    cache.evictPrefetchCache()

    expect(cache.segPrefetchCache.has('expired1')).toBe(false)
    expect(cache.segPrefetchCache.has('expired2')).toBe(false)
    expect(cache.segPrefetchCache.has('fresh')).toBe(true)
  })

  it('evictPrefetchCache：超限按插入顺序 LRU 淘汰（先插入先淘汰）', () => {
    maxMB = 1 // 限 1MB = 1,048,576 bytes
    const now = Date.now()
    cache.segPrefetchCache.set('a', { buf: new ArrayBuffer(500_000), ts: now })
    cache.segPrefetchCache.set('b', { buf: new ArrayBuffer(500_000), ts: now })
    cache.segPrefetchCache.set('c', { buf: new ArrayBuffer(500_000), ts: now })
    // 总 1,500,000 > 1,048,576：删掉最早插入的 a（剩 1,000,000 <= 限额）就停

    cache.evictPrefetchCache()

    expect(cache.segPrefetchCache.has('a')).toBe(false)
    expect(cache.segPrefetchCache.has('b')).toBe(true)
    expect(cache.segPrefetchCache.has('c')).toBe(true)
  })

  it('evictPrefetchCache：未超限时不删任何条目，只刷新统计', () => {
    const now = Date.now()
    cache.segPrefetchCache.set('a', { buf: new ArrayBuffer(10), ts: now })
    cache.segPrefetchCache.set('b', { buf: new ArrayBuffer(20), ts: now })

    cache.evictPrefetchCache()

    expect(cache.segPrefetchCache.size).toBe(2)
    expect(cache.prefetchInfo.value.cached).toBe(2)
    expect(cache.prefetchInfo.value.bytes).toBe(30)
  })

  it('purgeCache：按谓词删除，返回 removed/freedBytes', () => {
    const now = Date.now()
    cache.segPrefetchCache.set('keep-1', { buf: new ArrayBuffer(10), ts: now })
    cache.segPrefetchCache.set('keep-2', { buf: new ArrayBuffer(20), ts: now })
    cache.segPrefetchCache.set('drop-1', { buf: new ArrayBuffer(30), ts: now })

    const result = cache.purgeCache(url => url.startsWith('keep-'))

    expect(cache.segPrefetchCache.has('keep-1')).toBe(true)
    expect(cache.segPrefetchCache.has('keep-2')).toBe(true)
    expect(cache.segPrefetchCache.has('drop-1')).toBe(false)
    expect(result).toEqual({ removed: 1, freedBytes: 30 })
  })

  it('stageSegments：累计超出 STAGE_MAX_BYTES 后，后续分片整体丢弃', () => {
    // 用带 byteLength 的假对象代替真实大 ArrayBuffer，避免测试里分配上百 MB
    cache.stageSegments('nextUrl', [
      ['frag1', fakeBuf(40 * 1024 * 1024)],
      ['frag2', fakeBuf(30 * 1024 * 1024)], // 40+30=70MB > 64MB，从这片开始 break
      ['frag3', fakeBuf(10 * 1024 * 1024)],
    ])

    cache.useCacheForVideo('nextUrl')

    expect(cache.segPrefetchCache.has('frag1')).toBe(true)
    expect(cache.segPrefetchCache.has('frag2')).toBe(false)
    expect(cache.segPrefetchCache.has('frag3')).toBe(false)
  })

  it('stageSegments：空 URL 或空分片数组不建暂存区', () => {
    cache.stageSegments('', [['fragA', new ArrayBuffer(10)]])
    cache.stageSegments('nextUrl', [])

    cache.useCacheForVideo('nextUrl')

    expect(cache.segPrefetchCache.size).toBe(0)
  })

  it('useCacheForVideo：搬运暂存区（新鲜且 URL 匹配），且只搬一次（用后即焚）', () => {
    cache.stageSegments('nextUrl', [['fragX', new ArrayBuffer(10)]])

    cache.useCacheForVideo('nextUrl')
    expect(cache.segPrefetchCache.has('fragX')).toBe(true)

    // 换到别的地址再换回来：staged 已在第一次用后清空，第二次不会重新出现
    cache.useCacheForVideo('thirdUrl')
    cache.useCacheForVideo('nextUrl')
    expect(cache.segPrefetchCache.has('fragX')).toBe(false)
  })

  it('useCacheForVideo：不搬运——暂存的 URL 与切换目标不一致', () => {
    cache.stageSegments('X', [['fragY', new ArrayBuffer(10)]])

    cache.useCacheForVideo('Y')

    expect(cache.segPrefetchCache.has('fragY')).toBe(false)
  })

  it('useCacheForVideo：不搬运——暂存已超过 STAGE_TTL_MS', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    cache.stageSegments('X', [['fragZ', new ArrayBuffer(10)]])
    nowSpy.mockReturnValue(1_000_000 + STAGE_TTL_MS + 1000)

    cache.useCacheForVideo('X')

    expect(cache.segPrefetchCache.has('fragZ')).toBe(false)
    nowSpy.mockRestore()
  })

  it('abortAllPrefetches：全部取消并清空两张表', () => {
    const abort1 = vi.fn()
    const abort2 = vi.fn()
    cache.segPrefetchAborts.set('a', { abort: abort1 } as unknown as AbortController)
    cache.segPrefetchAborts.set('b', { abort: abort2 } as unknown as AbortController)
    cache.segPrefetching.set('a', Promise.resolve(new ArrayBuffer(0)))

    cache.abortAllPrefetches()

    expect(abort1).toHaveBeenCalledTimes(1)
    expect(abort2).toHaveBeenCalledTimes(1)
    expect(cache.segPrefetchAborts.size).toBe(0)
    expect(cache.segPrefetching.size).toBe(0)
  })

  it('refreshCacheStats：统计条数与字节数', () => {
    cache.segPrefetchCache.set('a', { buf: new ArrayBuffer(10), ts: Date.now() })
    cache.segPrefetchCache.set('b', { buf: new ArrayBuffer(25), ts: Date.now() })

    cache.refreshCacheStats()

    expect(cache.prefetchInfo.value.cached).toBe(2)
    expect(cache.prefetchInfo.value.bytes).toBe(35)
  })

  describe('周期清理（startPrefetchCleanup / stopPrefetchCleanup）', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => {
      cache.stopPrefetchCleanup()
      vi.useRealTimers()
    })

    it('startPrefetchCleanup：每 5 分钟清一次过期项', () => {
      const oldTs = Date.now() - PREFETCH_TTL_MS - 1000
      cache.segPrefetchCache.set('expired', { buf: new ArrayBuffer(10), ts: oldTs })

      cache.startPrefetchCleanup()
      vi.advanceTimersByTime(5 * 60 * 1000)

      expect(cache.segPrefetchCache.has('expired')).toBe(false)
      expect(cache.prefetchInfo.value.cached).toBe(0)
    })

    it('重复调用 startPrefetchCleanup 不会重复建定时器（已在跑则跳过）', () => {
      const spy = vi.spyOn(global, 'setInterval')

      cache.startPrefetchCleanup()
      cache.startPrefetchCleanup()

      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('stopPrefetchCleanup 后定时清理不再触发', () => {
      cache.startPrefetchCleanup()
      cache.stopPrefetchCleanup()
      const oldTs = Date.now() - PREFETCH_TTL_MS - 1000
      cache.segPrefetchCache.set('expiredAfterStop', { buf: new ArrayBuffer(10), ts: oldTs })

      vi.advanceTimersByTime(10 * 60 * 1000)

      expect(cache.segPrefetchCache.has('expiredAfterStop')).toBe(true)
    })
  })
})
