/**
 * 缓冲量测的行为钉子：两把尺子严格分开。
 *  · getAheadBuffered = 仅 MSE（跳片用）
 *  · getCachedAhead   = MSE + 预取缓存（分档/并发/倍速用），逐片累加到第一个「还需下载」的片为止
 */
import { describe, it, expect } from 'vitest'
import { useBufferMeter } from './bufferMeter'

const video = (ct: number, ranges: [number, number][]): HTMLVideoElement => ({
  currentTime: ct,
  buffered: {
    length: ranges.length,
    start: (i: number) => ranges[i]![0],
    end: (i: number) => ranges[i]![1],
  },
}) as unknown as HTMLVideoElement

const frag = (url: string, start: number, end: number) => ({ url, start, end })

function setup(opts: { frags?: any[]; cached?: string[]; noHls?: boolean }) {
  const cached = new Set(opts.cached ?? [])
  return useBufferMeter({
    getHls: () => (opts.noHls ? null : { currentLevel: 0, levels: [{ details: { fragments: opts.frags ?? [] } }] } as any),
    getPrefetchedBuf: (url: string) => (cached.has(url) ? new ArrayBuffer(1) : null),
    anchorTime: (v: HTMLVideoElement) => v.currentTime,
  })
}

describe('getAheadBuffered：仅 MSE', () => {
  it('播放头在缓冲区间内 → 返回到区间末尾的秒数', () => {
    const { getAheadBuffered } = setup({ noHls: true })
    expect(getAheadBuffered(video(5, [[0, 20]]))).toBe(15)
  })
  it('播放头不在任何缓冲区间 → 0', () => {
    const { getAheadBuffered } = setup({ noHls: true })
    expect(getAheadBuffered(video(25, [[0, 20]]))).toBe(0)
  })
})

describe('getCachedAhead：MSE + 预取缓存', () => {
  const FRAGS = [frag('f0', 0, 10), frag('f1', 10, 20), frag('f2', 20, 30), frag('f3', 30, 40)]

  it('拿不到分片表 → 退化成 MSE 读数', () => {
    const { getCachedAhead } = setup({ noHls: true })
    expect(getCachedAhead(video(5, [[0, 20]]))).toBe(15)
  })

  it('连续命中预取缓存 → reach 一直延伸到最后一连片', () => {
    const { getCachedAhead } = setup({ frags: FRAGS, cached: ['f0', 'f1', 'f2', 'f3'] })
    expect(getCachedAhead(video(5, [[0, 20]]))).toBe(35)   // reach=40 − ct=5
  })

  it('遇到第一个「没缓存也不在 MSE」的片就停', () => {
    const { getCachedAhead } = setup({ frags: FRAGS, cached: ['f0', 'f1'] })
    // f2 的 mid=25 不在 MSE(0~20) 里 → 停在 reach=20
    expect(getCachedAhead(video(5, [[0, 20]]))).toBe(15)
  })

  it('片与已达区间之间有空洞（start > reach+0.5）→ 停', () => {
    const { getCachedAhead } = setup({ frags: [frag('f0', 0, 10), frag('f1', 20, 30)], cached: ['f0', 'f1'] })
    expect(getCachedAhead(video(5, [[0, 20]]))).toBe(5)   // reach=10 − ct=5
  })

  it('片在 MSE 里（没有预取缓存）也算可播', () => {
    const { getCachedAhead } = setup({ frags: FRAGS, cached: [] })
    // mid=5/15 落在 MSE(0~20)，mid=25 不在 → 停在 reach=20
    expect(getCachedAhead(video(5, [[0, 20]]))).toBe(15)
  })
})
