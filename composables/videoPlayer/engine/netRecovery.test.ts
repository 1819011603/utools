/**
 * 「换网恢复补枪」状态机的行为钉子（netRecovery）。
 *
 * 关键点：网络一变先作废旧结论 + 打一枪 + 重开预取；恢复窗口内每秒复查，
 * 但**必须以「毫无进展」为条件补枪**，且总共不超过 4 枪（否则慢源永远下不完第一片）。
 * `isRecovering` 来自 netWatch，这里 mock 掉以便控制窗口。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const h = vi.hoisted(() => ({ recovering: false }))
vi.mock('./netWatch', () => ({ isRecovering: () => h.recovering }))

import { useNetRecovery } from './netRecovery'

let clock = 1000

function setup() {
  let ahead = 0
  const video: any = { currentTime: 10, paused: true, readyState: 0 }
  const hls = { startLoad: vi.fn() }
  const errorMessage = ref('')
  const invalidateNetworkState = vi.fn()
  const primePrefetch = vi.fn()
  const rec = useNetRecovery({
    getVideoEl: () => video,
    getHls: () => hls as any,
    getAheadBuffered: () => ahead,
    getVideoUrl: () => 'https://x/y.m3u8',
    errorMessage,
    invalidateNetworkState,
    primePrefetch,
  })
  return {
    rec, hls, errorMessage, invalidateNetworkState, primePrefetch, video,
    setAhead: (v: number) => { ahead = v },
  }
}

beforeEach(() => { clock = 1000; h.recovering = false; vi.spyOn(Date, 'now').mockImplementation(() => clock) })
afterEach(() => { vi.restoreAllMocks() })

describe('onNetChanged：网络一变先打一枪', () => {
  it('作废旧结论 + 清「网络已断开」提示 + startLoad(位置) + 重开预取', () => {
    const s = setup()
    s.errorMessage.value = '网络已断开，恢复后会自动继续'
    s.rec.onNetChanged()
    expect(s.invalidateNetworkState).toHaveBeenCalledTimes(1)
    expect(s.errorMessage.value).toBe('')
    expect(s.hls.startLoad).toHaveBeenCalledWith(10)
    expect(s.primePrefetch).toHaveBeenCalledTimes(1)
  })

  it('已经在播 → 不打断（不发 startLoad）', () => {
    const s = setup()
    s.video.paused = false; s.video.readyState = 3; s.setAhead(2)
    s.rec.onNetChanged()
    expect(s.hls.startLoad).not.toHaveBeenCalled()
  })
})

describe('recoverTick：恢复窗口内的补枪闸门', () => {
  it('不在恢复窗口 → 什么都不做', () => {
    const s = setup()
    h.recovering = false
    s.rec.recoverTick()
    expect(s.hls.startLoad).not.toHaveBeenCalled()
  })

  it('两枪之间至少隔 RECOVER_SHOT_GAP_MS（2s）', () => {
    const s = setup()
    h.recovering = true
    s.rec.onNetChanged()                 // 第 1 枪
    clock = 2000                          // 只过 1s
    s.rec.recoverTick()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)
    clock = 4000                          // 过了 3s
    s.rec.recoverTick()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(2)
  })

  it('缓冲涨了 = 上一枪见效 → 不打断', () => {
    const s = setup()
    h.recovering = true
    s.rec.onNetChanged()                 // 第 1 枪，此时 ahead=0
    s.setAhead(1)                         // 缓冲涨了
    clock = 4000
    s.rec.recoverTick()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)
  })

  it('最多 4 枪（同一招重复十次无效就该换招）', () => {
    const s = setup()
    h.recovering = true
    s.rec.onNetChanged()                 // 枪 1
    for (let i = 0; i < 5; i++) { clock += 3000; s.rec.recoverTick() }
    expect(s.hls.startLoad).toHaveBeenCalledTimes(4)
  })
})

describe('onNetworkOffline：只说一句话', () => {
  it('没提示时才写，已有提示不覆盖', () => {
    const s = setup()
    s.rec.onNetworkOffline()
    expect(s.errorMessage.value).toBe('网络已断开，恢复后会自动继续')
    s.errorMessage.value = '别的错误'
    s.rec.onNetworkOffline()
    expect(s.errorMessage.value).toBe('别的错误')
  })
})
