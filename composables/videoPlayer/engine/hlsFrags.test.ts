/**
 * 「当前画质档分片表」取法的行为钉子。
 */
import { describe, it, expect } from 'vitest'
import { currentFrags, currentFragList } from './hlsFrags'

describe('currentFrags', () => {
  it('没有 hls → null', () => {
    expect(currentFrags(null)).toBeNull()
    expect(currentFrags(undefined)).toBeNull()
  })

  it('有 hls 但还没解析出详情 → null', () => {
    expect(currentFrags({ currentLevel: 0, levels: [] } as any)).toBeNull()
  })

  it('currentLevel 未落定（-1）→ 退回第 0 档', () => {
    const frags = [{ url: 'a' }]
    const r = currentFrags({ currentLevel: -1, levels: [{ details: { fragments: frags, targetduration: 6 } }] } as any)
    expect(r).toEqual({ frags, details: { fragments: frags, targetduration: 6 }, level: 0 })
  })

  it('按 currentLevel 取对应档', () => {
    const hls = { currentLevel: 1, levels: [{ details: { fragments: [{ url: 'a' }] } }, { details: { fragments: [{ url: 'b' }] } }] } as any
    expect(currentFrags(hls)?.frags[0].url).toBe('b')
    expect(currentFrags(hls)?.level).toBe(1)
  })

  it('details 里没有 fragments → 空数组（不返回 null）', () => {
    expect(currentFrags({ currentLevel: 0, levels: [{ details: {} }] } as any)?.frags).toEqual([])
  })
})

describe('currentFragList', () => {
  it('拿不到 → 空数组', () => {
    expect(currentFragList(null)).toEqual([])
  })
  it('拿得到 → 分片表', () => {
    const frags = [{ url: 'x' }]
    expect(currentFragList({ currentLevel: 0, levels: [{ details: { fragments: frags } }] } as any)).toBe(frags)
  })
})
