/**
 * 封面图代理（搜索结果的海报专用）。
 *
 * 由来：有的站点**连图片请求都过反爬**——实测 ncat 的封面直接取回来是 850 + 挑战页 HTML
 * 而不是 JPEG，浏览器那边就是一排破图；另有一些站点的图床认 Referer 或干脆被 DNS 污染
 * （本机直连超时，只有服务端那条带 HTTPS_PROXY 的通道走得通）。
 *
 * 服务端手上恰好有这些东西：搜索时浏览器算出来的反爬 cookie（cookieStore，按 host）、
 * 抓页用的 dispatcher。所以让它代取一趟即可，前端**只在直连失败时**才退到这条路
 * （见 SiteResults.vue 的 onerror），能直连的站一个字节都不经过我们。
 *
 * 与 /api/proxy 的分工：那条是视频流通道（按分片下载调过参数、会改写 m3u8），
 * 这里只是几十 KB 的图片，缓存一天，两者不要混用。
 */
import { readCookie } from '../parsers/cookieStore'
import { hostOf } from '../parsers/utils'
import { getSiteDispatcher } from '../utils/siteFetch'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

// 海报再大也就几百 KB，超过这个数说明取回来的不是图（多半是挑战页或错误页）
const MAX_BYTES = 4 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const url = (getQuery(event).url as string)?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 url 参数' })
  }

  const host = hostOf(url)
  const origin = new URL(url).origin
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    // 图床普遍认 Referer；站点自己的页面就是这么发的
    Referer: origin + '/',
  }
  // 搜索时浏览器算过的反爬 cookie，图片请求同样要带（ncat 的封面就卡在这）
  const cookie = readCookie(host)
  if (cookie) headers['Cookie'] = cookie

  const dispatcher = await getSiteDispatcher()
  const opts: RequestInit & { dispatcher?: any } = { headers, redirect: 'follow' }
  if (dispatcher) opts.dispatcher = dispatcher

  let res: Response
  try {
    res = await fetch(url, opts as RequestInit)
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: '取封面失败：' + ((e as Error).message || '连不上') })
  }

  const type = res.headers.get('content-type') || ''
  // 反爬没过时回的是 HTML（状态码可能还是 200 或站点自定义的 850）。
  // 明确报错而不是把 HTML 当图片吐回去——那样浏览器只会显示破图，没人知道为什么
  if (!res.ok || !type.startsWith('image/')) {
    throw createError({ statusCode: 502, statusMessage: `源站没给出图片（${res.status} ${type || '无类型'}）` })
  }

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw createError({ statusCode: 502, statusMessage: '封面过大' })

  setResponseHeader(event, 'Content-Type', type)
  // 海报几乎不变，缓存一天：翻回搜索页、切 tab 都不该再打一次源站
  setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')
  return new Uint8Array(buf)
})
