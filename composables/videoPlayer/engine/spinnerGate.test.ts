/**
 * 转圈遮罩延迟闸门的行为钉子（spinnerGate）。
 *
 * 两级判据：150ms 时只有「有效可播（MSE + 预取缓存）也不足 2s」才亮（真在等网络）；
 * 800ms 时只要 MSE 前向仍不足 2s 就无条件亮（货在手上却没播起来 = 反常，必须让用户看见）。
 * 两个定时器到点时都要自检（暂停/seek/已恢复 → 放弃）。FLV 只认「播放头动没动」，
 * 起播那一刻（还没观察到前进）转圈照亮。`performance.now()` 由 `vi.useFakeTimers()` 一并接管。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useSpinnerGate } from './spinnerGate'

function setup() {
  const isFlv = ref(false)
  const isBuffering = ref(false)
  let ahead = 0
  let cached = 0
  const video: any = { paused: false, seeking: false, currentTime: 0 }
  const gate = useSpinnerGate({
    getVideoEl: () => video,
    isFlv,
    isBuffering,
    getAheadBuffered: () => ahead,
    getCachedAhead: () => cached,
  })
  return {
    gate, isFlv, isBuffering, video,
    setAhead: (v: number) => { ahead = v },
    setCached: (v: number) => { cached = v },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('150ms 软阈值：只有连预取缓存都没货才亮', () => {
  it('MSE 与预取缓存都不足 2s → 150ms 时点亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(1)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(150)
    expect(s.isBuffering.value).toBe(true)
  })

  it('MSE 不足 2s，但预取缓存 ≥2s（数据在手上）→ 150ms 时不亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(2)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(150)
    expect(s.isBuffering.value).toBe(false)
  })
})

describe('800ms 硬阈值：货在手上却没播起来也要亮', () => {
  it('MSE 不足 2s（即使预取缓存 ≥2s）→ 800ms 时无条件点亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(5)   // 货明明在手上
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(150)
    expect(s.isBuffering.value).toBe(false)   // 150ms 判据没过，先不亮
    vi.advanceTimersByTime(650)                // 累计 800ms
    expect(s.isBuffering.value).toBe(true)     // 800ms 判据无条件亮
  })

  it('到 800ms 时 MSE 已经追上（≥2s）→ 不亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(5)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(500)
    s.setAhead(3)   // 中途追上了
    vi.advanceTimersByTime(300)   // 到 800ms
    expect(s.isBuffering.value).toBe(false)
  })
})

describe('到点自检：暂停/seek 中途发生就放弃点亮', () => {
  it('到点时已暂停 → 不亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(0)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(100)
    s.video.paused = true
    vi.advanceTimersByTime(700)
    expect(s.isBuffering.value).toBe(false)
  })

  it('到点时正在 seek → 不亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(0)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(100)
    s.video.seeking = true
    vi.advanceTimersByTime(700)
    expect(s.isBuffering.value).toBe(false)
  })
})

describe('cancelBufferingGate：取消后定时器不再点亮', () => {
  it('armBufferingGate 之后立刻 cancel → 到点也不亮', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(0)
    s.gate.armBufferingGate()
    s.gate.cancelBufferingGate()
    vi.advanceTimersByTime(800)
    expect(s.isBuffering.value).toBe(false)
  })
})

describe('armBufferingGate 幂等：已经挂着就不重新起表', () => {
  it('重复调用不会把已经跑到一半的 150ms 表重置', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(0)
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(100)
    s.gate.armBufferingGate()   // 重复调用，若重新起表则 150ms 判据会被推迟
    vi.advanceTimersByTime(50)   // 累计 150ms
    expect(s.isBuffering.value).toBe(true)
  })
})

describe('FLV：只认播放头动没动，不看存货秒数', () => {
  it('起播那一刻（还没观察到前进）→ 转圈照亮', () => {
    const s = setup()
    s.isFlv.value = true
    s.video.currentTime = 10
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(800)
    expect(s.isBuffering.value).toBe(true)
  })

  it('播放头持续前进（每 300ms 内至少动一次）→ 150ms/800ms 两档判据都不亮', () => {
    const s = setup()
    s.isFlv.value = true
    s.video.currentTime = 10
    s.gate.dropSpinnerIfPlaying()   // t=0：建立基准（第一拍本身不算「在动」，还没有可比的前一个值）
    s.gate.armBufferingGate()
    vi.advanceTimersByTime(100)
    s.video.currentTime = 10.5
    s.gate.dropSpinnerIfPlaying()   // t=100：观察到一次前进，150ms 软阈值到点时判定为「在动」
    vi.advanceTimersByTime(300)     // 到 t=400
    s.video.currentTime = 11
    s.gate.dropSpinnerIfPlaying()   // t=400：继续前进
    vi.advanceTimersByTime(300)     // 到 t=700
    s.video.currentTime = 11.5
    s.gate.dropSpinnerIfPlaying()   // t=700：继续前进，落在 800ms 硬阈值的 FLV_STALL_MS(700ms) 窗口内
    vi.advanceTimersByTime(100)     // 到 t=800，硬阈值到点自检
    expect(s.isBuffering.value).toBe(false)
  })
})

describe('兜底熄灯：dropSpinnerIfPlaying', () => {
  it('非 FLV：正在播 + readyState≥3 + MSE 前向≥1s → 熄灯', () => {
    const s = setup()
    s.isBuffering.value = true
    s.video.readyState = 3
    s.setAhead(1)
    s.gate.dropSpinnerIfPlaying()
    expect(s.isBuffering.value).toBe(false)
  })

  it('非 FLV：readyState 不够（<3）→ 不熄灯', () => {
    const s = setup()
    s.isBuffering.value = true
    s.video.readyState = 2
    s.setAhead(5)
    s.gate.dropSpinnerIfPlaying()
    expect(s.isBuffering.value).toBe(true)
  })

  it('非 FLV：暂停中 → 不熄灯', () => {
    const s = setup()
    s.isBuffering.value = true
    s.video.readyState = 3
    s.video.paused = true
    s.setAhead(5)
    s.gate.dropSpinnerIfPlaying()
    expect(s.isBuffering.value).toBe(true)
  })
})
