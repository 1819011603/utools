/**
 * 起播预缓冲的行为钉子（autoplay）。
 *
 * 起播门槛「够播几秒」×倍速，定位类起播（切集/拖进度）是冷启动的一半，随近期卡顿次数翻倍
 * （封顶 ×8）；FLV 不看门槛只看 readyState；`play()` 失败分 NotAllowedError（静音重试）和
 * 其余（主要 AbortError，过一会儿再试，最多 3 次）两类；canplay 只许挂一发起播。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useAutoplayScheduler } from './autoplay'

function setup() {
  const videoEl = ref<any>({ play: vi.fn(() => Promise.resolve()) })
  const isHls = ref(true)
  const isFlv = ref(false)
  const isBuffering = ref(false)
  const playbackRate = ref(1)
  const isMuted = ref(false)
  const autoMuted = ref(false)

  let ahead = 0
  let relocating = false
  const clearRelocating = vi.fn()
  let stallCount = 0
  let smoothSecs = 0

  let autoPlayHook: (() => void) | null = null
  let tickHooks: Array<() => void> = []

  const engine: any = {
    getAheadBuffered: () => ahead,
    isRelocatingStart: () => relocating,
    clearRelocating,
    registerTickHook: (fn: () => void) => { tickHooks.push(fn) },
    registerAutoPlayHook: (fn: () => void) => { autoPlayHook = fn },
    registerDestroyHook: (_fn: () => void) => {},
    stall: { stallCount: { value: 0 }, smoothSecs: { value: 0 } },
  }
  Object.defineProperty(engine.stall.stallCount, 'value', { get: () => stallCount })
  Object.defineProperty(engine.stall.smoothSecs, 'value', { get: () => smoothSecs })

  const media: any = { videoEl, isHls, isFlv, isBuffering, playbackRate, isMuted, autoMuted }
  const scheduler = useAutoplayScheduler({ media, engine })

  return {
    scheduler, videoEl, isHls, isFlv, isBuffering, playbackRate, isMuted, autoMuted,
    clearRelocating,
    setAhead: (v: number) => { ahead = v },
    setRelocating: (v: boolean) => { relocating = v },
    setStallCount: (v: number) => { stallCount = v },
    setSmoothSecs: (v: number) => { smoothSecs = v },
    runTickHooks: () => tickHooks.forEach(fn => fn()),
    runAutoPlayHook: () => autoPlayHook?.(),
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('起播门槛：够播几秒 × 倍速', () => {
  it('定位类起播（relocating）门槛是 PLAYABLE_SECS(2) × 倍速，未到不起播', () => {
    const s = setup()
    s.setRelocating(true)
    s.setAhead(1.9)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(500)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
  })

  it('定位类起播：达到门槛（2s）→ 立刻起播', () => {
    const s = setup()
    s.setRelocating(true)
    s.setAhead(2)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(0)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
    expect(s.clearRelocating).toHaveBeenCalledTimes(1)
  })

  it('冷启动（非 relocating）门槛翻倍：2s 不够，要到 4s 才起播', () => {
    const s = setup()
    s.setRelocating(false)
    s.setAhead(2)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(500)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
    s.setAhead(4)
    vi.advanceTimersByTime(100)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })

  it('倍速要乘进门槛：3x 下定位类起播门槛是 6s', () => {
    const s = setup()
    s.setRelocating(true)
    s.playbackRate.value = 3
    s.setAhead(5.9)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(500)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
    s.setAhead(6)
    vi.advanceTimersByTime(100)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })

  it('AUTOPLAY_MAX_WAIT_MS(8000ms) 兜底：门槛始终不够也要起播', () => {
    const s = setup()
    s.setRelocating(false)
    s.setAhead(0)   // 永远不够
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(7999)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })
})

describe('近期卡顿抬高门槛（封顶 ×8），连续流畅后归零', () => {
  it('卡过一次 → 门槛翻倍（relocating 基准 2s → 4s）', () => {
    const s = setup()
    s.setRelocating(true)
    s.setStallCount(1)
    s.runTickHooks()   // 触发 refreshStallEscalation，读到 stallCount 变化
    s.setAhead(3.9)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(500)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
    s.setAhead(4)
    vi.advanceTimersByTime(100)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })

  it('连续流畅够时长（smoothSecs ≥ 2×倍速）后归零，门槛回到基准', () => {
    const s = setup()
    s.setRelocating(true)
    s.setStallCount(1)
    s.runTickHooks()
    // 再次刷新时连续流畅已经够了（1x 下阈值 2s）→ recentStalls 清零
    s.setSmoothSecs(2)
    s.runTickHooks()
    s.setAhead(2)   // 若门槛没清零需要 4s，这里给 2s 验证已经回到基准
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(0)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })
})

describe('FLV：不看「够播几秒」的门槛，只看 readyState 或等满 2s', () => {
  it('readyState ≥ 3 → 立刻起播，不管缓冲秒数', () => {
    const s = setup()
    s.isFlv.value = true
    s.videoEl.value.readyState = 3
    s.setAhead(0)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(0)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })

  it('readyState 不够时，等满 2s 也兜底起播', () => {
    const s = setup()
    s.isFlv.value = true
    s.videoEl.value.readyState = 0
    s.setAhead(0)
    s.scheduler.scheduleAutoPlay()
    vi.advanceTimersByTime(1999)
    expect(s.videoEl.value.play).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })
})

describe('play() 失败处理：NotAllowedError 与其余错误（主要 AbortError）分开处理', () => {
  it('NotAllowedError → 改静音重播一次，不算放弃', async () => {
    const s = setup()
    const err = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    s.videoEl.value.play = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(undefined)
    s.setRelocating(true)
    s.setAhead(2)
    s.scheduler.scheduleAutoPlay()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(2)
    expect(s.videoEl.value.muted).toBe(true)
    expect(s.isMuted.value).toBe(true)
    expect(s.autoMuted.value).toBe(true)
  })

  it('静音重播仍是 NotAllowedError → 彻底放弃，把静音状态还原', async () => {
    const s = setup()
    const err = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    s.videoEl.value.play = vi.fn().mockRejectedValue(err)
    s.autoMuted.value = true   // 已经是静音重试过的状态
    s.setRelocating(true)
    s.setAhead(2)
    s.scheduler.scheduleAutoPlay()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.videoEl.value.muted).toBe(false)
    expect(s.isMuted.value).toBe(false)
    expect(s.autoMuted.value).toBe(false)
  })

  it('AbortError（load 打断）→ 400ms 后重试，最多 3 次后放弃', async () => {
    const s = setup()
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    s.videoEl.value.play = vi.fn().mockRejectedValue(err)
    s.setRelocating(true)
    s.setAhead(2)
    s.scheduler.scheduleAutoPlay()
    await vi.advanceTimersByTimeAsync(0)     // 第 1 次（tries=0）
    await vi.advanceTimersByTimeAsync(400)   // 第 2 次（tries=1）
    await vi.advanceTimersByTimeAsync(400)   // 第 3 次（tries=2）
    await vi.advanceTimersByTimeAsync(400)   // 第 4 次（tries=3）→ 达到上限，放弃
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(4)   // 不再重试
  })
})

describe('armCanPlayOnce：非 HLS 那条路 canplay 反复触发，只许挂一发起播', () => {
  it('第一次返回 true 并起播，第二次返回 false', () => {
    const s = setup()
    s.isHls.value = false
    s.setAhead(0)
    const first = s.scheduler.armCanPlayOnce()
    const second = s.scheduler.armCanPlayOnce()
    expect(first).toBe(true)
    expect(second).toBe(false)
  })
})

describe('HLS 走 MANIFEST_PARSED 触发起播（registerAutoPlayHook）', () => {
  it('引擎回调触发的就是 scheduleAutoPlay', () => {
    const s = setup()
    s.setRelocating(true)
    s.setAhead(2)
    s.runAutoPlayHook()
    vi.advanceTimersByTime(0)
    expect(s.videoEl.value.play).toHaveBeenCalledTimes(1)
  })
})
