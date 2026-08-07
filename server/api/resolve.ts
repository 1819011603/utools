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
import type { FetchedPage } from '../parsers/types'
import { hostOf } from '../parsers/utils'
import { getSiteDispatcher } from '../utils/siteFetch'

// 与 proxy.ts:63 保持一致：源站普遍按 UA 做粗筛
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

// ── 挑战 cookie 缓存（按 host）──
// 实测同一站点不同影片页拿到的挑战常量完全相同，且数分钟内稳定，
// 所以一次工作量证明可全站复用。TTL 与 proxy.ts 的 headerModeCache 对齐（30 分钟）。
const cookieCache = new Map<string, { cookie: string; at: number }>()
const COOKIE_TTL = 30 * 60 * 1000

function readCookie(host: string): string | undefined {
  const hit = cookieCache.get(host)
  if (!hit) return undefined
  if (Date.now() - hit.at > COOKIE_TTL) {
    cookieCache.delete(host)
    return undefined
  }
  return hit.cookie
}

async function fetchPage(url: string, cookie?: string): Promise<FetchedPage> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (cookie) headers['Cookie'] = cookie

  const dispatcher = await getSiteDispatcher()
  const opts: RequestInit & { dispatcher?: any } = { headers, redirect: 'follow' }
  if (dispatcher) opts.dispatcher = dispatcher

  try {
    // 用原生 fetch 而非 $fetch：挑战页返回的是非标准状态码 850，
    // ofetch 会直接当错误抛掉，我们拿不到 body 里的挑战常量。
    const res = await fetch(url, opts as RequestInit)
    return { status: res.status, body: await res.text() }
  } catch (e) {
    // 原始报错只有一句 "fetch failed"，根本没法排查，把 cause 带出来。
    // 必须用 createError 而不是裸 Error：裸 Error 会被 h3 归成 500 +「internal server error」，
    // statusMessage 到不了前端，界面上只剩一句 Internal Server Error，等于什么都没说。
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const code = err.cause?.code || ''
    const detail = code || err.cause?.message || err.message
    // 连不上/超时/DNS 失败，本地开发最常见的原因就是 Node 不走系统代理（见 CLAUDE.md「本地开发注意」）
    const unreachable = /TIMEOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|CERT/i.test(detail)
    throw createError({
      statusCode: 502,
      statusMessage: unreachable
        ? `服务端连不上 ${hostOf(url)}（${detail}）。本地开发请先设 HTTPS_PROXY 再起 dev；线上则是源站不可达`
        : `抓取失败：${detail}`,
    })
  }
}

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
      cookieCache.delete(host)
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
    cookieCache.set(host, { cookie: challenge.toCookie(tokenFromClient), at: Date.now() })
  }

  const offsetParam = query.offset !== undefined ? Number.parseInt(query.offset as string, 10) : 0
  const result = await parser.parse({
    pageUrl,
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
