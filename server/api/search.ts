/**
 * 按片名搜索接口（Node + Cloudflare Workers 双环境兼容）
 *
 * 一次只搜**一个站**：并发是前端的事（各站快慢差好几秒，谁先回来先渲染谁，
 * 服务端一发把五个站串起来等于按最慢的那个算）。
 *
 * 本文件只做四件事：找规则 → 取令牌 → 抓搜索页（过反爬）→ 交给通用抽取器。
 * 站点差异全在 composables/videoSearchRules.ts 的规则表里，接新站不用改这里。
 *
 * 两步式（step）与 /api/resolve 逐字对齐，前端能复用同一套 PoW 处理：
 *   step=challenge  取页；有反爬挑战就返回 { needPow, … } 让浏览器算
 *   step=extract    带算出的 cookie 重取
 *
 * 实现约束（同 proxy.ts）：不静态 import 任何 node:*，只用 Web API。
 */
import type { PowChallenge } from '../../composables/videoParseRules'
import type { SiteSearchResult } from '../../composables/videoSearchRules'
import { buildSearchUrl, findSearchRule } from '../../composables/videoSearchRules'
import { cdndefendChallenge } from '../parsers/challenges/cdndefend'
import { dropCookie, readCookie, saveCookie } from '../parsers/cookieStore'
import { extractJsonItems, extractSearchItems, extractTotal, hasNextPage } from '../parsers/searchRule'
import { absolutize, hostOf, isCloudflareChallenge } from '../parsers/utils'
import { fetchSitePage } from '../utils/siteFetch'

// ── 搜索令牌缓存（按 host）──
// 实测 ncat 的 t 是页面上的隐藏表单字段、全站同一个值，抓一次能用很久。
// 不缓存的话每搜一次都要多抓一个 200 多 KB 的首页。TTL 与 cookieStore 对齐。
const tokenCache = new Map<string, { token: string; at: number }>()
const TOKEN_TTL = 30 * 60 * 1000

// 图床地址缓存（按 host）。它是从站点资源里现抠的（见 SearchRule.picBase），
// 全站通用、极少变，而每次搜索都要用——不缓存的话每搜一次多抓一个 js
const picBaseCache = new Map<string, { base: string; at: number }>()

export default defineEventHandler(async (event): Promise<SiteSearchResult | PowChallenge> => {
  const query = getQuery(event)
  const siteId = (query.site as string)?.trim()
  const kw = (query.kw as string)?.trim()
  const step = (query.step as string) || 'challenge'
  // 页码封顶 99：翻页是用户一页页点出来的，出现三位数只可能是拼错的地址
  const pageNo = Math.min(Math.max(Number.parseInt((query.page as string) || '1', 10) || 1, 1), 99)

  if (!siteId || !kw) throw createError({ statusCode: 400, statusMessage: '缺少 site 或 kw 参数' })

  const rule = findSearchRule(siteId)
  if (!rule) throw createError({ statusCode: 400, statusMessage: '没有这个站点的搜索规则：' + siteId })
  if (rule.manual || !rule.url) {
    // 前端本来就不该调它（manual 的站点直接画说明卡），走到这说明调用方写错了
    throw createError({ statusCode: 400, statusMessage: `「${rule.name}」的搜索只能在源站进行` })
  }

  const host = hostOf(rule.homepage)
  const challenge = rule.challenge === 'cdndefend' ? cdndefendChallenge : undefined
  const tokenFromClient = (query.cookie as string)?.trim()
  let cookie = tokenFromClient && challenge ? challenge.toCookie(tokenFromClient) : readCookie(host)

  // 有的接口靠 Referer 认「请求来自站点页面」（实测 kpkuang 的搜索接口不带就恒回空）
  const extraHeaders = rule.referer ? { Referer: rule.referer } : undefined

  /** 抓一页，顺带处理「缓存的 cookie 过期了」：清掉重抓一次，别一直用错的 */
  const grab = async (url: string) => {
    let page = await fetchSitePage(url, cookie, extraHeaders)
    if (challenge?.detect(page.body) && !tokenFromClient && cookie) {
      dropCookie(host)
      cookie = undefined
      page = await fetchSitePage(url, undefined, extraHeaders)
    }
    return page
  }

  /**
   * 封面图床地址（见 SearchRule.picBase）：从站点自己的资源里现抠，不写死域名。
   * 抠不到就返回空，上层退回「拼站点域名」——顶多是封面显示不出来，不该为它中断整次搜索。
   */
  const resolvePicBase = async (html: string): Promise<string> => {
    const cfg = rule.picBase
    if (!cfg?.re) return ''
    const hit = picBaseCache.get(host)
    if (hit && Date.now() - hit.at < TOKEN_TTL) return hit.base

    try {
      let text = html
      if (cfg.fromRe) {
        const src = html.match(new RegExp(cfg.fromRe, 'i'))?.[1]
        if (!src) return ''
        text = (await fetchSitePage(absolutize(src, rule.homepage), cookie, extraHeaders)).body
      }
      const base = text.match(new RegExp(cfg.re, 'i'))?.[1] ?? ''
      picBaseCache.set(host, { base, at: Date.now() })
      return base
    } catch { return '' }
  }

  /** 站点要挑战 → 把常量交给浏览器去算（服务端 CPU 预算跑不动，见 challenges/cdndefend.ts） */
  const powOf = (body: string): PowChallenge => {
    const ch = challenge!.build(body)
    if (!ch) throw createError({ statusCode: 502, statusMessage: '站点反爬已变更：挑战常量提取失败' })
    if (step === 'extract') {
      // 前端算的 cookie 竟然没过 → 让它重来一轮，别死循环
      throw createError({ statusCode: 409, statusMessage: '校验未通过，请重试搜索' })
    }
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { needPow: true, kind: challenge!.kind, ...ch }
  }

  // ── 1. 令牌（有的站点搜索地址里带一个页面上现抠的字段，见 SearchRule.token）──
  let token = ''
  if (rule.token) {
    const hit = tokenCache.get(host)
    if (hit && Date.now() - hit.at < TOKEN_TTL) {
      token = hit.token
    } else {
      const tokenPage = await grab(absolutize(rule.token.url ?? '/', rule.homepage))
      // 取令牌那一页同样可能是挑战页——这时先让浏览器算，算完这一轮会重来
      if (challenge?.detect(tokenPage.body)) return powOf(tokenPage.body)
      token = tokenPage.body.match(new RegExp(rule.token.re, 'i'))?.[1] ?? ''
      if (!token) throw createError({ statusCode: 502, statusMessage: '站点搜索令牌提取失败，规则需要更新' })
      tokenCache.set(host, { token, at: Date.now() })
    }
  }

  // ── 2a. JSON/JSONP 接口的站点（见 SearchRule.json）：不抓页面，直接调接口 ──
  // 这类接口偶发回空载荷（同样的参数下一秒就正常），所以要能分辨「真没搜到」和「这发抽了」，
  // 后者重试。每次都要重新 buildSearchUrl —— 模板里的 %TS%/%CB% 必须现生成，复用旧值必被判重放
  if (rule.json) {
    const tries = (rule.json.retries ?? 0) + 1
    let last = ''
    for (let i = 0; i < tries; i++) {
      const url = absolutize(buildSearchUrl(rule.url, kw, token), rule.homepage)
      last = url
      const res = await fetchSitePage(url, cookie, extraHeaders)
      // 相对地址（封面）的基准是**站点**而不是接口地址：接口常挂在另一个域名上
      // （实测 kpkuang 的接口在 kpdata.flixfiend.top，封面却在 www.kpkuang.org 下）
      const { ok, items } = extractJsonItems(res.body, rule, rule.homepage, await resolvePicBase(''))
      if (ok) {
        setResponseHeader(event, 'Cache-Control', 'no-store')
        // 接口型站点目前都是一发给完，没有翻页这回事
        return { siteId, items, page: 1, siteSearchUrl: rule.homepage }
      }
      console.log(`[search] ${siteId} 接口回了空载荷，第 ${i + 1}/${tries} 次`)
    }
    throw createError({ statusCode: 502, statusMessage: `搜索接口连续 ${tries} 次没给出结果，稍后重试（${hostOf(last)}）` })
  }

  // ── 2b. 抓搜索页 ──
  // 第 1 页仍走 url：翻页模板只在真要翻页时才用得上，让「每次搜索」这条主路径原样不动
  const tpl = pageNo > 1 && rule.pageUrl ? rule.pageUrl : rule.url
  const searchUrl = absolutize(buildSearchUrl(tpl, kw, token, pageNo), rule.homepage)
  const page = await grab(searchUrl)

  if (challenge?.detect(page.body)) return powOf(page.body)

  // Cloudflare 人机校验：不当错误报。它要浏览器指纹 + 与出口 IP 绑定的凭证，服务端永远过不去，
  // 但用户在自己的浏览器里搜是能搜到的——前端据此画「去源站搜」那张卡
  if (isCloudflareChallenge(page.status, page.body, page.headers)) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { siteId, items: [], blocked: 'cloudflare', siteSearchUrl: searchUrl }
  }

  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `源站返回 ${page.status}` })
  }

  // 走到这说明页面拿到了：cookie 记下来给后续请求（含解析接口）复用
  if (tokenFromClient && challenge) saveCookie(host, challenge.toCookie(tokenFromClient))

  // ── 3. 抠结果。一条都没抠到**不报错**：真·没搜到和规则失效长得一样，
  // 交给前端按「该站没有这部片 + 去源站搜」来说，比一句「规则需要更新」有用
  const items = extractSearchItems(page.body, rule, searchUrl, await resolvePicBase(page.body))
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    siteId,
    items,
    total: extractTotal(page.body, rule),
    page: pageNo,
    hasMore: hasNextPage(page.body, rule, pageNo),
    siteSearchUrl: searchUrl,
  }
})
