/**
 * TS → MP4 重封装的**第一段**：把 TS 交给 mux.js，拿回 fMP4 片段（`moof+mdat`）。
 * 第二段是 `mp4Writer.ts`，它把这些片段改写成**普通 MP4** —— 那一层不能省，理由见那个文件的头注释
 *（一句话：AVFoundation 算不对 fMP4 的时长，而改头治不好）。
 *
 * remux = **不重编码**：H.264/AAC 的字节原样搬容器，画质无损、几乎不吃 CPU。
 * 用 mux.js（**只动态 import `lib/mp4/transmuxer`**，不整包引：整包还带 flv / partial / inspector）。
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

  const drain = (feed?: ArrayBuffer): RemuxOutput => {
    out = { fragments: [] }
    if (feed) transmuxer.push(new Uint8Array(feed))
    // 每片都 flush：不 flush 的话 mux.js 会一直攒着（它本来是为「一段一段喂给 MSE」设计的），
    // 攒到最后等于把整集放在内存里
    transmuxer.flush()
    return out
  }

  return { push: ts => drain(ts), finish: () => drain() }
}

/** mux.js 给的是 Uint8Array（可能是某个大 buffer 的视图），必须**按视图边界拷出来**再交给写盘 */
const toBuf = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
