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

/**
 * **把 `moov` 里的时长补上**（下完之后回头改文件开头那几百字节）。
 *
 * mux.js 面向 MSE，时长交给 MediaSource 去管，所以它在 `mvhd`/`tkhd`/`mdhd` 里一律写
 * `0xFFFFFFFF`（未知）。文件里留着这个值的后果**分播放器**：
 *   · ffmpeg / VLC / mpv 会自己扫一遍，读数正常 —— 所以只验 ffprobe 会以为没问题；
 *   · **QuickTime 直接信 `mvhd`**，实测把 42 秒的片子显示成 27 小时，进度条整条报废（踩过）。
 * 而「能在 QuickTime / 手机上正常播」正是选 MP4 的全部理由，所以这一步不能省。
 *
 * 只改固定宽度的时长字段、不动任何 box 大小 → 补出来的字节数与原来**完全一致**，
 * 可以就地覆盖文件开头（见 `FileSink.patchStart`）。v1（64 位）的一概跳过：
 * mux.js 只写 v0，遇到别的形状宁可不改也别把 moov 改坏。
 */
export const patchFmp4Duration = (init: ArrayBuffer, seconds: number): ArrayBuffer => {
  if (!(seconds > 0)) return init
  const out = init.slice(0)
  const dv = new DataView(out)
  const u8 = new Uint8Array(out)
  const typeAt = (i: number) => String.fromCharCode(u8[i + 4]!, u8[i + 5]!, u8[i + 6]!, u8[i + 7]!)

  /** 时长字段与它的时基在 `mvhd`/`mdhd` 里同样是 (box+20, box+24)，`tkhd` 只有时长（用影片时基） */
  let movieTimescale = 0
  const walk = (start: number, end: number) => {
    let i = start
    while (i + 8 <= end) {
      const size = dv.getUint32(i)
      if (size < 8 || i + size > end) return
      const type = typeAt(i)
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
