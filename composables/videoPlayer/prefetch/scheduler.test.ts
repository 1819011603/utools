/**
 * 预取补片额度的行为钉子：不超目标并发，也不挤占关键片（fragLoader 竞速）的连接槽。
 */
import { describe, it, expect } from 'vitest'
import { prefetchSlots } from './scheduler'

describe('prefetchSlots', () => {
  it('没有关键片在途 → 补到目标并发', () => {
    // 目标 6、已有 2 条预取、总在途 2、上限 6 → 还能发 4
    expect(prefetchSlots(6, 2, 2, 6)).toBe(4)
  })

  it('关键片竞速占着槽 → 预取让路，总在途不超过上限', () => {
    // 目标 6、预取 4 条、关键片 2 条竞速 → 总在途 6 已到顶，一条都不再发（旧逻辑会再发 2 → 8 条排队）
    expect(prefetchSlots(6, 4, 6, 6)).toBe(0)
    expect(prefetchSlots(6, 3, 5, 6)).toBe(1)
  })

  it('关键片把总在途顶过上限 → 0，不出负数', () => {
    expect(prefetchSlots(6, 0, 8, 6)).toBe(0)
  })

  it('目标比现有预取少（刚收线程）→ 0，不出负数', () => {
    expect(prefetchSlots(2, 5, 5, 12)).toBe(0)
  })

  it('目标 0（停取）→ 0', () => {
    expect(prefetchSlots(0, 0, 0, 6)).toBe(0)
  })

  it('双通道上限 12：受目标约束而不是被 6 卡住', () => {
    expect(prefetchSlots(10, 6, 7, 12)).toBe(4)
  })
})
