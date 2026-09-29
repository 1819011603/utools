/**
 * 本机播放记录的行为钉子（playMetrics）。
 *
 * 钉的是「一集的边界」和「每个数的口径」：arm → beginArmed 才开集；起播耗时从 arm 算到第一次 playing；
 * 看片时长 / 并发只在播放头真在走时计；网络变化当时在走记 0、没在走记到走起来为止；
 * 什么都没发生的集不落库；只留最近 50 条。时钟与存储都注入，不碰真实 localStorage。
 */
import { describe, it, expect } from 'vitest'
import { createPlayMetrics, summarizeRecords, METRICS_KEY, METRICS_MAX, type PlayRecord } from './playMetrics'

function setup() {
  let clock = 1000
  const store = new Map<string, string>()
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  const m = createPlayMetrics({ now: () => clock, wallNow: () => 42, storage: () => storage })
  return {
    m, store,
    advance: (ms: number) => { clock += ms },
    begin: () => { m.arm(); m.beginArmed('ep-1', 'https://cdn.example.com/a/index.m3u8') },
  }
}

describe('一集的边界', () => {
  it('没 arm 过的 beginArmed 不开集（卸载 / 放弃那几次 destroyHls）', () => {
    const { m } = setup()
    m.beginArmed('ep', 'https://x/y.m3u8')
    m.notePlaying()
    expect(m.end(0, 0)).toBeNull()
  })

  it('什么都没发生（没起播、没心跳）的集不落库', () => {
    const { m, store, begin } = setup()
    begin()
    expect(m.end(0, 0)).toBeNull()
    expect(store.has(METRICS_KEY)).toBe(false)
  })

  it('arm 只生效一次：同一个起点不会被两次 beginArmed 各开一集', () => {
    const { m } = setup()
    m.arm()
    m.beginArmed('a', 'https://x/1.m3u8')
    m.notePlaying()
    m.end(0, 0)
    m.beginArmed('b', 'https://x/2.m3u8')   // 没再 arm
    m.notePlaying()
    expect(m.end(0, 0)).toBeNull()
  })
})

describe('起播耗时', () => {
  it('从 arm（loadVideo 被调用）算到第一次 playing，后续 playing 不覆盖', () => {
    const { m, advance } = setup()
    m.arm()
    advance(800)                              // 取址 / destroyHls 之前那段也算进去
    m.beginArmed('ep', 'https://x/y.m3u8')
    advance(1200)
    m.notePlaying()
    advance(5000)
    m.notePlaying()                           // 卡完恢复又来一发 playing
    expect(m.end(0, 0)!.startupMs).toBe(2000)
  })

  it('没播起来 → null（但有心跳就照样记一条，失败的加载也是数据）', () => {
    const { m, begin, advance } = setup()
    begin()
    advance(1000)
    m.tick({ currentTime: 0, paused: true, targetConn: 2 })
    const rec = m.end(0, 0)!
    expect(rec.startupMs).toBeNull()
    expect(rec.watchSecs).toBe(0)
  })
})

describe('看片时长与并发只在播放头真在走时计', () => {
  it('暂停 / 卡住的拍不计时长、不进并发平均', () => {
    const { m, begin, advance } = setup()
    begin()
    m.notePlaying()
    m.tick({ currentTime: 10, paused: false, targetConn: 6 })   // 第一拍只建基线
    advance(1000); m.tick({ currentTime: 11, paused: false, targetConn: 2 })   // 在走
    advance(1000); m.tick({ currentTime: 12, paused: false, targetConn: 4 })   // 在走
    advance(1000); m.tick({ currentTime: 12, paused: false, targetConn: 12 })  // 卡住：不计
    advance(1000); m.tick({ currentTime: 12, paused: true, targetConn: 12 })   // 暂停：不计
    const rec = m.end(0, 0)!
    expect(rec.watchSecs).toBe(2)
    expect(rec.avgConn).toBe(3)
    expect(rec.maxConn).toBe(4)
  })
})

describe('网络变化后的恢复耗时', () => {
  it('变化那一刻在走 → 记 0', () => {
    const { m, begin, advance } = setup()
    begin(); m.notePlaying()
    m.tick({ currentTime: 1, paused: false, targetConn: 2 })
    advance(1000); m.tick({ currentTime: 2, paused: false, targetConn: 2 })
    m.noteNetChange()
    expect(m.end(0, 0)!.recoverMs).toEqual([0])
  })

  it('变化那一刻没在走 → 记到播放头重新走起来为止；连着变几次从第一次算起', () => {
    const { m, begin, advance } = setup()
    begin(); m.notePlaying()
    m.tick({ currentTime: 5, paused: false, targetConn: 2 })
    advance(1000); m.tick({ currentTime: 5, paused: false, targetConn: 2 })   // 卡着
    m.noteNetChange()
    advance(1500); m.noteNetChange()                                           // 又变一次
    advance(1500); m.tick({ currentTime: 5, paused: false, targetConn: 2 })   // 还卡着
    advance(1000); m.tick({ currentTime: 6, paused: false, targetConn: 2 })   // 走起来了
    const rec = m.end(0, 0)!
    expect(rec.netChanges).toBe(2)
    expect(rec.recoverMs).toEqual([4000])
  })
})

describe('落库', () => {
  it('卡顿读数由调用方给、跳片自己计、秒数取一位小数', () => {
    const { m, begin } = setup()
    begin(); m.notePlaying()
    m.noteSkip(); m.noteSkip()
    const rec = m.end(3, 4567)!
    expect(rec).toMatchObject({ stalls: 3, stallSecs: 4.6, skips: 2, host: 'cdn.example.com', key: 'ep-1', at: 42 })
    expect(m.loadRecords()).toHaveLength(1)
  })

  it(`只留最近 ${METRICS_MAX} 条`, () => {
    const { m } = setup()
    for (let i = 0; i < METRICS_MAX + 5; i++) {
      m.arm(); m.beginArmed(`ep-${i}`, 'https://x/y.m3u8'); m.notePlaying(); m.end(0, 0)
    }
    const list = m.loadRecords()
    expect(list).toHaveLength(METRICS_MAX)
    expect(list[0]!.key).toBe('ep-5')
  })

  it('存储里是坏数据 → 当成空列表，不抛', () => {
    const { m, store } = setup()
    store.set(METRICS_KEY, '{not json')
    expect(m.loadRecords()).toEqual([])
  })

  it('clearRecords 清空', () => {
    const { m, begin } = setup()
    begin(); m.notePlaying(); m.end(0, 0)
    m.clearRecords()
    expect(m.loadRecords()).toEqual([])
  })
})

describe('summarizeRecords（面板那一行）', () => {
  const rec = (p: Partial<PlayRecord>): PlayRecord => ({
    at: 0, key: '', host: '', startupMs: null, watchSecs: 0, stalls: 0, stallSecs: 0,
    skips: 0, netChanges: 0, recoverMs: [], avgConn: 0, maxConn: 0, ...p,
  })

  it('起播取中位数（忽略没播起来的）、卡顿按每小时折算', () => {
    const s = summarizeRecords([
      rec({ startupMs: 3000, watchSecs: 1800, stalls: 2 }),
      rec({ startupMs: 1000, watchSecs: 1800, stalls: 1, skips: 1 }),
      rec({ startupMs: 2000 }),
      rec({ startupMs: null }),
    ])
    expect(s).toEqual({ count: 4, startupP50Ms: 2000, stallsPerHour: 3, skips: 1 })
  })

  it('空列表 → 全零，不除以零', () => {
    expect(summarizeRecords([])).toEqual({ count: 0, startupP50Ms: null, stallsPerHour: 0, skips: 0 })
  })
})
