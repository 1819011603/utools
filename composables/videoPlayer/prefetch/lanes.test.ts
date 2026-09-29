/**
 * lane 选择的行为钉子。
 *
 * 两个关键约定：**默认均分**（吃满两个 origin / 两份出口 IP 配额，预取用）；
 * **关键片 preferDirect 优先 lane 0 = 直连**（代理多一跳，能不白吃就不吃），
 * 直连槽满或熔断才退回均分。
 */
import { describe, it, expect } from 'vitest'
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
