/**
 * 「这个地址是不是 HLS 清单」的统一判据（前后端共用，server/ 下用相对路径 import）。
 *
 * 绝不能用 `url.includes('.m3u8')`——踩过：有的站点把 `.m3u8` 当**目录名**，
 * 分片地址长这样 `https://cdn/video/xxx/20241110HVeUlTF2index.m3u8/0000000.ts`。
 * 全串匹配会把 ts 分片判成清单，后果是两处同时坏掉：
 *   1. `/api/proxy` 对二进制分片走 `response.text()`，返回乱码 + `application/vnd.apple.mpegurl`
 *   2. `noseg=1` 失效（分片被逐个改写成代理地址），分片直连的优化全丢
 * 表现是「缓冲一直在涨但永远播不了」，而探测阶段每一路都是 200，看不出问题。
 *
 * 判据按优先级：
 *   1. 路径最后一段以 .m3u8 / .m3u 结尾 → 是清单
 *   2. 最后一段是已知媒体/字幕/密钥扩展名 → 一定不是清单（拦住上面那种目录名）
 *   3. 都不是（接口式地址，如 `/api/bfM3U8.php?url=…m3u8…`）→ 只在**最后一段和 query**
 *      里松散匹配 m3u8，绝不看目录部分
 */

const MEDIA_EXT =
  /\.(ts|m4s|mp4|m4v|m4a|mp3|aac|ac3|eac3|flac|wav|ogg|opus|webm|mkv|mov|avi|flv|jpe?g|png|webp|gif|vtt|srt|ass|key)$/i

/**
 * 「这个地址是不是 FLV 流」（直播拉流 / 点播 flv 都算）。
 *
 * 判据顺序照 `isM3u8Url` 的思路：先看路径最后一段的扩展名，再退一步看 query——
 * 直播地址的扩展名常被签名参数挤到 query 前面（抖音那种 `…_uiqsd5.flv?expire=…&biz_protocol=flv`
 * 路径段仍是 `.flv`，但也有站把容器写在 query 里）。目录部分一律不看，理由同上面那条。
 */
export function isFlvUrl(url: string): boolean {
  const cut = url.search(/[?#]/)
  const path = cut === -1 ? url : url.slice(0, cut)
  const rest = cut === -1 ? '' : url.slice(cut)
  const last = path.slice(path.lastIndexOf('/') + 1)

  if (/\.flv$/i.test(last)) return true
  if (MEDIA_EXT.test(last)) return false
  return /[?&](biz_)?protocol=flv\b/i.test(rest) || /\.flv([?&]|$)/i.test(rest)
}

/**
 * 把地址尾巴上的 `&origin=`/`&referer=` 拆出来当候选防盗链头。
 *
 * 分享出来的直链常这么拼（抖音那种 `v26-web.douyinvod.com` 就是），而**参数留在地址里 CDN 压根不看**：
 * 实测同一条地址不带 `Referer` 头一律 403、带上就是 206，把这两段原样贴在 query 上照旧 403。
 * 它们只有变成**请求头**才有用，而 Origin/Referer 是 forbidden headers，只能经 `/api/proxy` 注入
 * ——所以必须拆成候选值交给连接策略，留在地址里等于没填。
 *
 * 只在值本身就是个 http(s) 地址时才认：站点自己也可能带 `origin=cn` 这类同名参数，
 * 一律吃掉会把签名的一部分抠走。手工切串不用 `URLSearchParams`：它把 `+` 编码成空格，
 * 而签名里常有裸 `+`。
 */
export function liftRefererHints(url: string): { url: string; origin: string; referer: string } {
  const none = { url, origin: '', referer: '' }
  const cut = url.indexOf('?')
  if (cut === -1) return none

  const hashAt = url.indexOf('#', cut)
  const query = url.slice(cut + 1, hashAt === -1 ? undefined : hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)

  const kept: string[] = []
  let origin = ''
  let referer = ''
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const raw = eq === -1 ? '' : part.slice(eq + 1)
    let val = raw
    try { val = decodeURIComponent(raw) } catch {}

    if (/^https?:\/\/[^/?#]/i.test(val) && (key === 'origin' || key === 'referer')) {
      if (key === 'origin') origin = val
      else referer = val
      continue
    }
    kept.push(part)
  }

  if (!origin && !referer) return none
  return { url: url.slice(0, cut) + (kept.length ? '?' + kept.join('&') : '') + hash, origin, referer }
}

export function isM3u8Url(url: string): boolean {
  const cut = url.search(/[?#]/)
  const path = cut === -1 ? url : url.slice(0, cut)
  const rest = cut === -1 ? '' : url.slice(cut)
  const last = path.slice(path.lastIndexOf('/') + 1)

  if (/\.m3u8?$/i.test(last)) return true
  if (MEDIA_EXT.test(last)) return false
  return /m3u8/i.test(last) || /m3u8/i.test(rest)
}
