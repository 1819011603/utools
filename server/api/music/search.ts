/**
 * 24bit.net 搜索：一次搜**一个**音源（并发是前端的事）。
 *
 * ## 为什么这一段最终也走了服务端（原本打算前端直连）
 *
 * 实测这个站点的搜索接口**响应头是允许跨域的**（`ACAO: *`，OPTIONS 预检 204 通过），
 * 服务端和站点自己的页面里发都稳定回 30 条。但从我们自己的页面跨域发就是发不出去：
 *   · POST 全是 `net::ERR_FAILED`
 *   · 连 `mode:'no-cors'` 的 GET 都挂，报 `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`
 * 而本项目**没有**设置 COEP/COOP（源码里 grep 不到，本地响应头也干净），
 * 所以拦截来自站点侧的响应策略（CORP / WAF 对跨站请求的处置），不是我们能改的。
 *
 * 附带还发现这个域名的连通性本身就不稳（同样的请求前一次 200、后一次 ConnectTimeout 到
 * Cloudflare 的 IP）。走服务端顺带能吃到 `HTTPS_PROXY`（本地开发）和更稳的出口。
 *
 * 代价是多一跳、吃 CF Pages 的请求配额，但可用性优先 —— 前端直连在真实浏览器里跑不通，
 * 省下的那一跳没有意义。
 *
 * **有本机中继时前端会绕开这条路**，见 `composables/musicSites/localRelay.ts`——
 * 那条路直接从用户自己的家庭网络出口打 24bit.net，不吃这里的 CF 风控。
 * 这条服务端路径是没开中继（或中继连不上）时的兜底，请求怎么拼、响应怎么解析
 * 挪进了 `utils/music24bitProtocol.ts`，两条路共用同一份，不会各写各的漂移。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { HEADERS_24BIT, build24bitSearchBody, build24bitSearchUrl, parse24bitSearchBody, toSearch24bitItems } from '~/utils/music24bitProtocol'
import { cfWallMessage, isCloudflareWall, musicFetch } from '../../utils/musicFetch'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const source = (query.source as string)?.trim()
  const kw = (query.kw as string)?.trim()
  // 页码封顶 99：翻页是用户一页页点出来的，三位数只可能是拼错的地址
  const page = Math.min(Math.max(Number.parseInt((query.page as string) || '1', 10) || 1, 1), 99)

  if (!kw) throw createError({ statusCode: 400, statusMessage: '缺少 kw 参数' })
  if (source !== 'one' && source !== 'two') {
    throw createError({ statusCode: 400, statusMessage: 'source 只能是 one 或 two' })
  }

  const res = await musicFetch(build24bitSearchUrl(source), {
    // 用户自己的登录态（可选），走请求头不走 query —— 凭证不该进日志和浏览器历史
    cookie: getRequestHeader(event, 'x-music-cookie'),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      /*
       * `Origin`/`Referer`（`HEADERS_24BIT`）**必带**——漏了 `Referer` 这个接口每一发都过不了
       * CF（实测确认过：完全相同的请求，不带恒 403 `Just a moment`，带上恒 200）。
       * 挪成常量导出到 `utils/music24bitProtocol.ts`，本机中继那条路也要用同一份，
       * 不然容易出现「服务端这条路带了、中继那条路漏了」的漂移（已经漏过一次）。
       */
      ...HEADERS_24BIT,
    },
    body: build24bitSearchBody(kw, page),
  })

  // 撞 CF 墙时说人话。本地开发下这几乎总是「dev server 带了 HTTPS_PROXY」造成的，
  // 而报一句「搜索接口返回 403」会让人往规则失效的方向查，差得很远
  if (isCloudflareWall(res.status, res.body)) {
    throw createError({ statusCode: 502, statusMessage: cfWallMessage('24bit') })
  }
  if (res.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `搜索接口返回 ${res.status}` })
  }

  const { ok, rows } = parse24bitSearchBody(res.body)
  if (!ok) throw createError({ statusCode: 502, statusMessage: '搜索接口没有返回结果' })

  // 搜索结果不缓存：站点会限流，缓存反而会让「刚搜到的东西点不开」更难归因
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    source,
    page,
    items: toSearch24bitItems(rows),
  }
})
