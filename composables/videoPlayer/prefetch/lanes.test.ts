/**
 * lane 选择的行为钉子。
 *
 * 两个关键约定：**默认均分**（吃满两个 origin / 两份出口 IP 配额，预取用）；
 * **关键片 preferDirect 优先 lane 0 = 直连**（代理多一跳，能不白吃就不吃），
 * 直连槽满或熔断才退回均分。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useLaneControl } from './lanes'
import { MAX_CONN } from './tuning'

const dual = () => useLaneControl(() => ['direct', 'proxy'])

describe('acquireLane / 默认均分（预取）', () => {
  it('两条 lane 轮流用，不在一条上堆', () => {
    const lc = dual()
    expect(lc.acquireLane('u').lane).toBe(0)
    expect(lc.acquireLane('u').lane).toBe(1)
    expect(lc.acquireLane('u').lane).toBe(0)
    expect(lc.acquireLane('u').lane).toBe(1)
  })
})

describe('acquireLane / preferDirect（关键片）', () => {
  it('先把直连填到浏览器上限（6 条），再溢出到代理', () => {
    const lc = dual()
    for (let i = 0; i < MAX_CONN; i++) expect(lc.acquireLane('u', true).lane).toBe(0)
    expect(lc.acquireLane('u', true).lane).toBe(1)   // 直连满 → 溢出代理
  })

  it('释放一个直连槽后又回到直连', () => {
    const lc = dual()
    for (let i = 0; i < MAX_CONN; i++) lc.acquireLane('u', true)
    lc.releaseLane(0)
    expect(lc.acquireLane('u', true).lane).toBe(0)
  })

  it('直连被熔断 → 退回均分，不撞死掉的 lane', () => {
    const lc = dual()
    for (let i = 0; i < 3; i++) lc.markLaneFail(0, 2)   // 连续 3 次失败 → 熔断 lane 0
    expect(lc.acquireLane('u', true).lane).toBe(1)
  })

  it('单通道（只有一条 lane）→ 无论 preferDirect 都只能用它', () => {
    const lc = useLaneControl(() => ['only'])
    expect(lc.acquireLane('u', true).lane).toBe(0)
  })
})

describe('getInflightTotal：统一的并发口径（预取 + 关键片共用一份）', () => {
  it('acquire +1、release −1', () => {
    const lc = dual()
    expect(lc.getInflightTotal()).toBe(0)
    lc.acquireLane('u')   // lane 0
    lc.acquireLane('u')   // lane 1
    expect(lc.getInflightTotal()).toBe(2)
    lc.releaseLane(0)
    expect(lc.getInflightTotal()).toBe(1)
  })

  it('两条 origin 的在途都算进总数', () => {
    const lc = dual()
    for (let i = 0; i < MAX_CONN; i++) lc.acquireLane('u', true)   // 6 条直连
    lc.acquireLane('u')                                            // 溢出到代理
    expect(lc.getInflightTotal()).toBe(MAX_CONN + 1)
  })

  it('resetLanes 归零', () => {
    const lc = dual()
    lc.acquireLane('u'); lc.acquireLane('u')
    lc.resetLanes()
    expect(lc.getInflightTotal()).toBe(0)
  })
})

describe('avgInflightSince：分档用「全程平均在途数」，不是发起那一刻的', () => {
  let clock = 1000
  afterEach(() => { vi.restoreAllMocks() })
  const useClock = () => { clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock) }

  it('同步连发一批 6 条：第 1 条发起时在途只有 1，但全程跟另外 5 条并行 → 记 6', () => {
    useClock()
    const lc = dual()
    lc.acquireLane('u')
    const first = lc.markInflight()
    expect(lc.getInflightTotal()).toBe(1)                // 旧口径会把它记进低并发档
    for (let i = 0; i < 5; i++) lc.acquireLane('u')
    clock += 2000
    expect(lc.avgInflightSince(first)).toBe(6)
  })

  it('中途别的连接陆续交货 → 按时间加权（6 条 1s + 2 条 1s = 平均 4）', () => {
    useClock()
    const lc = dual()
    for (let i = 0; i < 6; i++) lc.acquireLane('u')
    const m = lc.markInflight()
    clock += 1000
    for (let i = 0; i < 4; i++) lc.releaseLane(i % 2)
    clock += 1000
    expect(lc.avgInflightSince(m)).toBe(4)
  })

  it('全程只有自己 → 1（进低并发档，单条基线的真样本）', () => {
    useClock()
    const lc = dual()
    lc.acquireLane('u')
    const m = lc.markInflight()
    clock += 1500
    expect(lc.avgInflightSince(m)).toBe(1)
  })

  it('同一拍交货（时长 0）→ 退回当下读数，且至少 1', () => {
    useClock()
    const lc = dual()
    const m = lc.markInflight()
    expect(lc.avgInflightSince(m)).toBe(1)
    lc.acquireLane('u'); lc.acquireLane('u'); lc.acquireLane('u')
    const m2 = lc.markInflight()
    expect(lc.avgInflightSince(m2)).toBe(3)
  })

  it('跨 resetLanes 的标记：reset 前的在途照记，reset 后按 0 计，不出负数', () => {
    useClock()
    const lc = dual()
    for (let i = 0; i < 4; i++) lc.acquireLane('u')
    const m = lc.markInflight()
    clock += 1000
    lc.resetLanes()
    clock += 1000
    expect(lc.avgInflightSince(m)).toBe(2)               // (4×1000 + 0×1000) / 2000
  })
})
