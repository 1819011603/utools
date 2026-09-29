/**
 * hls.js 致命网络错误处理的行为钉子（hlsErrors）。
 *
 * 两条：① 重拉一律带播放头位置（裸 startLoad() 会按出错那一刻的 lastCurrentTime 挑片）；
 * ② 换网恢复窗口内**绝不进**「重新取址 → 重探 → 销毁」那条慢路径，退完三档按最后一档接着等。
 * `isOffline` / `isRecovering` / `waitForNet` 来自 netWatch，mock 掉以便控制。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ offline: false, recovering: false, waiters: [] as Array<() => void> }))
vi.mock('./netWatch', () => ({
  isOffline: () => h.offline,
  isRecovering: () => h.recovering,
  waitForNet: (cb: () => void) => { h.waiters.push(cb) },
}))

import { useHlsErrorHandler } from './hlsErrors'

const HlsLib = {
  ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' },
  ErrorDetails: { BUFFER_STALLED_ERROR: 'bufferStalledError' },
}
const netErr = { type: 'networkError', details: 'fragLoadError', fatal: true }

function setup(currentTime = 42) {
  const hls = { startLoad: vi.fn(), recoverMediaError: vi.fn(), media: { currentTime } }
  const refetchUrl = vi.fn(async () => true)
  const escalateStrategy = vi.fn(() => true)
  const giveUp = vi.fn()
  const handler = useHlsErrorHandler({
    HlsLib,
    getHls: () => hls,
    setError: (m: string) => m,
    failMessage: (f: string) => f,
    giveUp,
    clearIfUnchanged: () => {},
    refetchUrl,
    escalateStrategy,
    onBufferStalled: () => {},
  })
  return { handler, hls, refetchUrl, giveUp }
}

beforeEach(() => { vi.useFakeTimers(); h.offline = false; h.recovering = false; h.waiters = [] })
afterEach(() => { vi.useRealTimers() })

describe('重拉带播放头位置', () => {
  it('常态重试：startLoad(当前播放头)，不是裸 startLoad()', () => {
    const { handler, hls } = setup(42)
    handler.onHlsError(netErr)
    vi.advanceTimersByTime(1000)
    expect(hls.startLoad).toHaveBeenCalledWith(42)
  })

  it('断网：等网回来那一发也带位置', () => {
    h.offline = true
    const { handler, hls } = setup(88)
    handler.onHlsError(netErr)
    expect(hls.startLoad).not.toHaveBeenCalled()      // 没网什么都不做
    h.offline = false
    h.waiters.forEach(cb => cb())
    expect(hls.startLoad).toHaveBeenCalledWith(88)
  })

  it('还没起播（播放头 0）→ 交给 hls.js 自己定（-1）', () => {
    const { handler, hls } = setup(0)
    handler.onHlsError(netErr)
    vi.advanceTimersByTime(1000)
    expect(hls.startLoad).toHaveBeenCalledWith(-1)
  })
})

describe('换网恢复窗口', () => {
  it('窗口内连着失败十次也不进慢路径、不烧额度，退完三档按 1200ms 接着试', () => {
    h.recovering = true
    const { handler, hls, refetchUrl, giveUp } = setup()
    const waits = [300, 600, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200]
    for (const w of waits) {
      handler.onHlsError(netErr)
      vi.advanceTimersByTime(w - 1)
      const before = hls.startLoad.mock.calls.length
      vi.advanceTimersByTime(1)
      expect(hls.startLoad.mock.calls.length).toBe(before + 1)
    }
    expect(refetchUrl).not.toHaveBeenCalled()
    expect(giveUp).not.toHaveBeenCalled()
    expect(handler.hlsRetryCount.value).toBe(0)
  })

  it('窗口过了才回到常态：3 次重试后进「重新取址」', async () => {
    const { handler, refetchUrl } = setup()
    for (let i = 0; i < 3; i++) handler.onHlsError(netErr)
    expect(refetchUrl).not.toHaveBeenCalled()
    handler.onHlsError(netErr)
    await Promise.resolve()
    expect(refetchUrl).toHaveBeenCalledTimes(1)
  })

  it('成功一片（noteLoadOk）→ 退避从 300ms 重新起算', () => {
    h.recovering = true
    const { handler, hls } = setup()
    handler.onHlsError(netErr); handler.onHlsError(netErr); handler.onHlsError(netErr)
    handler.noteLoadOk()
    vi.runAllTimers()
    hls.startLoad.mockClear()
    handler.onHlsError(netErr)
    vi.advanceTimersByTime(300)
    expect(hls.startLoad).toHaveBeenCalledTimes(1)
  })
})
