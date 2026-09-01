/**
 * 把 mux.js 吐出来的**分片 MP4**（fMP4：`ftyp+moov` 一次 + 一串 `moof+mdat`）
 * 改写成**普通 MP4**（`ftyp + mdat + moov`，样本表在 `moov` 里）。
 *
 * 为什么非得多这一层（**别再退回直接写 fMP4，那条路试过了**）：
 * AVFoundation（QuickTime、iOS 相册、微信）**算不对 fMP4 的时长**。实测同一段 32.499s 的片子，
 * 普通 MP4 读出 32.56s（对），fMP4 读出 34.40s（+5.7%；跨贴片边界那一段更夸张，42s 报 50s）。
 * 而且**改头是治不好的**，逐一试过全部无效：补 `mvhd.duration`、补 `mehd`（分片 MP4 的正式时长字段）、
 * 填 `trex.default_sample_duration`、在尾部补一个空 fragment —— QuickTime 的读数一动不动。
 * 差值也不符合任何简单规律（一份等于最后一片时长，另一份不等），所以不是某个字段写漏了。
 * 而「能在手机和 QuickTime 上正常播」正是选 MP4 的全部理由，所以只能落地成普通 MP4。
 *
 * 能这么做的前提是**样本表可以放在 `moov` 里最后写**：`moov` 排在 `mdat` 之后完全合法
 *（ffmpeg 不加 `+faststart` 就是这个布局），本地播放毫无差别。代价只有两个：
 *   · 全片的样本表要留在内存里 —— 一部 52 分钟的片子约 1~2MB（`stsz`/`stts`/`stss` 那几张表），
 *     跟分片缓存比可以忽略；
 *   · `mdat` 的长度要等写完才知道 → 需要**回头改文件开头那 8 个字节**（见 `FileSink.patchAt`）。
 *
 * 编解码配置（`stsd` 里的 `avc1`/`mp4a`，含 SPS/PPS 和 AudioSpecificConfig）**整块从 mux.js 的
 * init 段里抄**，不自己拼 —— 那是这件事里最容易出错的部分，而 mux.js 已经做对了。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/** 一条轨道攒下来的样本表 */
interface TrackTables {
  trackId: number
  timescale: number
  /** 模板：从 init 段的 trak 里抄来的那几个 box */
  tkhd: Uint8Array
  mdhd: Uint8Array
  hdlr: Uint8Array
  /** `minf` 里除 `stbl` 之外的部分（`vmhd`/`smhd` + `dinf`），原样搬 */
  minfHead: Uint8Array
  stsd: Uint8Array
  /** 逐样本：时长 / 大小 / 合成偏移；关键帧记样本号（从 1 开始） */
  durations: number[]
  sizes: number[]
  ctos: number[]
  syncSamples: number[]
  /** 每个 chunk（= 一个 fragment 里这条轨的一段连续样本）的文件偏移与样本数 */
  chunkOffsets: number[]
  chunkCounts: number[]
  totalDuration: number
}

const u32 = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}
const u64 = (n: number) => {
  const b = new Uint8Array(8)
  const dv = new DataView(b.buffer)
  dv.setUint32(0, Math.floor(n / 2 ** 32))
  dv.setUint32(4, n >>> 0)
  return b
}
const str4 = (s: string) => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)])

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

interface BoxInfo { at: number; size: number; type: string; body: number }

/** 遍历某一段里的顶层 box */
function* boxes(u8: Uint8Array, start = 0, end = u8.byteLength) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let i = start
  while (i + 8 <= end) {
    const size = dv.getUint32(i)
    if (size < 8 || i + size > end) return
    const type = String.fromCharCode(u8[i + 4]!, u8[i + 5]!, u8[i + 6]!, u8[i + 7]!)
    yield { at: i, size, type, body: i + 8 }
    i += size
  }
}

const find = (u8: Uint8Array, start: number, end: number, type: string) => {
  for (const b of boxes(u8, start, end)) if (b.type === type) return b
  return null
}

/** `ftyp`：直接用 mux.js 那份（isom/avc1/mp42…），别自己编 brand */
export interface Mp4Writer {
  /** 文件开头（`ftyp` + 占位的 64 位 `mdat` 头）。第一份要写进文件的东西 */
  header: () => ArrayBuffer
  /** 吃一个 fMP4 fragment（`moof+mdat`），返回要接着写进文件的样本字节 */
  addFragment: (frag: ArrayBuffer) => ArrayBuffer
  /** 收工：返回要追加的 `moov`，以及 `mdat` 真实长度该写在哪儿、写什么 */
  finish: () => { moov: ArrayBuffer; patch: { position: number; data: ArrayBuffer } }
}

export const createMp4Writer = (init: ArrayBuffer): Mp4Writer => {
  const initU8 = new Uint8Array(init)
  const dvInit = new DataView(init)

  const ftypBox = find(initU8, 0, initU8.byteLength, 'ftyp')
  const moovBox = find(initU8, 0, initU8.byteLength, 'moov')
  if (!ftypBox || !moovBox) throw new Error('init 段里没有 ftyp/moov，无法改写成普通 MP4')
  const ftyp = initU8.subarray(ftypBox.at, ftypBox.at + ftypBox.size)

  const mvhdBox = find(initU8, moovBox.body, moovBox.at + moovBox.size, 'mvhd')
  if (!mvhdBox || initU8[mvhdBox.body] !== 0) throw new Error('mvhd 不是 v0，放弃改写')
  const movieTimescale = dvInit.getUint32(mvhdBox.body + 12)

  // ── 从 init 段里把每条轨的模板抄出来 ──
  const tracks: TrackTables[] = []
  for (const trak of boxes(initU8, moovBox.body, moovBox.at + moovBox.size)) {
    if (trak.type !== 'trak') continue
    const trakEnd = trak.at + trak.size
    const tkhd = find(initU8, trak.body, trakEnd, 'tkhd')
    const mdia = find(initU8, trak.body, trakEnd, 'mdia')
    if (!tkhd || !mdia) continue
    const mdiaEnd = mdia.at + mdia.size
    const mdhd = find(initU8, mdia.body, mdiaEnd, 'mdhd')
    const hdlr = find(initU8, mdia.body, mdiaEnd, 'hdlr')
    const minf = find(initU8, mdia.body, mdiaEnd, 'minf')
    if (!mdhd || !hdlr || !minf) continue
    const minfEnd = minf.at + minf.size
    const stbl = find(initU8, minf.body, minfEnd, 'stbl')
    if (!stbl) continue
    const stsd = find(initU8, stbl.body, stbl.at + stbl.size, 'stsd')
    if (!stsd) continue

    // `minf` 里除 stbl 之外的原样搬（vmhd/smhd/dinf 的顺序也照抄）
    const headParts: Uint8Array[] = []
    for (const b of boxes(initU8, minf.body, minfEnd)) {
      if (b.type !== 'stbl') headParts.push(initU8.subarray(b.at, b.at + b.size))
    }

    tracks.push({
      trackId: dvInit.getUint32(tkhd.body + 12),
      timescale: dvInit.getUint32(mdhd.body + 12),
      tkhd: initU8.slice(tkhd.at, tkhd.at + tkhd.size),
      mdhd: initU8.slice(mdhd.at, mdhd.at + mdhd.size),
      hdlr: initU8.slice(hdlr.at, hdlr.at + hdlr.size),
      minfHead: concat(headParts),
      stsd: initU8.slice(stsd.at, stsd.at + stsd.size),
      durations: [], sizes: [], ctos: [], syncSamples: [],
      chunkOffsets: [], chunkCounts: [], totalDuration: 0,
    })
  }
  if (!tracks.length) throw new Error('init 段里一条轨都没解析出来')

  /** `mdat` 用 64 位 largesize：一集可能超过 4GB，32 位那个字段装不下 */
  const MDAT_HEADER = 16   // size(4)=1 + 'mdat'(4) + largesize(8)
  const mdatPayloadStart = ftyp.byteLength + MDAT_HEADER
  let payloadBytes = 0

  const header = (): ArrayBuffer => {
    const head = new Uint8Array(ftyp.byteLength + MDAT_HEADER)
    head.set(ftyp, 0)
    head.set(u32(1), ftyp.byteLength)                    // size=1 → 用 largesize
    head.set(str4('mdat'), ftyp.byteLength + 4)
    head.set(u64(0), ftyp.byteLength + 8)                // 占位，finish 时回头改
    return head.buffer as ArrayBuffer
  }

  const addFragment = (frag: ArrayBuffer): ArrayBuffer => {
    const f = new Uint8Array(frag)
    const dv = new DataView(frag)

    /*
     * **一次交货里有好几对 `moof+mdat`，不是一个 `moof` 带两个 `traf`。**
     * mux.js 开着 `remux: true` 吐出来的是 `type: 'combined'` 的一整段 buffer，
     * 里面是「音频那一片 moof+mdat」紧跟「视频那一片 moof+mdat」。
     * 只处理第一对的后果很隐蔽：文件结构、时长、ffprobe 全都正常，**只是画面没了**
     *（12.8MB 的素材写出来 0.75MB —— 只有音频）。
     */
    const pairs: Array<{ moof: BoxInfo; mdat: BoxInfo }> = []
    let pendingMoof: BoxInfo | null = null
    for (const b of boxes(f, 0, f.byteLength)) {
      if (b.type === 'moof') pendingMoof = b
      else if (b.type === 'mdat' && pendingMoof) { pairs.push({ moof: pendingMoof, mdat: b }); pendingMoof = null }
    }
    if (!pairs.length) throw new Error('fragment 里没有成对的 moof/mdat')

    const payloads: Uint8Array[] = []
    for (const { moof, mdat } of pairs) {
      collectSamples(f, dv, moof, mdat)
      const payload = f.subarray(mdat.body, mdat.at + mdat.size)
      payloadBytes += payload.byteLength
      payloads.push(payload)
    }
    const joined = concat(payloads)
    return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer
  }

  /** 把一对 `moof+mdat` 里的样本信息记进各自的轨道表（偏移按**当下已写入的字节数**算） */
  const collectSamples = (f: Uint8Array, dv: DataView, moof: BoxInfo, mdat: BoxInfo) => {
    for (const traf of boxes(f, moof.body, moof.at + moof.size)) {
      if (traf.type !== 'traf') continue
      const trafEnd = traf.at + traf.size
      const tfhd = find(f, traf.body, trafEnd, 'tfhd')
      const trun = find(f, traf.body, trafEnd, 'trun')
      if (!tfhd || !trun) continue

      const tfhdFlags = dv.getUint32(tfhd.body) & 0xffffff
      const trackId = dv.getUint32(tfhd.body + 4)
      let p = tfhd.body + 8
      let baseDataOffset = moof.at            // default-base-is-moof（mux.js 用的就是这个）
      if (tfhdFlags & 0x000001) { baseDataOffset = Number(dv.getBigUint64(p)); p += 8 }
      if (tfhdFlags & 0x000002) p += 4        // sample-description-index
      const defaultDuration = (tfhdFlags & 0x000008) ? dv.getUint32(p) : 0
      if (tfhdFlags & 0x000008) p += 4
      const defaultSize = (tfhdFlags & 0x000010) ? dv.getUint32(p) : 0
      if (tfhdFlags & 0x000010) p += 4
      const defaultFlags = (tfhdFlags & 0x000020) ? dv.getUint32(p) : 0

      const track = tracks.find(t => t.trackId === trackId)
      if (!track) continue

      const trunVersion = f[trun.body]!
      const trunFlags = dv.getUint32(trun.body) & 0xffffff
      const count = dv.getUint32(trun.body + 4)
      let q = trun.body + 8
      let dataOffset = 0
      if (trunFlags & 0x000001) { dataOffset = dv.getInt32(q); q += 4 }
      const firstSampleFlags = (trunFlags & 0x000004) ? dv.getUint32(q) : 0
      if (trunFlags & 0x000004) q += 4

      // 这一段样本在 fragment 里的起点 → 换算成在输出文件里的偏移
      let posInFrag = baseDataOffset + dataOffset
      const chunkFileOffset = mdatPayloadStart + payloadBytes + (posInFrag - (mdat.body))
      track.chunkOffsets.push(chunkFileOffset)
      track.chunkCounts.push(count)

      for (let n = 0; n < count; n++) {
        const dur = (trunFlags & 0x000100) ? dv.getUint32(q) : defaultDuration
        if (trunFlags & 0x000100) q += 4
        const size = (trunFlags & 0x000200) ? dv.getUint32(q) : defaultSize
        if (trunFlags & 0x000200) q += 4
        const flags = (trunFlags & 0x000400) ? dv.getUint32(q) : (n === 0 && (trunFlags & 0x000004) ? firstSampleFlags : defaultFlags)
        if (trunFlags & 0x000400) q += 4
        // 合成偏移：trun v1 是有符号的（B 帧可以为负）
        const cto = (trunFlags & 0x000800) ? (trunVersion === 1 ? dv.getInt32(q) : dv.getUint32(q)) : 0
        if (trunFlags & 0x000800) q += 4

        track.durations.push(dur)
        track.sizes.push(size)
        track.ctos.push(cto)
        track.totalDuration += dur
        // `sample_is_non_sync_sample` 是 bit 16。没有这个标记的就是关键帧
        if (!(flags & 0x00010000)) track.syncSamples.push(track.sizes.length)
        posInFrag += size
      }
    }
  }

  /*
   * ── 样本表 ──
   *
   * 每张表都**先算长度、开一块 buffer、逐个 setUint32 填进去**，
   * 绝不用 `box('stsz', ...sizes.map(u32))` 这种展开写法：一集 52 分钟约 7.5 万个视频样本、
   * 13 万个音频样本，展开成函数实参会直接撞上引擎的参数个数上限（`RangeError`）。
   * **短片子试不出来**（我最初的 1260 样本测试片就一路通过），只有整集才炸 —— 别改回去。
   */

  /** version+flags(4) + entry_count(4) 之后，逐条写 `n` 个 32 位字段 */
  const table = (type: string, entries: number, fieldsPerEntry: number,
    fill: (dv: DataView, at: number, i: number) => void, versionByte = 0): Uint8Array => {
    const body = new Uint8Array(8 + entries * fieldsPerEntry * 4)
    const dv = new DataView(body.buffer)
    body[0] = versionByte
    dv.setUint32(4, entries)
    for (let i = 0; i < entries; i++) fill(dv, 8 + i * fieldsPerEntry * 4, i)
    return box(type, body)
  }

  /** 把 `[值, 值, …]` 压成 `[(个数, 值), …]`（`stts`/`ctts` 都是这个形状） */
  const runLength = (values: number[]): number[] => {
    const runs: number[] = []
    for (const v of values) {
      const n = runs.length
      if (n && runs[n - 1] === v) runs[n - 2]!++
      else runs.push(1, v)
    }
    return runs
  }

  const buildStts = (durations: number[]): Uint8Array => {
    const runs = runLength(durations)
    return table('stts', runs.length / 2, 2, (dv, at, i) => {
      dv.setUint32(at, runs[i * 2]!)
      dv.setUint32(at + 4, runs[i * 2 + 1]!)
    })
  }

  /** `ctts`：全是 0 就不写这张表（音频轨一般如此）。有负偏移必须用 v1（v0 的字段是无符号的） */
  const buildCtts = (ctos: number[]): Uint8Array | null => {
    if (!ctos.some(c => c !== 0)) return null
    const signed = ctos.some(c => c < 0)
    const runs = runLength(ctos)
    return table('ctts', runs.length / 2, 2, (dv, at, i) => {
      dv.setUint32(at, runs[i * 2]!)
      const v = runs[i * 2 + 1]!
      if (signed) dv.setInt32(at + 4, v)
      else dv.setUint32(at + 4, v)
    }, signed ? 1 : 0)
  }

  /** `stsc`：chunk → 每 chunk 几个样本，同样按连续相同压缩 */
  const buildStsc = (counts: number[]): Uint8Array => {
    const entries: number[] = []
    counts.forEach((c, idx) => {
      const n = entries.length
      if (!n || entries[n - 2] !== c) entries.push(idx + 1, c, 1)   // first_chunk, samples_per_chunk, desc_index
    })
    return table('stsc', entries.length / 3, 3, (dv, at, i) => {
      dv.setUint32(at, entries[i * 3]!)
      dv.setUint32(at + 4, entries[i * 3 + 1]!)
      dv.setUint32(at + 8, entries[i * 3 + 2]!)
    })
  }

  /** 偏移表：超过 4GB 就得用 64 位的 `co64`（整片电影很容易超） */
  const buildOffsets = (offsets: number[]): Uint8Array => {
    const need64 = offsets.some(o => o > 0xffffffff)
    if (!need64) return table('stco', offsets.length, 1, (dv, at, i) => dv.setUint32(at, offsets[i]!))
    const body = new Uint8Array(8 + offsets.length * 8)
    const dv = new DataView(body.buffer)
    dv.setUint32(4, offsets.length)
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i]!
      dv.setUint32(8 + i * 8, Math.floor(o / 2 ** 32))
      dv.setUint32(8 + i * 8 + 4, o >>> 0)
    }
    return box('co64', body)
  }

  const buildStsz = (sizes: number[]): Uint8Array => {
    // 比别的表多一个固定字段（sample_size=0 表示逐样本给），所以不走 table()
    const body = new Uint8Array(12 + sizes.length * 4)
    const dv = new DataView(body.buffer)
    dv.setUint32(8, sizes.length)
    for (let i = 0; i < sizes.length; i++) dv.setUint32(12 + i * 4, sizes[i]!)
    return box('stsz', body)
  }

  const buildStss = (sync: number[], total: number): Uint8Array | null => {
    // 每一帧都是关键帧（音频）→ 不写这张表，写了反而让播放器以为有限制
    if (!sync.length || sync.length === total) return null
    return table('stss', sync.length, 1, (dv, at, i) => dv.setUint32(at, sync[i]!))
  }

  /** 把模板里的时长字段改成真实值（`tkhd` 用影片时基，`mdhd` 用轨道自己的时基） */
  const patchedTkhd = (t: TrackTables, movieDurUnits: number): Uint8Array => {
    const out = t.tkhd.slice()
    if (out[8] === 0) new DataView(out.buffer).setUint32(28, movieDurUnits)
    return out
  }
  const patchedMdhd = (t: TrackTables): Uint8Array => {
    const out = t.mdhd.slice()
    if (out[8] === 0) new DataView(out.buffer).setUint32(24, t.totalDuration)
    return out
  }

  const finish = () => {
    /** 影片时长取最长的那条轨（换算到影片时基） */
    const movieSeconds = Math.max(...tracks.map(t => t.totalDuration / t.timescale))
    const movieDurUnits = Math.round(movieSeconds * movieTimescale)

    const mvhd = (() => {
      const out = initU8.slice(mvhdBox.at, mvhdBox.at + mvhdBox.size)
      new DataView(out.buffer).setUint32(24, movieDurUnits)
      return out
    })()

    const traks = tracks.map(t => {
      const stblParts: Uint8Array[] = [t.stsd, buildStts(t.durations)]
      const ctts = buildCtts(t.ctos)
      if (ctts) stblParts.push(ctts)
      const stss = buildStss(t.syncSamples, t.sizes.length)
      if (stss) stblParts.push(stss)
      stblParts.push(buildStsc(t.chunkCounts), buildStsz(t.sizes), buildOffsets(t.chunkOffsets))
      const stbl = box('stbl', ...stblParts)
      const minf = box('minf', t.minfHead, stbl)
      const mdia = box('mdia', patchedMdhd(t), t.hdlr, minf)
      return box('trak', patchedTkhd(t, movieDurUnits), mdia)
    })

    const moov = box('moov', mvhd, ...traks)
    return {
      moov: moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength) as ArrayBuffer,
      // `largesize` 按规范是**整个 box 的长度**（含那 16 字节头），不是只有负载
      patch: {
        position: ftyp.byteLength + 8,
        data: u64(MDAT_HEADER + payloadBytes).buffer as ArrayBuffer,
      },
    }
  }

  return { header, addFragment, finish }
}
