/**
 * useM3u8：manifest 解析 + 下载计划 + AES-128 解密的行为钉子。
 *
 * 覆盖：master → 最高码率 variant 的递归解析、独立音轨识别（下载计划要能分出
 * videoSegments/audioSegments）、加密元数据提取（显式 IV / 用序列号推导 IV）、
 * requestUrl 与 finalUrl（重定向后地址）分开、解密对未加密分片直接透传。
 * fetch 用 vi.stubGlobal 打桩；不依赖真实网络。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useM3u8, ivBytesOf } from './useM3u8'

afterEach(() => { vi.unstubAllGlobals() })

const textResponse = (text: string, url = 'https://cdn.example.com/a/index.m3u8') => ({
  ok: true,
  url,
  text: async () => text,
})

function stubFetchSeq(responses: Array<{ text: string; url?: string } | { status: number }>) {
  let i = 0
  const fn = vi.fn(async (_url: string) => {
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    if ('status' in r) return { ok: false, status: r.status }
    return textResponse(r.text, r.url)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const identityProxy = (url: string) => url

describe('fetchM3u8Manifest / getM3u8SegmentsWithMeta：master → 最高码率 variant', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000',
    'mid/index.m3u8',
  ].join('\n')
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.0,',
    'seg0.ts',
    '#EXTINF:6.0,',
    'seg1.ts',
  ].join('\n')

  it('挑 BANDWIDTH 最大的那条 variant 递归下去解析分片', async () => {
    stubFetchSeq([{ text: master }, { text: media, url: 'https://cdn.example.com/a/high/index.m3u8' }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs.map(s => s.url)).toEqual([
      'https://cdn.example.com/a/high/seg0.ts',
      'https://cdn.example.com/a/high/seg1.ts',
    ])
  })

  it('已经是媒体清单（没有 variant）→ 直接解析，不再递归', async () => {
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs).toHaveLength(2)
  })
})

describe('requestUrl / finalUrl：重定向后地址与请求地址分开', () => {
  it('响应 res.url 与请求地址不同（302 重定向）→ finalUrl 取 res.url', async () => {
    stubFetchSeq([{ text: '#EXTM3U\n#EXTINF:1,\nseg0.ts', url: 'https://other-host:8080/a/index.m3u8' }])
    const m3u8 = useM3u8(identityProxy)
    const r = await m3u8.fetchM3u8Manifest('https://cdn.example.com/a/index.m3u8')
    expect(r.requestUrl).toBe('https://cdn.example.com/a/index.m3u8')
    expect(r.finalUrl).toBe('https://other-host:8080/a/index.m3u8')
    // baseUrl 必须按 finalUrl 算，否则相对分片 URI 会指到错的机器上
    expect(r.baseUrl).toBe('https://other-host:8080/a/')
  })
})

describe('获取清单失败：非 200 抛错', () => {
  it('抛出带状态码的错误', async () => {
    stubFetchSeq([{ status: 404 }])
    const m3u8 = useM3u8(identityProxy)
    await expect(m3u8.fetchM3u8Manifest('https://cdn.example.com/x.m3u8')).rejects.toThrow('404')
  })
})

describe('getM3u8DownloadPlan：音视频分轨识别', () => {
  const masterWithAudio = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="default",DEFAULT=YES,URI="audio/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="aud"',
    'video/index.m3u8',
  ].join('\n')
  const videoMedia = ['#EXTM3U', '#EXTINF:6.0,', 'v0.ts'].join('\n')
  const audioMedia = ['#EXTM3U', '#EXTINF:6.0,', 'a0.ts'].join('\n')

  it('有独立音轨 → videoSegments 与 audioSegments 都非空', async () => {
    stubFetchSeq([
      { text: masterWithAudio },
      { text: videoMedia, url: 'https://cdn.example.com/a/video/index.m3u8' },
      { text: audioMedia, url: 'https://cdn.example.com/a/audio/index.m3u8' },
    ])
    const m3u8 = useM3u8(identityProxy)
    const plan = await m3u8.getM3u8DownloadPlan('https://cdn.example.com/a/index.m3u8')
    expect(plan.videoSegments.map(s => s.url)).toEqual(['https://cdn.example.com/a/video/v0.ts'])
    expect(plan.audioSegments.map(s => s.url)).toEqual(['https://cdn.example.com/a/audio/a0.ts'])
  })

  it('没有独立音轨（普通单轨清单）→ audioSegments 为空数组', async () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=3000000', 'video/index.m3u8'].join('\n')
    stubFetchSeq([{ text: master }, { text: videoMedia, url: 'https://cdn.example.com/a/video/index.m3u8' }])
    const m3u8 = useM3u8(identityProxy)
    const plan = await m3u8.getM3u8DownloadPlan('https://cdn.example.com/a/index.m3u8')
    expect(plan.videoSegments).toHaveLength(1)
    expect(plan.audioSegments).toEqual([])
  })
})

describe('extractMediaSegmentsWithMeta：加密元数据 + init map', () => {
  it('AES-128 且带显式 IV（十六进制）→ 解析出 16 字节 keyIv', async () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0102030405060708090a0b0c0d0e0f10',
      '#EXTINF:6.0,',
      'seg0.ts',
    ].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs[0]!.keyUri).toBe('https://cdn.example.com/a/key.bin')
    expect(segs[0]!.keyIv).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
  })

  // 曾是 bug：m3u8-parser 给的 IV 是 Uint32Array(4)，旧代码把它 String() 成十进制逗号串再当十六进制读（见 ivBytesOf）
  it('m3u8-parser 给的 Uint32Array 形式 IV 正确解析成 16 字节（不被 String() 糊成十进制逗号串）', async () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0102030405060708090a0b0c0d0e0f10',
      '#EXTINF:6.0,',
      'seg0.ts',
    ].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs[0]!.keyIv).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
  })

  it('AES-128 但没有显式 IV → keyIv 为 null（下载时按 sn 推导）', async () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:6.0,',
      'seg0.ts',
    ].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs[0]!.keyIv).toBeNull()
    expect(segs[0]!.sn).toBe(0)
  })

  it('未加密分片：keyUri 为 undefined', async () => {
    const media = ['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts'].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs[0]!.keyUri).toBeUndefined()
  })

  it('fMP4 的 init map（#EXT-X-MAP）排在分片最前面，且同一个 map 地址只出现一次', async () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6.0,',
      'seg0.m4s',
      '#EXTINF:6.0,',
      'seg1.m4s',
    ].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs.map(s => s.url)).toEqual([
      'https://cdn.example.com/a/init.mp4',
      'https://cdn.example.com/a/seg0.m4s',
      'https://cdn.example.com/a/seg1.m4s',
    ])
  })

  it('mediaSequence 非 0 时 sn 从它开始累加（AES IV 推导要用得上）', async () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:6.0,',
      'seg0.ts',
      '#EXTINF:6.0,',
      'seg1.ts',
    ].join('\n')
    stubFetchSeq([{ text: media }])
    const m3u8 = useM3u8(identityProxy)
    const segs = await m3u8.getM3u8SegmentsWithMeta('https://cdn.example.com/a/index.m3u8')
    expect(segs.map(s => s.sn)).toEqual([100, 101])
  })
})

describe('decryptHlsSegment：AES-128-CBC', () => {
  it('未加密分片直接透传（不碰密钥缓存）', async () => {
    const m3u8 = useM3u8(identityProxy)
    const raw = new Uint8Array([1, 2, 3]).buffer
    const out = await m3u8.decryptHlsSegment(raw, { url: 'x', sn: 0 })
    expect(out).toBe(raw)
  })

  it('加密分片：解密结果等于加密前的明文（对称往返），且密钥按 keyUri 只取一次（缓存生效）', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(16))
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const plain = new TextEncoder().encode('hello hls segment').buffer
    const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain)

    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => rawKey.buffer }))
    vi.stubGlobal('fetch', fetchMock)

    const m3u8 = useM3u8(identityProxy)
    const seg = { url: 'seg0.ts', sn: 5, keyUri: 'https://cdn.example.com/key.bin', keyIv: iv }
    const out1 = await m3u8.decryptHlsSegment(cipher, seg)
    expect(new TextDecoder().decode(out1)).toBe('hello hls segment')

    // 同一个 keyUri 再解一次别的分片，密钥缓存应该命中，不该再发第二次请求
    const cipher2 = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain)
    await m3u8.decryptHlsSegment(cipher2, { ...seg, sn: 6 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('没有显式 IV 时用序列号填充成 16 字节大端整数（解密结果仍然正确）', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(16))
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
    const sn = 0x0102
    const ivBytes = new Uint8Array(16)
    ivBytes[12] = (sn >>> 24) & 0xff
    ivBytes[13] = (sn >>> 16) & 0xff
    ivBytes[14] = (sn >>> 8) & 0xff
    ivBytes[15] = sn & 0xff
    const plain = new TextEncoder().encode('no explicit iv').buffer
    const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes }, key, plain)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => rawKey.buffer })))
    const m3u8 = useM3u8(identityProxy)
    const out = await m3u8.decryptHlsSegment(cipher, { url: 'seg.ts', sn, keyUri: 'https://cdn.example.com/key.bin', keyIv: null })
    expect(new TextDecoder().decode(out)).toBe('no explicit iv')
  })

  it('取密钥失败（非 200）→ 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))
    const m3u8 = useM3u8(identityProxy)
    await expect(
      m3u8.decryptHlsSegment(new ArrayBuffer(16), { url: 'seg.ts', sn: 0, keyUri: 'https://cdn.example.com/key.bin', keyIv: null }),
    ).rejects.toThrow('403')
  })
})

describe('parseManifestText：已拿到手的原文直接解析（预热用），不再发请求', () => {
  it('相对 URI 按 requestUrl 还原成绝对地址', () => {
    const m3u8 = useM3u8(identityProxy)
    const text = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:5.0,', 'seg0.ts'].join('\n')
    const r = m3u8.parseManifestText(text, 'https://cdn.example.com/a/index.m3u8')
    expect(r.segments).toEqual([{ url: 'https://cdn.example.com/a/seg0.ts', duration: 5 }])
    expect(r.keyUrl).toBe('https://cdn.example.com/a/key.bin')
  })
})

describe('ivBytesOf：各种 IV 形态', () => {
  it('Uint32Array(4) 按大端展开', () => {
    expect(ivBytesOf(new Uint32Array([0x01020304, 0x05060708, 0x090a0b0c, 0x0d0e0f10])))
      .toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))
  })
  it('十六进制串（含 0x 前缀、不足 32 位左补零）', () => {
    expect(ivBytesOf('0x1')).toEqual(new Uint8Array([...Array(15).fill(0), 1]))
  })
  it('16 字节数组原样', () => {
    expect(ivBytesOf(Array.from({ length: 16 }, (_, i) => i))).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i))
  })
  it('认不出的形态 → null（退回按 sn 推导），不产出乱码字节', () => {
    expect(ivBytesOf('16909060,84281096')).toBeNull()
    expect(ivBytesOf(new Uint32Array(3))).toBeNull()
    expect(ivBytesOf(42)).toBeNull()
  })
})
