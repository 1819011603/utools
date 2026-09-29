/**
 * 「无进展看门狗」的行为钉子：连接挂着不吐数据时按**字节进展**判死，而不是干等总超时。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchBodyWithStallWatch, StallError } from './fetchBody'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 造一个流式响应；`enqueue` 决定流怎么吐数据（不 enqueue 就是卡死）。abort 时把流 error 掉。 */
function streamFetch(enqueue: (c: ReadableStreamDefaultController) => void) {
  return vi.fn((_url: string, opts: any) => {
    let sc: ReadableStreamDefaultController
    const stream = new ReadableStream({ start(c) { sc = c; enqueue(c) } })
    opts.signal.addEventListener('abort', () => { try { sc!.error(new DOMException('aborted', 'AbortError')) } catch {} })
    return Promise.resolve({ ok: true, body: stream })
  })
}

describe('fetchBodyWithStallWatch', () => {
  it('正常流 → 拼出完整 ArrayBuffer', async () => {
    vi.stubGlobal('fetch', streamFetch(c => {
      c.enqueue(new Uint8Array([1, 2, 3]))
      c.enqueue(new Uint8Array([4, 5]))
      c.close()
    }))
    const buf = await fetchBodyWithStallWatch(new AbortController(), 'u', 1000)
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 4, 5])
  })

  it('HTTP 非 2xx → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403 })))
    await expect(fetchBodyWithStallWatch(new AbortController(), 'u', 1000)).rejects.toThrow('HTTP 403')
  })

  it('连接挂着不吐数据 → 看门狗 abort 并抛 StallError', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', streamFetch(() => { /* 永不 enqueue = 卡死 */ }))
    const p = fetchBodyWithStallWatch(new AbortController(), 'u', 100)
    const assertion = expect(p).rejects.toBeInstanceOf(StallError)   // 先挂上 handler，别让拒绝变成 unhandled
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
  })

  it('慢但在下（有 chunk 就续期）→ 不杀', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', streamFetch(c => {
      setTimeout(() => c.enqueue(new Uint8Array([1])), 50)
      setTimeout(() => c.enqueue(new Uint8Array([2])), 100)
      setTimeout(() => c.close(), 150)
    }))
    const p = fetchBodyWithStallWatch(new AbortController(), 'u', 200)
    await vi.advanceTimersByTimeAsync(600)
    expect([...new Uint8Array(await p)]).toEqual([1, 2])
  })
})
