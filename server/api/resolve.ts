/**
 * 播放页解析接口（Node + Cloudflare Workers 双环境兼容）
 *
 * 用途：把「网站播放页地址」变成「真实视频地址 + 整季选集表」，直接喂给 /video-player。
 *       浏览器受 CORS 限制取不到第三方页面，必须绕服务端。
 *
 * 本文件只做四件事：匹配站点策略 → 抓页 → 过反爬握手 → 把 HTML 交给策略。
 * 站点之间的差异全部收在 server/parsers/ 下，接新站不用改这里。
 *
 * 两步式（step 参数）：
 *   step=challenge  取页；若站点有反爬挑战则返回 { needPow, c, n1, target } 让**前端**去算
 *   step=extract    带前端算出的 cookie 重取，再走策略解析
 * 为什么挑战不在服务端算：见 server/parsers/challenges/cdndefend.ts
 *
 * 实现约束（同 proxy.ts）：不静态 import 任何 node:*，只用 Web API。
 */
import type { ParseRule, ParseResult, PowChallenge } from '../../composables/videoParseRules'
import { matchParser } from '../parsers'
import { dropCookie, readCookie, saveCookie } from '../parsers/cookieStore'
import { hostOf } from '../parsers/utils'
import { fetchSitePage as fetchPage } from '../utils/siteFetch'

export default defineEventHandler(async (event): Promise<ParseResult | PowChallenge> => {
  const query = getQuery(event)
  const pageUrl = (query.url as string)?.trim()
  const step = (query.step as string) || 'challenge'
  const lineParam = query.line !== undefined ? Number.parseInt(query.line as string, 10) : undefined

  if (!pageUrl || (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://'))) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 url 参数' })
  }

  // 前端可以把用户自定义规则随请求带上来（服务端没有 localStorage）
  let extraRules: ParseRule[] = []
  if (query.rules) {
    try { extraRules = JSON.parse(query.rules as string) } catch {}
  }

  const parser = matchParser(pageUrl, extraRules)
  if (!parser) throw createError({ statusCode: 400, statusMessage: '没有匹配的解析规则：' + hostOf(pageUrl) })

  const host = hostOf(pageUrl)
  const challenge = parser.challenge
  // step=extract 时用前端算出的 cookie；否则尝试缓存
  const tokenFromClient = (query.cookie as string)?.trim()
  let cookie = tokenFromClient && challenge ? challenge.toCookie(tokenFromClient) : readCookie(host)

  let page = await fetchPage(pageUrl, cookie)

  if (challenge?.detect(page.body)) {
    // 缓存的 cookie 过期了 → 清掉，避免下次继续用错的
    if (!tokenFromClient && cookie) {
      dropCookie(host)
      cookie = undefined
      page = await fetchPage(pageUrl)
    }
  }

  if (challenge?.detect(page.body)) {
    const ch = challenge.build(page.body)
    // 抠不出常量说明站点换了反爬方案：明确报错，不要静默拿挑战页去跑正则（那只会得到空结果）
    if (!ch) throw createError({ statusCode: 502, statusMessage: '站点反爬已变更：挑战常量提取失败' })
    if (step === 'extract') {
      // 前端算的 cookie 竟然没过 → 让它重来一轮，别死循环
      throw createError({ statusCode: 409, statusMessage: '校验未通过，请重试解析' })
    }
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { needPow: true, kind: challenge.kind, ...ch }
  }

  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `源站返回 ${page.status}` })
  }

  // 走到这说明页面拿到了：把 cookie 记下来给后续请求复用（实测全站通用）
  if (tokenFromClient && challenge) {
    saveCookie(host, challenge.toCookie(tokenFromClient))
  }

  // ── 详情页 → 第 1 集播放页 ──
  // 搜索结果给的多半是详情页（…/voddetail/1033381/），而各站的播放地址只写在播放页上。
  // 在这里换一跳，下游（策略、线路号、前端的地址栏同步、播放器的 parseUrl）一律只见播放页，
  // 谁都不用知道详情页这回事。**返回的 pageUrl 必须是换过之后的那个**。
  let realUrl = pageUrl
  const hop = parser.detailPlayUrl?.({ pageUrl, host }, page.body)
  if (hop && hop !== pageUrl) {
    console.log(`[resolve] ${host} 详情页 → 播放页：${hop}`)
    realUrl = hop
    page = await fetchPage(realUrl, cookie ?? readCookie(host))
    if (page.status !== 200) {
      throw createError({ statusCode: 502, statusMessage: `取第 1 集播放页失败：源站返回 ${page.status}` })
    }
  }

  const offsetParam = query.offset !== undefined ? Number.parseInt(query.offset as string, 10) : 0
  const result = await parser.parse({
    pageUrl: realUrl,
    host,
    line: lineParam,
    offset: Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0,
    only: query.only === '1',
    cookie: cookie ?? readCookie(host),
    fetchPage,
  }, page.body)

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return result
})
