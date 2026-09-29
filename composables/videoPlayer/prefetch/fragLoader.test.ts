/**
 * 关键分片「卡死」的处理（对冲竞速 + 硬超时跳片）的行为钉子。
 *
 * 用「永不 resolve、只在 abort 时 reject」的 fetch 桩模拟「大小一直没变、连接挂着」，
 * 配合假定时器验证：到 skipMs 一定 abort 所有连接 + 跳片 + 回调 onError；
 * 没到就拿到则不跳片；并发竞速条数受 maxRacers 限制。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { createFragLoaderFactory } from './fragLoader'
import { useLaneControl } from './lanes'

const TP = { hedgeMs: 1000, skipMs: 5000, maxRacers: 2 }

function makeFactory(tp: any = TP, skipSegment = vi.fn(() => true)) {
  const cache: any = {
    segPrefetchCache: new Map(),
    segPrefetching: new Map(),
    prefetchInfo: ref({ bufferSecs: 0, threads: 0, cached: 0, pending: 0, bytes: 0 }),
    getPrefetchedBuf: () => null,
    evictPrefetchCache: () => {},
  }
  const factory = createFragLoaderFactory({
    cache,
    lanes: useLaneControl(() => ['direct']),
    tier: () => tp,
    sampleSpeed: () => {},
    segInflightStart: new Map(),
    skipSegment,
  })
  return { factory, skipSegment }
}

/** 永不 resolve；被 abort 时以 AbortError reject（模拟卡死的连接） */
const stuckFetch = () => vi.fn((_url: string, opts: any) => new Promise((_res, rej) => {
  opts?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
}))

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('fLoader / 关键片卡死', () => {
  it('卡到 skipMs → abort 全部竞速连接 + 跳片 + 回调 onError（不会无限等）', () => {
    vi.useFakeTimers()
    const fetchMock = stuckFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { factory, skipSegment } = makeFactory()
    const Loader = factory.createHlsFragLoader() as any
    const l = new Loader()
    const cb = { onSuccess: vi.fn(), onError: vi.fn() }
    l.load({ url: 'frag1', frag: { sn: 1, start: 0, duration: 4 } }, {}, cb)

    expect(fetchMock).toHaveBeenCalledTimes(1)          // 立刻起第一条
    vi.advanceTimersByTime(TP.hedgeMs)                  // 到对冲点 → 追加一条
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(TP.skipMs)                   // 到硬超时
    expect(skipSegment).toHaveBeenCalledTimes(1)
    expect(cb.onError).toHaveBeenCalledTimes(1)
    expect(cb.onSuccess).not.toHaveBeenCalled()
  })

  it('没到 skipMs 就拿到 → onSuccess，且之后不再跳片', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
    vi.stubGlobal('fetch', fetchMock)
    const { factory, skipSegment } = makeFactory()
    const Loader = factory.createHlsFragLoader() as any
    const l = new Loader()
    const cb = { onSuccess: vi.fn(), onError: vi.fn() }
    l.load({ url: 'frag2', frag: { sn: 2 } }, {}, cb)

    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(cb.onSuccess).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TP.skipMs * 2)
    expect(skipSegment).not.toHaveBeenCalled()
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('同时竞速条数受 maxRacers 限制（不会无限开连接）', () => {
    vi.useFakeTimers()
    const fetchMock = stuckFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { factory } = makeFactory({ hedgeMs: 1000, skipMs: 20000, maxRacers: 2 })
    const Loader = factory.createHlsFragLoader() as any
    const l = new Loader()
    l.load({ url: 'frag3', frag: { sn: 3 } }, {}, { onSuccess: vi.fn(), onError: vi.fn() })

    vi.advanceTimersByTime(19000)   // 远超过对冲点，但 maxRacers=2
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('一条失败即归还并发额度（额度是「同时几条」，不是「一共几次」）', async () => {
    vi.useFakeTimers()
    // 立刻失败（非 abort）→ 应不断重试，但同时在途始终 ≤ maxRacers
    let inflight = 0, peak = 0
    const fetchMock = vi.fn(() => {
      inflight++; peak = Math.max(peak, inflight)
      return new Promise((_res, rej) => setTimeout(() => { inflight--; rej(new Error('net')) }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { factory } = makeFactory({ hedgeMs: 3000, skipMs: 10000, maxRacers: 2 })
    const Loader = factory.createHlsFragLoader() as any
    const l = new Loader()
    l.load({ url: 'frag4', frag: { sn: 4 } }, {}, { onSuccess: vi.fn(), onError: vi.fn() })

    await vi.advanceTimersByTimeAsync(9000)
    expect(peak).toBeLessThanOrEqual(2)                 // 在途不超过额度
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)  // 失败后仍在重试（没被额度烧光）
  })
})
