/**
 * 24bit.net 取址：详情页 HTML → 播放地址。
 *
 * **为什么必须走服务端**：详情页响应**没有 `ACAO`**，浏览器跨域取不到 HTML。
 * （搜索接口和 CDN 都是 `ACAO: *`，那两段前端直连，见 composables/music24bit.ts 的分层说明。）
 *
 * **有本机中继时前端会绕开这条路**（见 `composables/musicSites/localRelay.ts`），
 * 中继直接从家庭网络出口打 24bit.net、不受 CORS 约束也不吃这里的 CF 风控；
 * 这条服务端路径是没开中继时的兜底。HTML 怎么解析挪进了 `utils/music24bitProtocol.ts`，
 * 两条路共用同一份 `extractItemMusic24bit`。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { HEADERS_24BIT, build24bitDetailUrl, extractItemMusic24bit, isQuotaExhausted24bit, toResolvedPayload } from '~/utils/music24bitProtocol'
import { cfWallMessage, isCloudflareWall, musicFetch } from '../../utils/musicFetch'
import { readUrlCache, writeUrlCache } from '../../utils/musicUrlCache'

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

  /*
   * 服务端缓存先行 —— 这一层比前端缓存值钱得多。
   *
   * 站点的每日配额**按 IP 算**，而我们所有用户共用服务端这一个出口 IP：
   * 一个人取过的歌，对所有人都不必再取。命中缓存 = 零配额消耗。
   */
  const cached = readUrlCache(id, prefix)
  if (cached) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { ...cached, src: prefix, cached: true }
  }

  /*
   * 用户自己的登录态（可选），走**请求头**而不是 query ——
   * query 会进访问日志、浏览器历史和 Referer，凭证不该出现在那些地方。
   */
  const cookie = getRequestHeader(event, 'x-music-cookie')

  // `HEADERS_24BIT` 必带，同 search.ts 那处发现——不带 Referer 这个接口逢发必 403
  const page = await musicFetch(build24bitDetailUrl(prefix, id), { cookie, headers: HEADERS_24BIT })

  // 撞 CF 墙时说人话：本地开发下这几乎总是「dev server 带了 HTTPS_PROXY」造成的
  // （代理出口 IP 会被 Cloudflare 拦，实测直连 200、经代理 403）
  if (isCloudflareWall(page.status, page.body)) {
    throw createError({ statusCode: 502, statusMessage: cfWallMessage('24bit') })
  }
  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `源站返回 ${page.status}` })
  }

  /*
   * 配额耗尽必须**先于** itemMusic 判断，而且要用独立状态码。
   *
   * 这两种情况在状态码上一模一样（都是 200 + 没有 itemMusic），只有页面正文能区分：
   *   · 配额用完 → 429，前端据此**立刻停手**：再试另一个音源、再排后面的歌全是白费
   *   · 单纯没有 itemMusic → 404，那是「这个音源没这首歌」，换个音源还有戏
   * 不分开的话，配额一用完就会把整份队列拖着一首首失败一遍，还每首都多烧一发请求。
   */
  if (isQuotaExhausted24bit(page.body)) {
    throw createError({ statusCode: 429, statusMessage: '音乐站今日访问配额已用完（该站对匿名访问按天限量），明天再来，或到 24bit.net 登录后使用。' })
  }

  const item = extractItemMusic24bit(page.body)
  if (!item?.url) {
    throw createError({ statusCode: 404, statusMessage: '这个音源没有这首歌，换一个音质档试试' })
  }

  const payload = toResolvedPayload(item)
  writeUrlCache(id, prefix, payload)

  // 地址本身带时效签名（约 20 分钟），**响应绝不能被 HTTP 层缓存**——
  // 那一层不认识签名什么时候过期，缓存久了发出去的就是死链。有效期由我们自己按签名管
  setResponseHeader(event, 'Cache-Control', 'no-store')

  /** `src` = 实际命中的音源，前端记下来供下次优先尝试，省掉一发注定失败的请求 */
  return { ...payload, src: prefix, cached: false }
})
