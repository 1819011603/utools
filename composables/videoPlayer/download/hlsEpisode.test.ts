/**
 * downloadHlsEpisode 的行为钉子：一集 HLS 怎么被稳稳地取回来、写成一个文件。
 *
 * `stripToTsSync`／`laneUrl`／`LANE_ORDER` 等都是模块内部私有实现（未导出），
 * 所以这里全部通过公开入口 `downloadHlsEpisode` 间接验证——构造假 fetch/假分片，
 * 观察最终写进 FileSink 的字节和调用顺序，而不是直接调内部函数。
 *
 * 覆盖：伪装头剥离（真实经过整条流水线后写盘字节要干净）、200+HTML 判定失败、
 * 直连优先与失败一轮后的 sticky lane、单片连续失败达到 3 片之后第 4 片直接判定整集失败、
 * 离网期间不计入失败额度、音视频分轨线路直接拒绝、fMP4 源不剥壳直接透传、
 * remux 路径的写入顺序（header → fragments → moov+patch）。
 *
 * 本文件用到的两个源码内部依赖是 Nuxt 自动导入的（`useM3u8` 属于
 * `imports.dirs: ['composables/videoPlayer']`，hlsEpisode.ts 里是裸标识符、没有显式 import；
 * 见文件头注释「不进 imports.dirs」只是说这个文件自己不被扫，不代表它内部用到的自动导入
 * 标识符不需要被注入）。vitest 没有跑 Nuxt 的 unplugin-auto-import，所以测试里用
 * `vi.stubGlobal('useM3u8', 真实实现)` 补上这一环，不改源码。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useM3u8 } from '../useM3u8'
import { downloadHlsEpisode, type EpisodeDeps } from './hlsEpisode'
import type { FileSink } from './fileSink'

const h = vi.hoisted(() => ({ offline: false, waiters: [] as Array<() => void> }))
vi.mock('../engine/netWatch', () => ({
  isOffline: () => h.offline,
  isRecovering: () => false,
  waitForNet: (cb: () => void) => { h.waiters.push(cb) },
}))
vi.mock('../prefetch/lanes', () => ({
  withExternalSlot: async (fn: () => Promise<any>) => fn(),
}))

// remux 路径只验证「wiring」（写入顺序），字节格式正确性已经在 mp4Writer.test.ts 里钉死，
// 这里用假实现避免依赖真实 mux.js
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer
vi.mock('./mp4Writer', () => ({
  createMp4Writer: (_init: ArrayBuffer) => ({
    header: () => enc('HEADER'),
    addFragment: (frag: ArrayBuffer) => frag,
    finish: () => ({ moov: enc('MOOV'), patch: { position: 3, data: enc('PATCH') } }),
  }),
}))
vi.mock('./tsToMp4', () => ({
  createTsRemuxer: async () => {
    let calls = 0
    return {
      push: (_buf: ArrayBuffer) => {
        calls++
        if (calls === 1) return { init: enc('INIT'), fragments: [] }
        return { fragments: [enc(`FRAG${calls}`)] }
      },
      finish: () => ({ fragments: [] }),
    }
  },
}))

beforeEach(() => { vi.stubGlobal('useM3u8', useM3u8); h.offline = false; h.waiters.length = 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const TS_PACKET = 188
const tsBuf = (numPackets: number, fill = 0x11): ArrayBuffer => {
  const u8 = new Uint8Array(numPackets * TS_PACKET)
  for (let p = 0; p < numPackets; p++) {
    u8[p * TS_PACKET] = 0x47
    u8.fill(fill, p * TS_PACKET + 1, (p + 1) * TS_PACKET)
  }
  return u8.buffer
}
/** 前面糊 junkLen 字节伪装壳（如实测的 73 字节 PNG 头），后面接真实 TS 流 */
const disguisedTsBuf = (junkLen: number, numPackets: number, fill = 0x11): ArrayBuffer => {
  const junk = new Uint8Array(junkLen).fill(0x99)
  const ts = new Uint8Array(tsBuf(numPackets, fill))
  const out = new Uint8Array(junkLen + ts.length)
  out.set(junk, 0)
  out.set(ts, junkLen)
  return out.buffer
}
const htmlBody = (): ArrayBuffer => new TextEncoder().encode('<!DOCTYPE html><html>404</html>').buffer

const m3u8Url = 'https://cdn.example.com/a/index.m3u8'
const mediaManifest = (names: string[]): string => {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6']
  for (const n of names) { lines.push('#EXTINF:6.0,'); lines.push(n) }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}

function makeSinkFactory() {
  const chunks: ArrayBuffer[] = []
  const patches: Array<{ position: number; data: ArrayBuffer }> = []
  let closed = false
  let aborted = false
  const sink: FileSink = {
    write: async chunk => { chunks.push(chunk) },
    close: async () => { closed = true },
    abort: async () => { aborted = true },
    checkProjected: () => '',
    patchAt: async (position, data) => { patches.push({ position, data }) },
  }
  return { sink, chunks, patches, isClosed: () => closed, isAborted: () => aborted }
}

function makeDeps(overrides: Partial<EpisodeDeps> = {}): EpisodeDeps {
  return {
    origin: '',
    referer: '',
    getSegBuf: () => null,
    concurrency: () => 16,
    holdReason: () => '',
    wantMp4: false,
    onProgress: () => {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** 从直连 URL 或代理 URL（url= 参数里，`.` 不会被 encodeURIComponent 转义）里认出片名 */
const segNameOf = (url: string): string | null => /seg(\d+)\.(ts|m4s)/.exec(url)?.[0] ?? null

describe('伪装头剥离：真实经过流水线后写盘字节里不带那层壳', () => {
  it('单片直连成功，写进去的字节等于剥掉伪装头之后的 TS（而不是原样带壳的）', async () => {
    const manifest = mediaManifest(['seg0.ts'])
    const disguised = disguisedTsBuf(73, 5)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      if (url === 'https://cdn.example.com/a/seg0.ts') return { ok: true, status: 200, arrayBuffer: async () => disguised }
      throw new Error('unexpected fetch: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const res = await downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps())

    expect(res.ext).toBe('ts')
    expect(sinkF.chunks).toHaveLength(1)
    expect(new Uint8Array(sinkF.chunks[0]!)).toEqual(new Uint8Array(tsBuf(5)))
  })
})

describe('200 + HTML 页面判定为失败，不当成功写入', () => {
  it('直连拿到 HTML → 判失败，换代理通道拿到真分片才算数', async () => {
    const manifest = mediaManifest(['seg0.ts'])
    const good = tsBuf(3, 0x22)   // 恰好 3 个包、天然同步对齐，不需要剥壳
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      if (url === 'https://cdn.example.com/a/seg0.ts') return { ok: true, status: 200, arrayBuffer: async () => htmlBody() }
      if (url.startsWith('/api/proxy?') && url.includes('seg0.ts') && !url.includes('noseg=1')) {
        return { ok: true, status: 200, arrayBuffer: async () => good }
      }
      throw new Error('unexpected fetch: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const res = await downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ origin: 'https://player.example.com', referer: 'https://player.example.com/watch' }))

    expect(res.skipped).toBe(0)
    expect(new Uint8Array(sinkF.chunks[0]!)).toEqual(new Uint8Array(good))
    // 直连那次确实被打过一次，不是没试就直接走代理
    expect(fetchMock.mock.calls.some(c => c[0] === 'https://cdn.example.com/a/seg0.ts')).toBe(true)
  })
})

describe('直连优先，某条通道成功过一次后同集后续分片先试它（sticky lane）', () => {
  it('第一片靠代理通道才成功，第二片直接用那条通道、不再从直连试起', async () => {
    const manifest = mediaManifest(['seg0.ts', 'seg1.ts'])
    const good0 = tsBuf(3, 0x33)
    const good1 = tsBuf(3, 0x44)
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      // seg0：直连失败（HTML），只能靠代理（无 origin/referer 时代理通道只有 noref）
      if (url === 'https://cdn.example.com/a/seg0.ts') return { ok: true, status: 200, arrayBuffer: async () => htmlBody() }
      if (url.startsWith('/api/proxy?') && url.includes('seg0.ts')) return { ok: true, status: 200, arrayBuffer: async () => good0 }
      // seg1：只挂代理通道的响应——如果代码先试了直连，这里没有匹配分支会直接报错，测试会失败
      if (url.startsWith('/api/proxy?') && url.includes('seg1.ts')) return { ok: true, status: 200, arrayBuffer: async () => good1 }
      throw new Error('unexpected fetch for seg1（sticky lane 没生效，代码从直连试起了）: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    // 并发收成 1：sticky lane 是在 seg0 完全成功之后才落定的，并发着拉的话 seg1 可能
    // 在 seg0 定下 sticky 之前就已经开抢，测的就不是 sticky 生效之后的路径了
    const res = await downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ concurrency: () => 1 }))

    expect(res.skipped).toBe(0)
    expect(sinkF.chunks).toHaveLength(2)
    // seg1 从未被直连请求过
    expect(calls.includes('https://cdn.example.com/a/seg1.ts')).toBe(false)
  })
})

describe('单片彻底失败最多跳过 3 片，第 4 片再失败就判整集失败', () => {
  it('3 片跳过之后照常成功收尾（res.skipped === 3）', async () => {
    vi.useFakeTimers()
    const names = ['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts', 'seg4.ts']
    const manifest = mediaManifest(names)
    const failNames = new Set(['seg0.ts', 'seg1.ts', 'seg2.ts'])
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      const name = segNameOf(url)
      if (!name) throw new Error('unexpected fetch: ' + url)
      if (failNames.has(name)) return { ok: false, status: 500 }
      return { ok: true, status: 200, arrayBuffer: async () => tsBuf(3, 0x55) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    // 并发收成 1：把「哪片先失败哪片后成功」的顺序钉死，不受 worker 调度影响
    const resultPromise = downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ concurrency: () => 1 }))
    await vi.runAllTimersAsync()
    const res = await resultPromise

    expect(res.skipped).toBe(3)
    // 3 片跳过时 data.byteLength===0，doFlush 不会为它们调 sink.write；只有 seg3/seg4 真正写了
    expect(sinkF.chunks).toHaveLength(2)
  }, 20_000)

  it('第 4 片也彻底失败 → 整集判失败，不再继续', async () => {
    vi.useFakeTimers()
    const names = ['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts', 'seg4.ts']
    const manifest = mediaManifest(names)
    const failNames = new Set(['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts'])
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      const name = segNameOf(url)
      if (!name) throw new Error('unexpected fetch: ' + url)
      if (failNames.has(name)) return { ok: false, status: 500 }
      return { ok: true, status: 200, arrayBuffer: async () => tsBuf(3, 0x55) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const resultPromise = downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ concurrency: () => 1 }))
      .catch(e => e)
    await vi.runAllTimersAsync()
    const res = await resultPromise

    expect(res).toBeInstanceOf(Error)
    expect((res as Error).message).toContain('超过容忍上限')
    // 判失败时要把写了一半的文件清掉
    expect(sinkF.isAborted()).toBe(true)
  }, 20_000)
})

describe('离网期间不计入失败额度', () => {
  it('取分片前先判断离线：离线时不发请求、也不抛错，等网络恢复了才真的去取', async () => {
    h.offline = true
    const manifest = mediaManifest(['seg0.ts'])
    const good = tsBuf(3, 0x66)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      if (url === 'https://cdn.example.com/a/seg0.ts') return { ok: true, status: 200, arrayBuffer: async () => good }
      throw new Error('unexpected fetch: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const resultPromise = downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps())

    // 放几拍微任务，让流程跑到「解析完清单、进入 fetchOne、判定离线」这一步
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const segFetchCalls = fetchMock.mock.calls.filter(c => c[0] === 'https://cdn.example.com/a/seg0.ts')
    expect(segFetchCalls).toHaveLength(0)
    expect(h.waiters).toHaveLength(1)

    h.offline = false
    h.waiters.pop()!()
    const res = await resultPromise

    expect(res.skipped).toBe(0)
    expect(new Uint8Array(sinkF.chunks[0]!)).toEqual(new Uint8Array(good))
  })
})

describe('音视频分轨的线路直接拒绝，不生成只有画面没声音的文件', () => {
  it('清单里解出独立音频轨 → 抛错，压根不进入下载阶段', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="default",DEFAULT=YES,URI="audio/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="aud"',
      'video/index.m3u8',
    ].join('\n')
    const videoM3u8 = mediaManifest(['v0.ts'])
    const audioM3u8 = mediaManifest(['a0.ts'])
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes('noseg=1')) throw new Error('不该在拒绝之前发起分片请求: ' + url)
      if (url.includes('video%2Findex.m3u8')) return { ok: true, url: 'https://cdn.example.com/a/video/index.m3u8', text: async () => videoM3u8 }
      if (url.includes('audio%2Findex.m3u8')) return { ok: true, url: 'https://cdn.example.com/a/audio/index.m3u8', text: async () => audioM3u8 }
      return { ok: true, url: m3u8Url, text: async () => master }
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    await expect(downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps())).rejects.toThrow('音视频分轨')
    expect(sinkF.chunks).toHaveLength(0)
  })
})

describe('源本身就是 fMP4：不当 TS 处理，不剥壳，原样写入', () => {
  it('.m4s 分片即使长得像带伪装头的 TS，也不会被 stripToTsSync 动过', async () => {
    const manifest = mediaManifest(['seg0.m4s'])
    // 故意构造一段「看起来像 73 字节伪装头 + TS」的字节：如果代码误判成 TS 源就会被剥掉，
    // 而这里源是 fMP4，判据是「源的格式」不是内容特征，所以必须原样保留
    const trickyBytes = disguisedTsBuf(73, 5)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      if (url === 'https://cdn.example.com/a/seg0.m4s') return { ok: true, status: 200, arrayBuffer: async () => trickyBytes }
      throw new Error('unexpected fetch: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const res = await downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ wantMp4: false }))

    expect(res.ext).toBe('mp4')
    expect(new Uint8Array(sinkF.chunks[0]!)).toEqual(new Uint8Array(trickyBytes))
  })
})

describe('remux 路径的写入顺序：header 先行，fragments 跟着，moov+patch 收尾', () => {
  it('TS 源 + wantMp4=true → 依次写 header／分片片段／moov，最后 patch 一次 mdat 长度', async () => {
    const manifest = mediaManifest(['seg0.ts', 'seg1.ts'])
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('noseg=1')) return { ok: true, url: m3u8Url, text: async () => manifest }
      if (url === 'https://cdn.example.com/a/seg0.ts' || url === 'https://cdn.example.com/a/seg1.ts') {
        return { ok: true, status: 200, arrayBuffer: async () => tsBuf(3, 0x77) }
      }
      throw new Error('unexpected fetch: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sinkF = makeSinkFactory()
    const res = await downloadHlsEpisode(m3u8Url, async () => sinkF.sink, makeDeps({ wantMp4: true, concurrency: () => 1 }))

    expect(res.ext).toBe('mp4')
    const texts = sinkF.chunks.map(c => new TextDecoder().decode(c))
    expect(texts[0]).toBe('HEADER')
    expect(texts[texts.length - 1]).toBe('MOOV')
    expect(texts.slice(1, -1).every(t => t.startsWith('FRAG'))).toBe(true)
    expect(sinkF.patches).toEqual([{ position: 3, data: enc('PATCH') }])
  })
})
