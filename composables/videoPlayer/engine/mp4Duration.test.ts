/**
 * 整片 MP4 自读时长（probeMp4Head）的行为钉子。
 *
 * 背景见文件头注释：某些安卓 Chrome 读不出整片 MP4 的时长，而时长其实就在
 * moov/mvhd 里，所以自己拉两发 Range 请求（头部 + moov 开头）读出来。
 * 覆盖：faststart（moov 在头部）、moov 在尾部要跟跳（mdat 之后）、
 * mvhd v0/v1（64 位时长）、Range 请求非 206 时安静放弃、结构不认识时安静放弃。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeMp4Head } from './mp4Duration'

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}
const str4 = (s: string): Uint8Array => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)])
const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((a, p) => a + p.byteLength, 8)
  const out = new Uint8Array(len)
  out.set(u32(len), 0)
  out.set(str4(type), 4)
  let at = 8
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

/** mvhd v0：32 位 timescale/duration */
const mvhdV0 = (timescale: number, duration: number): Uint8Array =>
  box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration), new Uint8Array(80))

/** mvhd v1：64 位 created/modified/duration，前一字节是 version */
const mvhdV1 = (timescale: number, duration: number): Uint8Array => {
  const versionFlags = new Uint8Array(4)
  versionFlags[0] = 1
  const u64 = (n: number): Uint8Array => {
    const b = new Uint8Array(8)
    const dv = new DataView(b.buffer)
    dv.setUint32(0, Math.floor(n / 2 ** 32))
    dv.setUint32(4, n >>> 0)
    return b
  }
  return box('mvhd', versionFlags, new Uint8Array(8), new Uint8Array(8), u32(timescale), u64(duration), new Uint8Array(80))
}

const moovBox = (mvhd: Uint8Array): Uint8Array => box('moov', mvhd)

/** 一个 64 位 largesize 的 mdat（只需要头部，负载可以随便填一点） */
const mdatLarge = (payloadLen: number): Uint8Array => {
  const head = new Uint8Array(16)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, 1)                 // size=1 → largesize
  head.set(str4('mdat'), 4)
  const total = 16 + payloadLen
  dv.setUint32(8, Math.floor(total / 2 ** 32))
  dv.setUint32(12, total >>> 0)
  return concat([head, new Uint8Array(payloadLen)])
}

/** 装一台假的 fetch：按 Range 请求返回对应字节段，非法/越界一律 200/其它状态码模拟失败 */
function stubFetch(file: Uint8Array) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range || ''
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    if (!m) return { status: 200, body: null, arrayBuffer: async () => new ArrayBuffer(0) } as any
    const from = Number(m[1])
    const to = Math.min(Number(m[2]), file.byteLength - 1)
    if (from >= file.byteLength) {
      return { status: 200, body: { cancel: async () => {} }, arrayBuffer: async () => new ArrayBuffer(0) } as any
    }
    const slice = file.slice(from, to + 1)
    return {
      status: 206,
      body: { cancel: async () => {} },
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    } as any
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('faststart：moov 就在文件头，头 2KB 里直接读出时长', () => {
  it('mvhd v0：durationSecs = duration/timescale，mediaBytes 来自 mdat.size', () => {
    const ftyp = box('ftyp', str4('isom'))
    const mdat = mdatLarge(50)
    const moov = moovBox(mvhdV0(1000, 32499))   // 32.499s
    const file = concat([ftyp, moov, mdat])
    stubFetch(file)
    return probeMp4Head('https://example.com/a.mp4').then(info => {
      expect(info.durationSecs).toBeCloseTo(32.499, 3)
    })
  })
})

describe('moov 在文件尾：跟着顶层 box 链跳过去找', () => {
  it('mdat(largesize) 在前、moov 在后 → 第二跳 Range 请求读到 moov 头部拿到时长', async () => {
    const ftyp = box('ftyp', str4('isom'))
    const mdat = mdatLarge(5000)   // far bigger than HEAD_BYTES(2048) 的头部窗口，逼近尾部布局
    const moov = moovBox(mvhdV0(90000, 90000 * 45 * 60 + 90000 * 39))   // 45分39秒
    const file = concat([ftyp, mdat, moov])
    const fetchMock = stubFetch(file)
    const info = await probeMp4Head('https://example.com/b.mp4')
    expect(info.durationSecs).toBeCloseTo(45 * 60 + 39, 0)
    expect(info.mediaBytes).toBe(mdat.byteLength)
    // 两发小请求：头部 + moov 那一跳，不是把整个文件都读回来
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('mdat 之后夹着一个 free box 才到 moov → 照样能跟到（MAX_HOPS 覆盖）', async () => {
    const ftyp = box('ftyp', str4('isom'))
    const mdat = mdatLarge(3000)
    const free = box('free', new Uint8Array(8))
    const moov = moovBox(mvhdV0(1000, 5000))
    const file = concat([ftyp, mdat, free, moov])
    stubFetch(file)
    const info = await probeMp4Head('https://example.com/c.mp4')
    expect(info.durationSecs).toBeCloseTo(5, 3)
  })
})

describe('mvhd version 1：64 位时长字段', () => {
  it('用 v1 布局也能正确解出秒数', async () => {
    const ftyp = box('ftyp', str4('isom'))
    const moov = moovBox(mvhdV1(1000, 12345))
    const mdat = mdatLarge(10)
    const file = concat([ftyp, moov, mdat])
    stubFetch(file)
    const info = await probeMp4Head('https://example.com/d.mp4')
    expect(info.durationSecs).toBeCloseTo(12.345, 3)
  })
})

describe('读不到就安静放弃，不抛错', () => {
  it('Range 请求不是 206（源站不支持分段）→ durationSecs=0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, body: { cancel: async () => {} }, arrayBuffer: async () => new ArrayBuffer(0) })))
    const info = await probeMp4Head('https://example.com/e.mp4')
    expect(info).toEqual({ durationSecs: 0, mediaBytes: 0 })
  })

  it('fetch 直接抛错（超时/被拦）→ 安静返回空结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network fail') }))
    const info = await probeMp4Head('https://example.com/f.mp4')
    expect(info).toEqual({ durationSecs: 0, mediaBytes: 0 })
  })

  it('顶层链跳到头也找不到 moov（结构不认识）→ 安静返回空结果', async () => {
    const ftyp = box('ftyp', str4('isom'))
    const junk = box('skip', new Uint8Array(20))
    const file = concat([ftyp, junk])   // 没有 moov，也没有 mdat 可跟
    stubFetch(file)
    const info = await probeMp4Head('https://example.com/g.mp4')
    expect(info.durationSecs).toBe(0)
  })
})

describe('请求同形：不带 Referer（referrerPolicy: no-referrer）', () => {
  it('每次请求都带 no-referrer，绕开防盗链误伤', async () => {
    const ftyp = box('ftyp', str4('isom'))
    const moov = moovBox(mvhdV0(1000, 1000))
    const mdat = mdatLarge(10)
    const file = concat([ftyp, moov, mdat])
    const fetchMock = stubFetch(file)
    await probeMp4Head('https://example.com/h.mp4')
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/h.mp4', expect.objectContaining({ referrerPolicy: 'no-referrer' }))
  })
})
