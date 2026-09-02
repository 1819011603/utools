/**
 * TS → MP4 重封装的**第一段**：把 TS 交给 mux.js，拿回 fMP4 片段（`moof+mdat`）。
 * 第二段是 `mp4Writer.ts`，它把这些片段改写成**普通 MP4** —— 那一层不能省，理由见那个文件的头注释
 *（一句话：AVFoundation 算不对 fMP4 的时长，而改头治不好）。
 *
 * remux = **不重编码**：H.264/AAC 的字节原样搬容器，画质无损、几乎不吃 CPU。
 * 用 mux.js（**只动态 import `lib/mp4/transmuxer`**，不整包引：整包还带 flv / partial / inspector）。
 *
 * **这个包依赖 `patches/mux.js+*.patch`（patch-package）**：原版 mux.js 遇到不完整的音频
 * PES 包会直接静默丢弃整包（不是丢几个字节，是丢几百字节，几十片下来就是几十秒）——某些 CDN
 * 切 HLS 分片时经常切在音频 PES 包中间，ffmpeg 能容忍这种情况照样把已有字节吐出来，
 * mux.js 不能，且不报错、不警告，症状是「下载的 mp4 开头正常、越播音画越不同步」。
 * 补丁让它跟 ffmpeg 一样宽容。**`npm install` 后没跑 `patch-package` 就是踩着这个坑。**
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

export interface RemuxOutput {
  /** `ftyp+moov`，只有第一次会给。里面的 `stsd`（编解码配置）是 `mp4Writer` 的模板来源 */
  init?: ArrayBuffer
  /** 这一批 `moof+mdat`（**一批可能有好几对**，见下面 remux:true 的说明） */
  fragments: ArrayBuffer[]
}

export interface TsRemuxer {
  /** 喂一片 TS，拿回这一片 remux 出来的 MP4 片段 */
  push: (ts: ArrayBuffer) => RemuxOutput
  /** 收工。mux.js 是 push/flush 成对的，这里只是留个对称的口子 */
  finish: () => RemuxOutput
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

  /*
   * `remux: true` → 音视频**合到同一次交货里**。注意它给的不是「一个 moof 带两个 traf」，
   * 而是 `type: 'combined'` 的一整段 buffer，里面**依次排着好几对 `moof+mdat`**
   *（音频那一片、视频那一片）。下游按对遍历，别只处理第一对 —— 那样只有音频（踩过）。
   */
  const transmuxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false })

  let initTaken = false
  let out: RemuxOutput = { fragments: [] }

  transmuxer.on('data', (seg: any) => {
    // `initSegment` 每片都会带上（MSE 那边允许重复 append），但**只取第一份**：
    // 它是普通 MP4 的 `moov` 模板，取第二份没有意义
    if (!initTaken && seg.initSegment?.byteLength) {
      initTaken = true
      out.init = toBuf(seg.initSegment)
    }
    if (seg.data?.byteLength) out.fragments.push(toBuf(seg.data))
  })

  /*
   * **不能每片都 flush**：不 flush 的话 mux.js 会把没交货的帧全攒在内存里，
   * 整集不 flush 就是把整集攒在内存里；攒够一批再 flush 一次，用内存换回收节奏。
   *
   * 攒批的口子按**字节数**而不是**片数**：分片大小随源码率浮动很大（480p 几十 KB、
   * 1080p 可能几 MB），按片数攒（曾经写的是「12 片」）在低码率源上攒出的内存很小、
   * 在高码率源上一批就是大几十 MB，波动没法预估。按字节数攒能让内存占用不管什么源
   * 都稳定在 `FLUSH_EVERY_BYTES` 这一个数量级。
   *
   * **这不是音画同步 bug 的修复**（那个真根因是 mux.js 遇到不完整音频 PES 包会静默整包丢弃，
   * 已经用 `patches/mux.js+*.patch` 修了，见文件头注释）——flush 频率对那个 bug 只有几秒的
   * 边际影响，这里纯粹是内存占用的可预测性考量。
   */
  const FLUSH_EVERY_BYTES = 100 * 1024 * 1024
  let pendingBytes = 0

  const flushNow = (): RemuxOutput => {
    out = { fragments: [] }
    transmuxer.flush()
    pendingBytes = 0
    return out
  }

  const push = (feed: ArrayBuffer): RemuxOutput => {
    transmuxer.push(new Uint8Array(feed))
    pendingBytes += feed.byteLength
    if (pendingBytes < FLUSH_EVERY_BYTES) return { fragments: [] }
    return flushNow()
  }

  const finish = (): RemuxOutput => (pendingBytes > 0 ? flushNow() : { fragments: [] })

  return { push, finish }
}

/** mux.js 给的是 Uint8Array（可能是某个大 buffer 的视图），必须**按视图边界拷出来**再交给写盘 */
const toBuf = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
