/**
 * 自己去文件里读整片 MP4 的真实时长（`moov/mvhd`）。
 *
 * ## 为什么要自己读
 *
 * 安卓 Chrome 在某些整片 MP4 上**读不出总时长**：画面正常播、时间在走，
 * 但读数是 `01:04 / 00:00`，进度条钉在最左边、拖不动（实测截图）。同一条地址在 Windows 上一切正常。
 *
 * 而**时长本来就在文件里**——把这条 4kvm 的天翼云盘直链的 moov 抠出来看，
 * `mvhd` 明明白白写着 `timescale=1000, duration=2739560`（45 分 39.6 秒）。
 * 所以不是源的问题，是浏览器的解封装没给我们。既然文件里有，我们自己读一次就是了：
 * 读到之后 UI 的总时长和进度条就跟浏览器的 demuxer 再无关系。
 *
 * ## 为什么很便宜（总共约 2.5 KB）
 *
 * 这类文件多半**不是 faststart**：布局是 `ftyp / free / mdat(651MB) / moov(2.3MB)`，
 * moov 在文件尾。但**找到它不需要知道文件多大**——顶层 box 链是自描述的：
 * 读头 2KB 就能拿到 `mdat` 的 size，`mdat 起点 + size` 就是 moov 的偏移。
 * 于是只要两发小请求：头 2KB + moov 开头那 512 字节。
 * （**不能靠 `Content-Range` 拿总长度**：跨域响应只放行几个响应头，`Content-Range`
 * 需要源站发 `Access-Control-Expose-Headers` 才对 JS 可见，绝大多数 CDN 不发。）
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/** 头部取多少：ftyp + free + mdat 的**头**加起来通常不到 64 字节，2KB 足够宽裕 */
const HEAD_BYTES = 2048
/** moov 开头取多少：mvhd 是 moov 的第一个子 box，108 字节，512 足够 */
const MOOV_HEAD_BYTES = 512
/** 顶层链上最多跟几跳（mdat 之后可能还夹着 free/skip 才到 moov） */
const MAX_HOPS = 3
/** 整个过程的死线。读不到就算了——浏览器自己那份读数仍然照用 */
const TIMEOUT_MS = 6000

export interface Mp4HeadInfo {
  /** moov/mvhd 里的真实时长（秒）。0 = 没读到 */
  durationSecs: number
  /**
   * 媒体数据字节数（`mdat` 的 size）。**平均码率的分子**，和时长来自同一发请求，白拿。
   * 用它而不是文件总长度：总长度要读 `Content-Range`，而那个头跨域时对 JS 不可见
   *（CORS 只放行几个响应头，源站又不发 `Access-Control-Expose-Headers`）。
   * mdat 之外只剩 moov 那几 MB，当码率分子完全够用。
   */
  mediaBytes: number
}

interface BoxHead { size: number; type: string; headerSize: number }

/** 读一个 box 的头。返回 null = 这段字节还不够读出它 */
function readBox(v: DataView, off: number): BoxHead | null {
  if (off + 8 > v.byteLength) return null
  let size = v.getUint32(off)
  const type = String.fromCharCode(
    v.getUint8(off + 4), v.getUint8(off + 5), v.getUint8(off + 6), v.getUint8(off + 7),
  )
  let headerSize = 8
  if (size === 1) {
    // 64 位 largesize：大 mdat 常见
    if (off + 16 > v.byteLength) return null
    size = v.getUint32(off + 8) * 2 ** 32 + v.getUint32(off + 12)
    headerSize = 16
  }
  if (size !== 0 && size < headerSize) return null   // 畸形，别拿它算偏移
  return { size, type, headerSize }
}

/**
 * 扫头部的顶层 box 链。
 * 命中 moov 就直接给它的偏移；否则给「链上第一个还没看全的 box」的偏移——
 * 那正是接着往下找的位置（这类文件上就是 mdat 之后）。
 */
function scanTopLevel(head: ArrayBuffer): { moovAt: number; nextAt: number; mdatBytes: number } {
  const v = new DataView(head)
  let off = 0
  let mdatBytes = 0
  for (;;) {
    const box = readBox(v, off)
    if (!box) return { moovAt: -1, nextAt: off, mdatBytes }
    if (box.type === 'mdat') mdatBytes += box.size
    if (box.type === 'moov') return { moovAt: off, nextAt: off, mdatBytes }
    if (box.size === 0) return { moovAt: -1, nextAt: -1, mdatBytes }   // 「一直到文件尾」，后面不会再有 moov
    off += box.size
  }
}

/** 从 moov 的开头那段字节里解出时长（秒）。0 = 解不出来 */
function durationFromMoov(buf: ArrayBuffer): number {
  const v = new DataView(buf)
  const moov = readBox(v, 0)
  if (!moov || moov.type !== 'moov') return 0

  // mvhd 按规范是 moov 的第一个子 box，但还是扫一遍更稳
  let off = moov.headerSize
  for (;;) {
    const box = readBox(v, off)
    if (!box || box.size === 0) return 0
    if (box.type === 'mvhd') break
    off += box.size
  }
  const mvhd = readBox(v, off)!
  const payload = off + mvhd.headerSize
  if (payload + 1 > v.byteLength) return 0
  const version = v.getUint8(payload)

  // payload 布局：version(1) flags(3) created(4|8) modified(4|8) timescale(4) duration(4|8)
  let timescale = 0
  let duration = 0
  if (version === 0) {
    if (payload + 20 > v.byteLength) return 0
    timescale = v.getUint32(payload + 12)
    duration = v.getUint32(payload + 16)
  } else {
    if (payload + 32 > v.byteLength) return 0
    timescale = v.getUint32(payload + 20)
    // 64 位时长：整片影视绝不会溢出双精度，拼起来就行
    duration = v.getUint32(payload + 24) * 2 ** 32 + v.getUint32(payload + 28)
  }
  if (!timescale || !duration) return 0
  const secs = duration / timescale
  return Number.isFinite(secs) && secs > 0 ? secs : 0
}

/**
 * @param url 已按连接策略算好的最终地址（`conn.getProxyUrl` 的产物）——
 *            和 `<video>` 真正在放的必须是同一个，否则等于在读另一个文件
 */
export async function probeMp4Head(url: string): Promise<Mp4HeadInfo> {
  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  /**
   * 与 HLS 分片请求同形（见 prefetch/fragLoader）：**不发本站域名当 Referer**。
   * 裸 fetch 默认会带 `Referer: <本站页面>`，防盗链的源看到不认识的来源就是 403。
   * 真需要注入头的源，地址早被 getProxyUrl 换成了 /api/proxy，由服务端注入。
   */
  const range = async (from: number, len: number): Promise<ArrayBuffer | null> => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${from}-${from + len - 1}` },
      signal: ctrl.signal,
      referrerPolicy: 'no-referrer',
    })
    if (res.status !== 206) { try { await res.body?.cancel() } catch {}; return null }
    return res.arrayBuffer()
  }

  const none: Mp4HeadInfo = { durationSecs: 0, mediaBytes: 0 }
  try {
    const head = await range(0, HEAD_BYTES)
    if (!head) return none

    let { moovAt, nextAt, mdatBytes } = scanTopLevel(head)
    const done = (secs: number): Mp4HeadInfo => ({ durationSecs: secs, mediaBytes: mdatBytes })

    // moov 就在头部（faststart）→ 头 2KB 里大概率已经含着 mvhd 了，先就地试一把
    if (moovAt >= 0) {
      const inHead = durationFromMoov(head.slice(moovAt))
      if (inHead) return done(inHead)
      nextAt = moovAt
    }

    // 顺着链往下找。mdat 之后一般直接是 moov，偶尔夹着 free/skip，所以给几跳
    for (let hop = 0; hop < MAX_HOPS && nextAt > 0; hop++) {
      const buf = await range(nextAt, MOOV_HEAD_BYTES)
      if (!buf) return done(0)
      const secs = durationFromMoov(buf)
      if (secs) return done(secs)
      const box = readBox(new DataView(buf), 0)
      if (!box || box.size === 0) return done(0)
      nextAt += box.size
    }
    return done(0)
  } catch {
    return none   // 超时 / 被拦 / 结构不认识 —— 一律安静放弃，浏览器那份读数照用
  } finally {
    clearTimeout(killer)
  }
}
