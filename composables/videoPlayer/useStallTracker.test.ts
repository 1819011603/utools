/**
 * 卡顿记录器的行为钉子（useStallTracker）。
 *
 * 以 <video> 的真实停顿为地面真值：waiting/stalled 进入停顿，playing/timeupdate 前进退出；
 * 排除 seek 与用户 pause 引起的等待；短于 MIN_STALL_MS(500ms) 的微停顿不计数但也不清连续流畅；
 * 停顿中的「往前微跳」（≤NUDGE_MAX_SEC）是恢复动作不是用户跳转，不结束/取消停顿；
 * 暂停只冻住连续流畅的表、不清零；`tick()` 每秒改绑（幂等）+ 位置采样兜底。
 * 全用 `performance.now()`，通过 `vi.spyOn` 手动推进（不依赖假计时器）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStallTracker } from './useStallTracker'

/** 最小可用的假 <video>：只实现 addEventListener/removeEventListener + 读写用到的字段 */
function makeVideo() {
  const listeners: Record<string, EventListener[]> = {}
  return {
    currentTime: 0,
    paused: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    duration: 100,
    addEventListener: (ev: string, fn: EventListener) => { (listeners[ev] ??= []).push(fn) },
    removeEventListener: (ev: string, fn: EventListener) => {
      listeners[ev] = (listeners[ev] ?? []).filter(f => f !== fn)
    },
    fire: (ev: string) => { for (const fn of listeners[ev] ?? []) fn(new Event(ev)) },
  }
}

// 起点不能是 0：源码里 `smoothSince`/`stallStart` 等都用 0 当「未设置」的哨兵值
// （`if (!smoothSince) …`），performance.now() 真返回 0 的概率极低，但测试里从 0 起算
// 会让 bind() 设的 smoothSince 恰好是 0、被当成「没在流畅播」。所有用例从非零时刻起算。
let clock = 10_000
let video: ReturnType<typeof makeVideo>
let tracker: ReturnType<typeof useStallTracker>

beforeEach(() => {
  clock = 10_000
  video = makeVideo()
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  tracker = useStallTracker(() => video as any)
  tracker.bind(video as any)
})
afterEach(() => { vi.restoreAllMocks() })

describe('真实停顿：waiting → playing', () => {
  it('停顿超过 MIN_STALL_MS(500ms) → 计一次卡顿', () => {
    video.fire('waiting')
    clock += 600
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(1)
    expect(tracker.stallMsTotal.value).toBe(600)
  })

  it('停顿短于 500ms（微停顿）→ 不计数，且不清连续流畅', () => {
    clock += 1000   // 先攒一段连续流畅
    video.fire('waiting')
    clock += 300   // 只卡了 300ms，不到 500ms
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(0)
    expect(tracker.stallMsTotal.value).toBe(0)
  })

  it('stalled 事件同样能触发计数（不是只认 waiting）', () => {
    video.fire('stalled')
    clock += 600
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(1)
  })
})

describe('排除暂停引起的等待', () => {
  it('video.paused 时 waiting 不算卡顿', () => {
    video.paused = true
    video.fire('waiting')
    expect(tracker.isStalling.value).toBe(false)
  })
})

describe('排除 seek 引起的等待', () => {
  it('不在停顿中时，seeking 不会被当成卡顿开始', () => {
    video.fire('seeking')
    expect(tracker.isStalling.value).toBe(false)
    video.fire('seeked')
    expect(tracker.stallCount.value).toBe(0)
  })

  it('停顿中用户跳转到很远的位置（超过 NUDGE_MAX_SEC）→ 取消这次计时，不计数', () => {
    video.currentTime = 10
    video.fire('waiting')
    clock += 600
    video.currentTime = 50   // 跳出 3.5s 范围，是用户主动跳转
    video.fire('seeking')
    expect(tracker.isStalling.value).toBe(false)
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(0)   // 被取消，不计入卡顿账
  })
})

describe('停顿中的恢复性微跳（≤ NUDGE_MAX_SEC=3.5s）不结束/取消停顿', () => {
  it('hls.js nudge 或缓冲空洞跳转不会把一次长卡顿切碎', () => {
    video.currentTime = 10
    video.fire('waiting')
    clock += 400
    video.currentTime = 10.4   // 恢复性微跳，delta=0.4 ≤ 3.5
    video.fire('seeking')
    expect(tracker.isStalling.value).toBe(true)   // 没被取消，停顿还在继续
    video.fire('seeked')       // seeked 到来时仍在停顿中，不重开连续流畅的表
    // seeked 之后规范里会先来一个 timeupdate，nudging 标记消费掉它、不当成真恢复
    video.currentTime = 10.4
    video.fire('timeupdate')
    expect(tracker.isStalling.value).toBe(true)
    clock += 700   // 累计卡顿 1100ms
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(1)
    expect(tracker.stallMsTotal.value).toBe(1100)   // 整段算一次，没被微跳切碎
  })
})

describe('暂停不是卡顿：只冻住连续流畅的表，不清零', () => {
  it('暂停期间读数冻结，恢复后接着涨（暂停时长被平移掉）', () => {
    // bind 时 video 未暂停，smoothSince = clock（beforeEach 里的 bind() 时刻）
    clock += 1000   // 流畅播了 1s
    expect(tracker.getSmoothSecs()).toBe(1)

    video.fire('pause')     // 暂停：冻住
    clock += 4000            // 暂停了 4s
    expect(tracker.getSmoothSecs()).toBe(1)   // 读数仍停在暂停那一刻

    video.fire('playing')   // 恢复播放：暂停时长被平移掉，不清零
    expect(tracker.getSmoothSecs()).toBe(1)

    clock += 1000             // 恢复后又流畅播了 1s
    expect(tracker.getSmoothSecs()).toBe(2)   // 1(暂停前) + 1(恢复后)，暂停的 4s 不计入
  })
})

describe('tick()：位置采样兜底（没有 waiting/stalled 事件也能发现卡住）', () => {
  it('两拍之间播放头没有前进 → 判定为卡顿', () => {
    video.currentTime = 10
    tracker.tick()   // 第一拍：建立位置基准
    clock += 1000
    tracker.tick()   // 第二拍：位置没变 → 判定卡顿
    expect(tracker.isStalling.value).toBe(true)
  })

  it('两拍之间播放头前进了 → 不算卡顿', () => {
    video.currentTime = 10
    tracker.tick()
    clock += 1000
    video.currentTime = 12
    tracker.tick()
    expect(tracker.isStalling.value).toBe(false)
  })

  it('resetSampler() 之后下一拍重新建立基准，不会把这段时间回填成一次卡顿', () => {
    video.currentTime = 10
    tracker.tick()          // 建立基准
    clock += 30000          // 模拟标签页切到后台很久
    tracker.resetSampler()  // 回前台先作废基准
    tracker.tick()          // 这一拍只是重新建立基准，不应判定为卡顿
    expect(tracker.isStalling.value).toBe(false)
  })
})

describe('bind()：幂等 + 改绑到新元素', () => {
  it('同一元素重复 bind 无副作用（不会重复挂监听导致重复计数）', () => {
    tracker.bind(video as any)
    tracker.bind(video as any)
    video.fire('waiting')
    clock += 600
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(1)   // 若重复挂监听，这里会变成 2
  })

  it('换了新元素后，旧元素上的事件不再影响统计', () => {
    const video2 = makeVideo()
    tracker.bind(video2 as any)   // 改绑到新元素
    video.fire('waiting')          // 旧元素上发事件
    clock += 600
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(0)   // 旧元素已解绑，不计入
  })
})

describe('reset()：切换视频时清零累计统计', () => {
  it('reset 之后卡顿次数与总时长归零', () => {
    video.fire('waiting')
    clock += 600
    video.fire('playing')
    expect(tracker.stallCount.value).toBe(1)
    tracker.reset()
    expect(tracker.stallCount.value).toBe(0)
    expect(tracker.stallMsTotal.value).toBe(0)
    expect(tracker.isStalling.value).toBe(false)
  })
})

describe('stallCountInWindow：窗口内卡顿次数', () => {
  it('只统计窗口时间内发生的卡顿', () => {
    video.fire('waiting'); clock += 600; video.fire('playing')   // 第一次卡顿
    clock += 10000   // 过了很久
    video.fire('waiting'); clock += 600; video.fire('playing')   // 第二次卡顿
    expect(tracker.stallCountInWindow(1000)).toBe(1)   // 只有最近 1s 内那一次
    expect(tracker.stallCountInWindow(20000)).toBe(2)  // 两次都在 20s 窗口内
  })
})
