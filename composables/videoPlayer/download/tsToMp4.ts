/**
 * TS → fMP4 重封装（remux，**不重编码**：H.264/AAC 的字节原样搬进 MP4 容器，画质无损、几乎不吃 CPU）。
 *
 * 为什么非要这一层：拼出来的 `.ts` 只有 VLC / mpv / PotPlayer 认，QuickTime、Windows「电影和电视」、
 * 手机相册、微信、浏览器一概打不开 —— 而「下完发给别人 / 传手机上看」正是下载的主要用途。
 *
 * 用 mux.js（**只动态 import `lib/mp4/transmuxer`**，不整包引：整包还带 flv / partial / inspector）。
 *
 * 输出是 **fMP4**（`ftyp+moov` 一次 + 之后一串 `moof+mdat`），所以能边下边写盘 ——
 * 普通 MP4 的 `moov` 要等所有采样的位置都确定才写得出来，等于必须先把整集攒在内存里，
 * 那正是这套下载器要避开的事。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

export interface TsRemuxer {
  /** 喂一片 TS，拿回这一片对应的 MP4 字节（第一片会带上 `ftyp+moov`） */
  push: (ts: ArrayBuffer) => ArrayBuffer[]
  /** 收工。mux.js 是 push/flush 成对的，这里只是留个对称的口子 */
  finish: () => ArrayBuffer[]
}

export const createTsRemuxer = async (): Promise<TsRemuxer> => {
  /*
   * specifier **必须是字面量、也不能加 `@vite-ignore`**（那是给服务端 `node:*` 用的写法）：
   * mux.js 是 CJS 包，要靠 Vite 预打包成 ESM 才能在浏览器里 import；
   * 用变量 + `@vite-ignore` 会让这行原样留到运行时 → 浏览器解析裸包名直接失败。
   */
  // @ts-ignore mux.js 没有类型声明
  const mod: any = await import('mux.js/lib/mp4/transmuxer')
  const Transmuxer = mod.Transmuxer || mod.default?.Transmuxer
  if (!Transmuxer) throw new Error('mux.js 加载失败，改用 .ts 格式再试')

  // remux: true → 音视频合成**一条** MP4 轨道流（分开的话就又变成两个文件拼不起来了）
  const transmuxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false })

  let initWritten = false
  let out: ArrayBuffer[] = []

  transmuxer.on('data', (seg: any) => {
    /*
     * **`initSegment` 只能写一次**。mux.js 每一片都会把它带上（MSE 那边是允许重复 append 的），
     * 而我们是往一个文件里首尾相接地写 —— 重复写就是在视频中间插进一堆 `ftyp+moov`，
     * 播放器读到第二个 moov 要么当文件结束、要么直接报错。
     */
    if (!initWritten && seg.initSegment?.byteLength) {
      initWritten = true
      out.push(toBuf(seg.initSegment))
    }
    if (seg.data?.byteLength) out.push(toBuf(seg.data))
  })

  return {
    push: ts => {
      out = []
      transmuxer.push(new Uint8Array(ts))
      // 每片都 flush：不 flush 的话 mux.js 会一直攒着（它本来是为「一段一段喂给 MSE」设计的），
      // 攒到最后等于把整集放在内存里
      transmuxer.flush()
      return out
    },
    finish: () => {
      out = []
      transmuxer.flush()
      return out
    },
  }
}

/** mux.js 给的是 Uint8Array（可能是某个大 buffer 的视图），必须**按视图边界拷出来**再交给写盘 */
const toBuf = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

/** 「时长未知」的哨兵值。mux.js 在 `mvhd`/`tkhd`/`mdhd` 里一律填这个 */
const UNKNOWN_DURATION = 0xffffffff
/** `mehd` v0 的整个大小：size(4) + type(4) + version/flags(4) + fragment_duration(4) */
const MEHD_SIZE = 16

/**
 * **把时长写进 `moov`**（在写 init 段那一刻就做，时长早就知道 —— 清单的 EXTINF 之和）。
 *
 * mux.js 面向 MSE，时长交给 MediaSource 去管，所以它在 `mvhd`/`tkhd`/`mdhd` 里一律写
 * `0xFFFFFFFF`（未知），**而且不写 `mehd`**。留着这副样子的后果分三种播放器：
 *   · ffmpeg / VLC / mpv 自己扫一遍，读数正常 —— **所以只验 ffprobe 完全看不出问题**；
 *   · 只补 `mvhd` 的话，QuickTime 从「27 小时」变成「偏长 19%」（42s 报 50s）：
 *     **按规范，有 `mvex` 就是分片 MP4，整片时长该由 `mehd` 说，`mvhd` 那个数不作准**
 *     —— QuickTime 是对的，我们一开始补错了地方。
 *   · 补上 `mehd` 之后它才准。
 * 而「能在 QuickTime / 手机上正常播」正是选 MP4 的全部理由，所以这一步不能省。
 *
 * `mehd` 缺的时候要**插进 `mvex` 最前面**（规范里它排在 `trex` 之前），于是 init 段会长 16 字节，
 * 得跟着改 `mvex` 和 `moov` 两个 size。这对分片 MP4 是安全的：`trun` 里的 `data_offset`
 * 是**相对 `moof` 起点**的，整段后移不影响任何偏移。
 *
 * v1（64 位）的时长字段一概跳过：mux.js 只写 v0，遇到别的形状宁可不改也别把 moov 改坏。
 */
export const patchFmp4Duration = (init: ArrayBuffer, seconds: number): ArrayBuffer => {
  if (!(seconds > 0)) return init

  const src = new Uint8Array(init)
  const typeOf = (u8: Uint8Array, i: number) =>
    String.fromCharCode(u8[i + 4]!, u8[i + 5]!, u8[i + 6]!, u8[i + 7]!)

  // ── 第一步：没有 mehd 就插一个（先占位，第二步再填数）──
  let buf = src
  {
    const dv0 = new DataView(src.buffer, src.byteOffset, src.byteLength)
    let moovAt = -1, moovSize = 0, mvexAt = -1, mvexSize = 0, hasMehd = false
    for (let i = 0; i + 8 <= src.length;) {
      const size = dv0.getUint32(i)
      if (size < 8 || i + size > src.length) break
      if (typeOf(src, i) === 'moov') { moovAt = i; moovSize = size; break }
      i += size
    }
    if (moovAt >= 0) {
      for (let i = moovAt + 8; i + 8 <= moovAt + moovSize;) {
        const size = dv0.getUint32(i)
        if (size < 8) break
        if (typeOf(src, i) === 'mvex') { mvexAt = i; mvexSize = size; break }
        i += size
      }
    }
    if (mvexAt >= 0) {
      for (let i = mvexAt + 8; i + 8 <= mvexAt + mvexSize;) {
        const size = dv0.getUint32(i)
        if (size < 8) break
        if (typeOf(src, i) === 'mehd') { hasMehd = true; break }
        i += size
      }
      if (!hasMehd) {
        const at = mvexAt + 8
        buf = new Uint8Array(src.length + MEHD_SIZE)
        buf.set(src.subarray(0, at), 0)
        const mehd = new DataView(buf.buffer, at, MEHD_SIZE)
        mehd.setUint32(0, MEHD_SIZE)
        buf[at + 4] = 0x6d; buf[at + 5] = 0x65; buf[at + 6] = 0x68; buf[at + 7] = 0x64   // 'mehd'
        mehd.setUint32(8, 0)                        // version 0 + flags 0
        mehd.setUint32(12, UNKNOWN_DURATION)        // 占位，下面统一填
        buf.set(src.subarray(at), at + MEHD_SIZE)
        const dv1 = new DataView(buf.buffer)
        dv1.setUint32(moovAt, moovSize + MEHD_SIZE)
        dv1.setUint32(mvexAt, mvexSize + MEHD_SIZE)
      }
    }
  }

  // ── 第二步：把所有「未知」时长字段填上真实值 ──
  const out = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const dv = new DataView(out)
  const u8 = new Uint8Array(out)

  /** 时长与时基在 `mvhd`/`mdhd` 里同为 (box+20, box+24)；`tkhd` 只有时长，用影片时基 */
  let movieTimescale = 0
  const walk = (start: number, end: number) => {
    let i = start
    while (i + 8 <= end) {
      const size = dv.getUint32(i)
      if (size < 8 || i + size > end) return
      const type = typeOf(u8, i)
      const version = u8[i + 8]
      if (type === 'mvhd' && version === 0) {
        movieTimescale = dv.getUint32(i + 20)
        if (dv.getUint32(i + 24) === UNKNOWN_DURATION) {
          dv.setUint32(i + 24, Math.round(seconds * movieTimescale))
        }
      } else if (type === 'mdhd' && version === 0) {
        const ts = dv.getUint32(i + 20)
        if (dv.getUint32(i + 24) === UNKNOWN_DURATION) dv.setUint32(i + 24, Math.round(seconds * ts))
      } else if (type === 'tkhd' && version === 0) {
        if (dv.getUint32(i + 28) === UNKNOWN_DURATION && movieTimescale) {
          dv.setUint32(i + 28, Math.round(seconds * movieTimescale))
        }
      } else if (type === 'mehd' && version === 0) {
        // **这个才是分片 MP4 的正式时长**（QuickTime / AVFoundation 认的就是它）
        if (dv.getUint32(i + 12) === UNKNOWN_DURATION && movieTimescale) {
          dv.setUint32(i + 12, Math.round(seconds * movieTimescale))
        }
      } else if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'mvex') {
        walk(i + 8, i + size)   // 只往这四种容器里下钻，别去翻 mdat
      }
      i += size
    }
  }
  walk(0, out.byteLength)
  return out
}
