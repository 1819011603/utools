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

export function isM3u8Url(url: string): boolean {
  const cut = url.search(/[?#]/)
  const path = cut === -1 ? url : url.slice(0, cut)
  const rest = cut === -1 ? '' : url.slice(cut)
  const last = path.slice(path.lastIndexOf('/') + 1)

  if (/\.m3u8?$/i.test(last)) return true
  if (MEDIA_EXT.test(last)) return false
  return /m3u8/i.test(last) || /m3u8/i.test(rest)
}
