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
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { cfWallMessage, isCloudflareWall, musicFetch } from '../../utils/musicFetch'

const BASE = 'https://www.24bit.net'

/** 站点只有这两个搜索接口，白名单挡住拼接注入 */
const APIS: Record<string, string> = {
  one: 'searchOnlineMusicOne',
  two: 'searchOnlineMusicTwo',
}

interface Row {
  id?: string
  name?: string
  player?: string
  album?: string
  cover?: string
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const source = (query.source as string)?.trim()
  const kw = (query.kw as string)?.trim()
  // 页码封顶 99：翻页是用户一页页点出来的，三位数只可能是拼错的地址
  const page = Math.min(Math.max(Number.parseInt((query.page as string) || '1', 10) || 1, 1), 99)

  if (!kw) throw createError({ statusCode: 400, statusMessage: '缺少 kw 参数' })
  const api = APIS[source]
  if (!api) throw createError({ statusCode: 400, statusMessage: 'source 只能是 one 或 two' })

  const res = await musicFetch(`${BASE}/api/player/${api}`, {
    // 用户自己的登录态（可选），走请求头不走 query —— 凭证不该进日志和浏览器历史
    cookie: getRequestHeader(event, 'x-music-cookie'),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 站点自己发这个请求时 Origin 就是它自己；带上比不带稳（有的 WAF 拿它做一致性检查）
      'Origin': BASE,
      'Accept': '*/*',
      /*
       * **漏了这个头，这个接口每一发都过不了 CF**——实测确认过：完全相同的请求，
       * 不带 Referer 恒 403 `Just a moment`，带上恒 200。之前一直以为是运气不好、
       * 是「这一刻被判可疑」，其实是**必然**的：站点自己的前端发这个请求时，
       * Referer 天然就是自己的页面，我们服务端替用户转发时没照抄这一条，
       * 变成了「看起来像脚本」的请求，每次都被拦，跟出口 IP、跟运气都无关。
       */
      'Referer': `${BASE}/`,
    },
    /*
     * `keyword` 是**双重编码**的：站点前端先 encodeURIComponent() 再 JSON.stringify()。
     * 塞原文进去恒回空结果 —— 这不是我们在绕什么，是照抄它自己的请求。
     */
    body: JSON.stringify({ keyword: encodeURIComponent(kw), page }),
  })

  // 撞 CF 墙时说人话。本地开发下这几乎总是「dev server 带了 HTTPS_PROXY」造成的，
  // 而报一句「搜索接口返回 403」会让人往规则失效的方向查，差得很远
  if (isCloudflareWall(res.status, res.body)) {
    throw createError({ statusCode: 502, statusMessage: cfWallMessage('24bit') })
  }
  if (res.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `搜索接口返回 ${res.status}` })
  }

  let json: { status?: boolean; result?: Row[] } | null = null
  try { json = JSON.parse(res.body) } catch { /* 下面统一按「没给结果」处理 */ }
  if (!json?.status) throw createError({ statusCode: 502, statusMessage: '搜索接口没有返回结果' })

  const rows = Array.isArray(json.result) ? json.result : []

  // 搜索结果不缓存：站点会限流，缓存反而会让「刚搜到的东西点不开」更难归因
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    source,
    page,
    /*
     * 只透传我们要用的字段。`cover` 故意**不透传**：实测它是 segmentfault 图床的占位图，
     * 同一次搜索里所有条目完全相同，摆到界面上只会让整页看起来像同一首歌。
     * 真封面只有详情页的 itemMusic.cover 有，取址成功后会回填。
     */
    items: rows
      .filter(r => r.id && r.name)
      .map(r => ({ id: r.id!, name: r.name!, player: r.player ?? '', album: r.album ?? '' })),
  }
})
