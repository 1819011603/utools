/**
 * fMP4 → 普通 MP4 改写器（mp4Writer）的行为钉子。
 *
 * 背景见 mp4Writer.ts 头注释与 docs/player.md「下载」一节：
 * - 输出必须是普通 MP4（ftyp + mdat + moov），绝不能直接落 fMP4；
 * - mdat 用 64 位 largesize 占位，finish() 时通过 patch 回填真实长度；
 * - 样本表必须「先算长度、开 buffer、逐个 setUint32」，200k 级样本不能撞 RangeError；
 * - `remux:true` 给的是 combined buffer，里面依次排着好几对 moof+mdat（音频一对、视频一对），
 *   只处理第一对会导致画面丢失（文件结构/时长/ffprobe 全部正常，只是没有视频）；
 * - stsd 整块从 init 段抄，不自己拼。
 *
 * 本文件手工拼装最小合法的 fMP4 init 段与 moof+mdat 片段作为测试夹具，
 * 不依赖 mux.js，也不读取任何二进制 fixture 文件。
 */
import { describe, it, expect } from 'vitest'
import { createMp4Writer } from './mp4Writer'

// ── 通用 box 读写小工具（测试专用，独立于被测实现，避免同一个 bug 两边都在） ──

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}
const i32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n)
  return b
}
const str4 = (s: string): Uint8Array => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)])

const buildBox = (type: string, ...parts: Uint8Array[]): Uint8Array => {
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

interface ReadBox { at: number; size: number; type: string; body: number }
function* readBoxes(u8: Uint8Array, start = 0, end = u8.byteLength): Generator<ReadBox> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let i = start
  while (i + 8 <= end) {
    let size = dv.getUint32(i)
    let headerSize = 8
    if (size === 1) { size = Number(dv.getBigUint64(i + 8)); headerSize = 16 }
    if (size < headerSize || i + size > end) return
    const type = String.fromCharCode(u8[i + 4]!, u8[i + 5]!, u8[i + 6]!, u8[i + 7]!)
    yield { at: i, size, type, body: i + headerSize }
    i += size
  }
}
const findBox = (u8: Uint8Array, start: number, end: number, type: string): ReadBox | null => {
  for (const b of readBoxes(u8, start, end)) if (b.type === type) return b
  return null
}

// ── fixture 构建 ──

/** 单条轨的最小合法 trak（只填 mp4Writer 实际会读的那些字段） */
function buildTrak(trackId: number, timescale: number, stsdTag: string): Uint8Array {
  const tkhd = buildBox('tkhd',
    u32(0), u32(0), u32(0),        // version+flags, creation, modification
    u32(trackId),                  // track_ID @ body+12
    u32(0),                        // reserved
    u32(0),                        // duration @ body+20（finish 时回填）
    new Uint8Array(8), new Uint8Array(8),   // reserved x2
    concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]), // matrix
    u32(0), u32(0))                // width, height
  const mdhd = buildBox('mdhd',
    u32(0), u32(0), u32(0),        // version+flags, creation, modification
    u32(timescale),                // timescale @ body+12
    u32(0),                        // duration @ body+16（finish 时回填）
    new Uint8Array(4))              // language + pre_defined
  const hdlr = buildBox('hdlr', new Uint8Array(20))
  // stsd 内容用 stsdTag 打个标记，finish 后原样出现即证明「整块从 init 抄」没有被改写
  const stsd = buildBox('stsd', str4(stsdTag), new Uint8Array(8))
  const stbl = buildBox('stbl', stsd)
  const vmhd = buildBox('vmhd', new Uint8Array(8))
  const minf = buildBox('minf', vmhd, stbl)
  const mdia = buildBox('mdia', mdhd, hdlr, minf)
  return buildBox('trak', tkhd, mdia)
}

interface TrackSpec { trackId: number; timescale: number; stsdTag: string }

function buildInit(movieTimescale: number, tracks: TrackSpec[]): ArrayBuffer {
  const ftyp = buildBox('ftyp', str4('isom'), u32(0), str4('isom'), str4('mp41'))
  const mvhd = buildBox('mvhd',
    u32(0), u32(0), u32(0),        // version+flags, creation, modification
    u32(movieTimescale),           // timescale @ body+12
    u32(0),                        // duration @ body+16（finish 时回填）
    u32(0x00010000), concat([new Uint8Array([0x01, 0x00]), new Uint8Array(2)]),
    new Uint8Array(8),
    concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    new Uint8Array(24), u32(0xffffffff))
  const moov = buildBox('moov', mvhd, ...tracks.map(t => buildTrak(t.trackId, t.timescale, t.stsdTag)))
  return concat([ftyp, moov]).buffer as ArrayBuffer
}

interface SampleSpec { size: number; sync?: boolean }

/**
 * 一对 moof+mdat。payload 用 fillByte 填充，方便断言「这段字节到底是哪条轨的」。
 *
 * `allSync=true` 时整条轨（含 default 与第一个样本）都标记成关键帧，用来覆盖
 * 「stss 全同步不必写」那条规则；默认只有 `samples[i].sync` 为真的第一个样本是关键帧，
 * 其余走 default-sample-flags（非同步）。
 */
function buildMoofMdat(
  trackId: number, samples: SampleSpec[], defaultDuration: number, fillByte: number, allSync = false,
): Uint8Array {
  const TFHD_FLAGS = 0x000008 | 0x000010 | 0x000020   // default duration / size / flags
  const defaultSize = samples[0]?.size ?? 0
  const NON_SYNC = 0x00010000
  const defaultFlags = allSync ? 0 : NON_SYNC
  const tfhd = buildBox('tfhd', u32(TFHD_FLAGS), u32(trackId), u32(defaultDuration), u32(defaultSize), u32(defaultFlags))

  const TRUN_FLAGS = 0x000001 | 0x000004 | 0x000200    // data-offset / first-sample-flags / per-sample size
  const firstFlags = allSync || samples[0]?.sync ? 0 : NON_SYNC
  const sizesBytes = concat(samples.map(s => u32(s.size)))
  // dataOffset 先占位为 0，写完整个 moof 之后再按已知的固定布局回填
  const trun = buildBox('trun', u32(TRUN_FLAGS), u32(samples.length), i32(0), u32(firstFlags), sizesBytes)
  const traf = buildBox('traf', tfhd, trun)
  const mfhd = buildBox('mfhd', u32(0), u32(1))
  const moof = buildBox('moof', mfhd, traf)

  // default-base-is-moof：data_offset 是相对 moof.at 的偏移，mdat 紧跟在 moof 后面，
  // 它的 payload（body）起点 = moof 总长 + mdat 头 8 字节
  const dataOffset = moof.byteLength + 8
  // trun 的 data_offset 字段固定在「box 头(8) + flags(4) + count(4)」之后，
  // 而 trun 在 moof 里的绝对位置 = moof头(8) + mfhd长度 + traf头(8) + tfhd长度
  const trunOffsetInMoof = 8 + mfhd.byteLength + 8 + tfhd.byteLength
  new DataView(moof.buffer, moof.byteOffset).setInt32(trunOffsetInMoof + 16, dataOffset)

  const payload = new Uint8Array(samples.reduce((a, s) => a + s.size, 0)).fill(fillByte)
  const mdat = buildBox('mdat', payload)
  return concat([moof, mdat])
}

const oneTrack = (): TrackSpec[] => [{ trackId: 1, timescale: 90000, stsdTag: 'avc1' }]
const twoTracks = (): TrackSpec[] => [
  { trackId: 1, timescale: 90000, stsdTag: 'avc1' },
  { trackId: 2, timescale: 48000, stsdTag: 'mp4a' },
]

describe('header()：ftyp 原样 + 64 位 largesize 占位的 mdat 头', () => {
  it('size 字段是 1（表示走 largesize），后面紧跟 8 字节占位', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    const head = new Uint8Array(w.header())
    const ftyp = findBox(new Uint8Array(init), 0, init.byteLength, 'ftyp')!
    const ftypBytes = new Uint8Array(init).subarray(ftyp.at, ftyp.at + ftyp.size)
    expect(head.subarray(0, ftypBytes.length)).toEqual(ftypBytes)
    const dv = new DataView(head.buffer)
    expect(dv.getUint32(ftypBytes.length)).toBe(1)   // size=1 → largesize
    const type = String.fromCharCode(...head.subarray(ftypBytes.length + 4, ftypBytes.length + 8))
    expect(type).toBe('mdat')
    expect(dv.getBigUint64(ftypBytes.length + 8)).toBe(0n)   // 占位，finish 前是 0
  })
})

describe('addFragment：单 pair 原样交出 mdat 负载', () => {
  it('返回的字节等于 mdat 的 payload（不多不少）', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()
    const frag = buildMoofMdat(1, [{ size: 100, sync: true }, { size: 200 }, { size: 150 }], 3000, 0xaa)
    const out = new Uint8Array(w.addFragment(frag.buffer as ArrayBuffer))
    expect(out.byteLength).toBe(450)
    expect(out.every(b => b === 0xaa)).toBe(true)
  })

  it('stsd 整块从 init 段抄进最终 moov，字节不变', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()
    w.addFragment(buildMoofMdat(1, [{ size: 10, sync: true }], 3000, 1).buffer as ArrayBuffer)
    const { moov } = w.finish()
    const moovU8 = new Uint8Array(moov)
    const moovBox = findBox(moovU8, 0, moovU8.byteLength, 'moov')!
    const trak = findBox(moovU8, moovBox.body, moovBox.at + moovBox.size, 'trak')!
    const mdia = findBox(moovU8, trak.body, trak.at + trak.size, 'mdia')!
    const minf = findBox(moovU8, mdia.body, mdia.at + mdia.size, 'minf')!
    const stbl = findBox(moovU8, minf.body, minf.at + minf.size, 'stbl')!
    const stsd = findBox(moovU8, stbl.body, stbl.at + stbl.size, 'stsd')!
    const tag = String.fromCharCode(...moovU8.subarray(stsd.body, stsd.body + 4))
    expect(tag).toBe('avc1')
  })
})

describe('remux:true 的 combined buffer：一次交货里好几对 moof+mdat，必须全部消费', () => {
  it('音频一对 + 视频一对都被处理：返回字节是两段负载之和，两条轨都记下了样本', () => {
    const init = buildInit(90000, twoTracks())
    const w = createMp4Writer(init)
    w.header()

    const videoFrag = buildMoofMdat(1, [{ size: 300, sync: true }, { size: 280 }], 3000, 0x11)
    const audioFrag = buildMoofMdat(2, [{ size: 50, sync: true }, { size: 48 }], 1024, 0x22)
    const combined = concat([videoFrag, audioFrag])

    const out = new Uint8Array(w.addFragment(combined.buffer as ArrayBuffer))
    // 只处理第一对的话这里会是 580（只有视频），必须是 580+98=678
    expect(out.byteLength).toBe(300 + 280 + 50 + 48)
    expect(out.subarray(0, 580).every(b => b === 0x11)).toBe(true)   // 视频负载在前
    expect(out.subarray(580).every(b => b === 0x22)).toBe(true)      // 音频负载紧随其后

    const { moov } = w.finish()
    const moovU8 = new Uint8Array(moov)
    const moovBox = findBox(moovU8, 0, moovU8.byteLength, 'moov')!
    const traks = [...readBoxes(moovU8, moovBox.body, moovBox.at + moovBox.size)].filter(b => b.type === 'trak')
    expect(traks.length).toBe(2)
    // 两条轨的 stsz 都应该有样本（不是只有一条轨有数据）
    for (const trak of traks) {
      const mdia = findBox(moovU8, trak.body, trak.at + trak.size, 'mdia')!
      const minf = findBox(moovU8, mdia.body, mdia.at + mdia.size, 'minf')!
      const stbl = findBox(moovU8, minf.body, minf.at + minf.size, 'stbl')!
      const stsz = findBox(moovU8, stbl.body, stbl.at + stbl.size, 'stsz')!
      const dv = new DataView(moovU8.buffer, moovU8.byteOffset + stsz.body)
      const sampleCount = dv.getUint32(8)   // stsz body: version+flags(4) + sample_size(4) + sample_count(4) + ...
      expect(sampleCount).toBe(2)
    }
  })

  it('BUG 回归钉子：若只处理第一对，输出会漏掉音频负载（本用例证明当前实现没有这个问题）', () => {
    const init = buildInit(90000, twoTracks())
    const w = createMp4Writer(init)
    w.header()
    const videoFrag = buildMoofMdat(1, [{ size: 300, sync: true }], 3000, 0x11)
    const audioFrag = buildMoofMdat(2, [{ size: 50, sync: true }], 1024, 0x22)
    const out = new Uint8Array(w.addFragment(concat([videoFrag, audioFrag]).buffer as ArrayBuffer))
    expect(out.byteLength).not.toBe(300)   // 只有视频的错误表现
    expect(out.byteLength).toBe(350)
  })
})

describe('样本表：大样本量不能撞 RangeError（200k 级）', () => {
  it('20 万样本的单条轨 addFragment + finish 都不抛', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()

    const N = 200_000
    const samples: SampleSpec[] = new Array(N).fill(0).map((_, i) => ({ size: 1, sync: i === 0 }))
    const frag = buildMoofMdat(1, samples, 3000, 7)
    expect(() => w.addFragment(frag.buffer as ArrayBuffer)).not.toThrow()

    let result: ReturnType<typeof w.finish> | undefined
    expect(() => { result = w.finish() }).not.toThrow()

    const moovU8 = new Uint8Array(result!.moov)
    const moovBox = findBox(moovU8, 0, moovU8.byteLength, 'moov')!
    const trak = findBox(moovU8, moovBox.body, moovBox.at + moovBox.size, 'trak')!
    const mdia = findBox(moovU8, trak.body, trak.at + trak.size, 'mdia')!
    const minf = findBox(moovU8, mdia.body, mdia.at + mdia.size, 'minf')!
    const stbl = findBox(moovU8, minf.body, minf.at + minf.size, 'stbl')!
    const stsz = findBox(moovU8, stbl.body, stbl.at + stbl.size, 'stsz')!
    const dv = new DataView(moovU8.buffer, moovU8.byteOffset + stsz.body)
    expect(dv.getUint32(8)).toBe(N)   // stsz body: version+flags(4) + sample_size(4) + sample_count(4)
  }, 20_000)
})

describe('finish()：文件整体是普通 MP4（ftyp + mdat(largesize) + moov），不是 fMP4', () => {
  it('patch 落在 header 里的占位位置，值等于「mdat 头 16 字节 + 已写负载字节数」', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    const head = new Uint8Array(w.header())
    const frag1 = w.addFragment(buildMoofMdat(1, [{ size: 123, sync: true }], 3000, 1).buffer as ArrayBuffer)
    const frag2 = w.addFragment(buildMoofMdat(1, [{ size: 77 }], 3000, 2).buffer as ArrayBuffer)
    const { moov, patch } = w.finish()

    const ftyp = findBox(new Uint8Array(init), 0, init.byteLength, 'ftyp')!
    expect(patch.position).toBe(ftyp.size + 8)   // ftyp 之后、mdat 的 size(4)+type(4) 之后
    const patchDv = new DataView(patch.data)
    expect(patchDv.getBigUint64(0)).toBe(BigInt(16 + frag1.byteLength + frag2.byteLength))

    // 拼出完整文件，校验顶层顺序恰好是 ftyp → mdat → moov（不是 ftyp+moov 在前的 fMP4 布局）
    const file = concat([head, new Uint8Array(frag1), new Uint8Array(frag2), new Uint8Array(moov)])
    // 回填 largesize（模拟 FileSink.patchAt）
    new DataView(file.buffer).setBigUint64(patch.position, patchDv.getBigUint64(0))
    const top = [...readBoxes(file, 0, file.byteLength)].map(b => b.type)
    expect(top).toEqual(['ftyp', 'mdat', 'moov'])
    const mdatBox = findBox(file, 0, file.byteLength, 'mdat')!
    expect(mdatBox.size).toBe(16 + frag1.byteLength + frag2.byteLength)
  })
})

describe('stss（关键帧表）：全同步或全不同步都不必要写这张表', () => {
  it('部分同步（混合）→ 写 stss，条目数等于关键帧数', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()
    w.addFragment(buildMoofMdat(1, [{ size: 10, sync: true }, { size: 10 }, { size: 10 }], 3000, 1).buffer as ArrayBuffer)
    const { moov } = w.finish()
    const moovU8 = new Uint8Array(moov)
    const moovBox = findBox(moovU8, 0, moovU8.byteLength, 'moov')!
    const trak = findBox(moovU8, moovBox.body, moovBox.at + moovBox.size, 'trak')!
    const mdia = findBox(moovU8, trak.body, trak.at + trak.size, 'mdia')!
    const minf = findBox(moovU8, mdia.body, mdia.at + mdia.size, 'minf')!
    const stbl = findBox(moovU8, minf.body, minf.at + minf.size, 'stbl')!
    const stss = findBox(moovU8, stbl.body, stbl.at + stbl.size, 'stss')
    expect(stss).not.toBeNull()
    const dv = new DataView(moovU8.buffer, moovU8.byteOffset + stss!.body)
    expect(dv.getUint32(4)).toBe(1)   // entry_count：只有第一片是关键帧
  })

  it('全部都是同步样本（如整轨都是关键帧）→ 不写 stss', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()
    const frag = buildMoofMdat(1, [{ size: 10 }, { size: 10 }, { size: 10 }], 3000, 9, /* allSync */ true)
    w.addFragment(frag.buffer as ArrayBuffer)
    const { moov } = w.finish()
    const moovU8 = new Uint8Array(moov)
    const moovBox = findBox(moovU8, 0, moovU8.byteLength, 'moov')!
    const trak = findBox(moovU8, moovBox.body, moovBox.at + moovBox.size, 'trak')!
    const mdia = findBox(moovU8, trak.body, trak.at + trak.size, 'mdia')!
    const minf = findBox(moovU8, mdia.body, mdia.at + mdia.size, 'minf')!
    const stbl = findBox(moovU8, minf.body, minf.at + minf.size, 'stbl')!
    expect(findBox(moovU8, stbl.body, stbl.at + stbl.size, 'stss')).toBeNull()
  })
})

describe('输入不合法：宁可抛错也不要悄悄写出坏文件', () => {
  it('init 段没有 ftyp/moov → 抛错', () => {
    const bogus = buildBox('free', new Uint8Array(4)).buffer as ArrayBuffer
    expect(() => createMp4Writer(bogus)).toThrow(/ftyp\/moov/)
  })

  it('mvhd 不是 version 0 → 抛错（写死的字段偏移只对 v0 有效）', () => {
    const init = new Uint8Array(buildInit(90000, oneTrack()))
    const moovBox = findBox(init, 0, init.byteLength, 'moov')!
    const mvhdBox = findBox(init, moovBox.body, moovBox.at + moovBox.size, 'mvhd')!
    init[mvhdBox.body] = 1   // 把 version 改成 1
    expect(() => createMp4Writer(init.buffer as ArrayBuffer)).toThrow(/mvhd/)
  })

  it('fragment 里没有成对的 moof/mdat → 抛错', () => {
    const init = buildInit(90000, oneTrack())
    const w = createMp4Writer(init)
    w.header()
    const onlyMoof = buildBox('moof', buildBox('mfhd', u32(0), u32(1))).buffer as ArrayBuffer
    expect(() => w.addFragment(onlyMoof)).toThrow(/没有成对/)
  })
})
