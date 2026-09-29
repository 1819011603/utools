/**
 * 卡死自救阶梯的行为钉子（stallRecovery）。
 *
 * 核心规则（见模块头注释与 docs/player.md §转圈遮罩与卡死自救）：
 * 播放头处 MSE 有货 / 手上一点缓存都没有 → 一律不动手；有 2s 冷却；
 * 洞 ≤ 3s 直接跳过去且不占阶梯；阶梯每级只用一次、播放头一动就归零；
 * 四级顺序是 跳洞 → 整片放弃(flush+startLoad) → recoverMediaError → 停手报错；
 * `seeking` 卡住超过 3s 宽限期后仍要继续升级，不能被无限拦住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStallRecovery, type StallRecoveryDeps } from './stallRecovery'

// 起点要够大：lastFixAt 初始是 0，若 clock 起点太小，第一次调用会被冷却误伤
// （Date.now() - 0 < FIX_COOLDOWN_MS）。
let clock = 10_000_000
beforeEach(() => { clock = 10_000_000; vi.spyOn(Date, 'now').mockImplementation(() => clock) })
afterEach(() => { vi.restoreAllMocks() })

function makeFrag(start: number, end: number, sn: number) {
  return { start, end, sn, url: `seg-${sn}`, elementaryStreams: {}, byteRangeEndOffset: 0, gap: false, cc: 0 }
}

function setup(opts: { frags?: any[]; bufferedRanges?: Array<[number, number]> } = {}) {
  const frags = opts.frags ?? []
  const bufferedRanges = opts.bufferedRanges ?? []
  const video: any = {
    currentTime: 10,
    paused: false,
    seeking: false,
    buffered: {
      length: bufferedRanges.length,
      start: (i: number) => bufferedRanges[i][0],
      end: (i: number) => bufferedRanges[i][1],
    },
  }
  const hls: any = {
    currentLevel: 0,
    levels: [{ details: { fragments: frags } }],
    trigger: vi.fn(),
    startLoad: vi.fn(),
    recoverMediaError: vi.fn(),
  }
  let ahead = 0
  let cached = 5
  const onGiveUp = vi.fn()
  const deps: StallRecoveryDeps = {
    getVideoEl: () => video,
    getHls: () => hls,
    getAheadBuffered: () => ahead,
    getCachedAhead: () => cached,
    onGiveUp,
  }
  const recovery = useStallRecovery(deps)
  return {
    recovery, video, hls, onGiveUp,
    setAhead: (v: number) => { ahead = v },
    setCached: (v: number) => { cached = v },
  }
}

describe('两条硬约束：什么时候一律不动手', () => {
  it('播放头处 MSE 有货（>0.5s）→ 不动手', () => {
    const s = setup()
    s.setAhead(0.6)
    s.recovery.onBufferStalled()
    expect(s.hls.startLoad).not.toHaveBeenCalled()
    expect(s.hls.trigger).not.toHaveBeenCalled()
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled()
  })

  it('手上一点缓存都没有（<1s）→ 这是网络问题，不在这儿瞎跳', () => {
    const s = setup()
    s.setAhead(0)
    s.setCached(0.5)
    s.recovery.onBufferStalled()
    expect(s.hls.startLoad).not.toHaveBeenCalled()
    expect(s.hls.trigger).not.toHaveBeenCalled()
  })
})

describe('冷却：两次自救之间至少隔 FIX_COOLDOWN_MS（2000ms）', () => {
  it('冷却期内第二次调用无效，过了冷却才继续动作', () => {
    const s = setup({ bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)   // 第一次：命中阶梯①（微跳，找不到当前片）
    clock += 1999
    s.recovery.onBufferStalled()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)   // 冷却未到，原地不动
    clock += 1
    s.recovery.onBufferStalled()
    expect(s.hls.recoverMediaError).toHaveBeenCalledTimes(1)   // 冷却已过，升到阶梯②
  })
})

describe('阶梯①：洞 ≤ HOLE_JUMP_MAX(3s) 直接跳过去，不占阶梯', () => {
  it('洞 2s → 跳到洞后面那段起点 +0.05，不清缓冲、不重建', () => {
    const s = setup({ bufferedRanges: [[12, 50]] })   // 播放头 10，缺口到 12
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    expect(s.video.currentTime).toBeCloseTo(12.05, 5)
    expect(s.hls.trigger).not.toHaveBeenCalled()
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled()
  })

  it('跳洞不占阶梯：冷却后再次判定为需要升级时，走的仍是阶梯①（整片放弃），不是②', () => {
    const s = setup({ bufferedRanges: [[12, 50]] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()   // 跳洞，阶梯仍是 0
    clock += 2000
    s.video.buffered = { length: 0, start: () => 0, end: () => 0 }   // 这次没有洞可跳
    s.recovery.onBufferStalled()
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)       // 阶梯①：微跳（无分片表可清）
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled() // 而不是阶梯②
  })

  it('洞 > HOLE_JUMP_MAX(3s) → 不满足跳洞条件，直接进阶梯', () => {
    const s = setup({ bufferedRanges: [[14, 50]] })   // 播放头 10，缺口 4s
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    expect(s.video.currentTime).not.toBeCloseTo(14.05, 5)
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)   // 落到阶梯①（微跳，无分片表可清）
  })
})

describe('阶梯②③④：整片放弃 → recoverMediaError → 停手报错', () => {
  it('①整片放弃：清这一片(BUFFER_FLUSHING) + 跳到 frag.end+0.3 + startLoad(落点)', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    expect(s.hls.trigger).toHaveBeenCalledWith('hlsBufferFlushing', { startOffset: 8, endOffset: 10.2, type: null })
    expect(s.video.currentTime).toBeCloseTo(10.5, 5)
    expect(s.hls.startLoad).toHaveBeenCalledWith(10.5)
  })

  it('②仍然冻住（第二次触发）→ recoverMediaError()', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    clock += 2000
    s.recovery.onBufferStalled()
    expect(s.hls.recoverMediaError).toHaveBeenCalledTimes(1)
  })

  it('③三级都无效（第三次触发）→ 停手，调用 onGiveUp', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()
    clock += 2000
    s.recovery.onBufferStalled()
    clock += 2000
    s.recovery.onBufferStalled()
    expect(s.onGiveUp).toHaveBeenCalledTimes(1)
  })
})

describe('播放头一动，阶梯清零重新从①开始', () => {
  it('tick() 检测到播放头前进 → 下一次自救重新是「整片放弃」而不是接着往上升级', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()   // 阶梯①
    expect(s.hls.trigger).toHaveBeenCalledTimes(1)

    s.recovery.tick()              // 建立 tick 的位置基准
    s.video.currentTime = 20       // 播放头真的动了
    s.recovery.tick()              // 检测到前进 → step 归零

    clock += 2000
    s.recovery.onBufferStalled()   // 应该重新是阶梯①，不是②
    expect(s.hls.startLoad).toHaveBeenCalledTimes(2)   // 两次都停在阶梯①（微跳/整片放弃都会 startLoad）
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled()
  })
})

describe('reset()：换流/切集时清空阶梯与冷却', () => {
  it('reset 之后立刻可以再次动手（冷却与阶梯都清零）', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.onBufferStalled()   // 阶梯①，且设了冷却
    s.recovery.reset()
    s.recovery.onBufferStalled()   // 冷却应已清零，立刻可以再动手，且重新是阶梯①
    expect(s.hls.startLoad).toHaveBeenCalledTimes(2)   // 两次都停在阶梯①，不是②（recoverMediaError）
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled()
  })
})

describe('seeking 宽限期：SEEK_GRACE_MS(3000ms)', () => {
  it('宽限期内不动手；超过宽限期仍停在 seeking=true → 继续升级', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.video.seeking = true

    s.recovery.onBufferStalled()   // 刚开始 seek，宽限期内，不动
    expect(s.hls.trigger).not.toHaveBeenCalled()

    clock += 2999
    s.recovery.onBufferStalled()   // 还没到 3000ms，仍不动
    expect(s.hls.trigger).not.toHaveBeenCalled()

    clock += 1
    s.recovery.onBufferStalled()   // 满 3000ms，seek 仍未落地 → 继续升级
    expect(s.hls.trigger).toHaveBeenCalledTimes(1)
  })
})

describe('tick()：心跳兜底与暂停/冻结判定', () => {
  it('暂停时 tick() 不动手（重置位置采样，不触发自救）', () => {
    const s = setup({ bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.video.paused = true
    s.recovery.tick()
    clock += 3000
    s.recovery.tick()
    expect(s.hls.trigger).not.toHaveBeenCalled()
    expect(s.hls.recoverMediaError).not.toHaveBeenCalled()
  })

  it('播放头冻住达到 FROZEN_MS(2000ms) 未动 → 自动触发自救', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.recovery.tick()   // 建立基准：lastTime=10, lastMoveAt=now
    clock += 2100        // 冻住超过 2000ms，位置没变
    s.recovery.tick()
    expect(s.hls.trigger).toHaveBeenCalledTimes(1)
  })

  it('seeking 一直没落地也走心跳兜底（tick 不拦 seeking，交给 attempt 里的宽限期判）', () => {
    const frags = [makeFrag(8, 10.2, 5)]
    const s = setup({ frags, bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.video.seeking = true
    s.recovery.tick()   // 第一次进入 seeking：记录 seekingSince，宽限期内不动
    expect(s.hls.startLoad).not.toHaveBeenCalled()
    clock += 3000
    s.recovery.tick()   // 宽限期已过，仍卡在 seeking=true → 继续升级
    expect(s.hls.startLoad).toHaveBeenCalledTimes(1)
  })
})

describe('v/hls 缺失或暂停中：attempt 直接跳过', () => {
  it('video.paused → 不动手', () => {
    const s = setup({ bufferedRanges: [] })
    s.setAhead(0)
    s.setCached(5)
    s.video.paused = true
    s.recovery.onBufferStalled()
    expect(s.hls.trigger).not.toHaveBeenCalled()
  })
})
