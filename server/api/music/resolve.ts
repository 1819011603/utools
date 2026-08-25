/**
 * 24bit.net 取址：详情页 HTML → 播放地址。
 *
 * **为什么必须走服务端**：详情页响应**没有 `ACAO`**，浏览器跨域取不到 HTML。
 * （搜索接口和 CDN 都是 `ACAO: *`，那两段前端直连，见 composables/music24bit.ts 的分层说明。）
 *
 * 地址内嵌在 Next.js App Router 的 RSC flight data 里，形如：
 *   "itemMusic":{"id":…,"url":…,"size":…,"quality":…,"format":…,"cover":…,"name":…,"player":…,"album":…}
 * 整段被转义了多层（`\\\"`），所以不能直接跑 JSON.parse，要先规约再按括号配对切出来。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { CF_WALL_MESSAGE, isCloudflareWall, musicFetch } from '../../utils/musicFetch'

const BASE = 'https://www.24bit.net'

/** 站点自报的字段。`url` 之外都是元数据，缺了不影响播放 */
interface ItemMusic {
  id?: string
  url?: string
  size?: string
  quality?: string
  format?: string
  cover?: string
  name?: string
  player?: string
  album?: string
}

/**
 * 从详情页 HTML 里切出 itemMusic。
 *
 * flight data 的转义层数不固定（外层 JS 字符串套 JSON 再套 JSON），所以**反复规约**
 * 到没有 `\"` 为止，而不是写死剥几层——写死层数在站点改一次构建配置后就会静默失效。
 */
function extractItemMusic(html: string): ItemMusic | null {
  const at = html.indexOf('itemMusic')
  if (at < 0) return null

  // 2500 字足够覆盖整个对象（实测最长的 url 288 字符，全部字段加起来不到 1KB）
  let seg = html.slice(at, at + 2500)
  let prev = ''
  while (seg !== prev) {
    prev = seg
    seg = seg.split('\\"').join('"')
  }

  const start = seg.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < seg.length; i++) {
    if (seg[i] === '{') depth++
    else if (seg[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null

  try {
    return JSON.parse(seg.slice(start, end + 1)) as ItemMusic
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const id = (query.id as string)?.trim()
  // 前缀是两个音源（b=酷我/无损，c=网易云/高清环绕声），不是随便什么值都能拼进路径
  const prefix = (query.src as string)?.trim()

  if (!id || !/^[a-z0-9]{8,64}$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 id' })
  }
  if (prefix !== 'b' && prefix !== 'c') {
    throw createError({ statusCode: 400, statusMessage: 'src 只能是 b 或 c' })
  }

  const page = await musicFetch(`${BASE}/music/${prefix}/${id}`)

  // 撞 CF 墙时说人话：本地开发下这几乎总是「dev server 带了 HTTPS_PROXY」造成的
  // （代理出口 IP 会被 Cloudflare 拦，实测直连 200、经代理 403）
  if (isCloudflareWall(page.status, page.body)) {
    throw createError({ statusCode: 502, statusMessage: CF_WALL_MESSAGE })
  }
  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `源站返回 ${page.status}` })
  }

  const item = extractItemMusic(page.body)

  /*
   * 抠不到 itemMusic 有两种可能，而它们**在响应上完全无法区分**：
   *   ① 这首歌在这个音源下真的没有资源
   *   ② 我们被限流了 —— 实测密集取址之后，站点照常回 200、页面照常渲染，
   *      只是不再吐 itemMusic，没有错误码、没有 cf-mitigated、没有任何「频繁」字样
   * 所以这里**只报事实，不下结论**（404 = 没拿到地址），措辞留给前端，
   * 由它结合「最近连续失败了几次」来判断该说哪一种。写死任何一种都是在误导用户。
   */
  if (!item?.url) {
    throw createError({ statusCode: 404, statusMessage: '这个音源没有给出播放地址' })
  }

  // 地址带时效签名（路径里那段时间戳是过期时刻，约 20 分钟后作废）→ 绝不能缓存
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    url: item.url,
    format: item.format,
    sizeText: item.size,
    quality: item.quality,
    cover: item.cover,
    name: item.name,
    artist: item.player,
    album: item.album,
    /** 实际命中的音源，前端记下来供下次优先尝试，省掉一发注定失败的请求 */
    src: prefix,
  }
})
