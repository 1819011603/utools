/**
 * 播放页解析接口（Node + Cloudflare Workers 双环境兼容）
 *
 * 用途：把「网站播放页地址」变成「真实视频地址 + 整季选集表」，直接喂给 /video-player。
 *       浏览器受 CORS 限制取不到第三方页面，必须绕服务端。
 *
 * 两步式（step 参数）：
 *   step=challenge  取页；若站点有反爬挑战则返回 { needPow, c, n1, target } 让**前端**去算
 *   step=extract    带前端算出的 cookie 重取，解析出线路 × 选集，并并发解析选中线路的每一集
 *
 * 为什么 PoW 不在服务端算：
 *   cdndefend 的挑战是「暴力找 nonce 使 SHA1 命中 2 个特定字节」，期望 6.5 万次哈希、
 *   实测 ~250ms CPU。CF Workers 免费版每请求只有 10ms CPU，服务端硬算必然超限。
 *   挑战本身不依赖 DOM/浏览器指纹，纯 SHA1，所以放前端算完全等价。
 *
 * 实现约束（同 proxy.ts）：不静态 import 任何 node:*，只用 Web API。
 */
import { BUILTIN_PARSE_RULES } from '../../composables/videoParseRules'
import type { ParseRule, ParsedEpisode, ParsedLine, ParseResult } from '../../composables/videoParseRules'
import { getSiteDispatcher } from '../utils/siteFetch'

// 与 proxy.ts:63 保持一致：源站普遍按 UA 做粗筛
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

// 单次请求最多解析多少集。CF 免费版单请求 50 subrequest 硬顶，
// 留出主页面那一发和余量，取 40。超出部分不静默丢弃，用 truncated 回报给前端。
const MAX_EPISODES = 40
// 解析各集的并发。太高会被源站限流，也更容易撞 CF 的并发子请求限制。
const EPISODE_CONCURRENCY = 4

// ── 挑战 cookie 缓存（按 host）──
// 实测同一站点不同影片页拿到的挑战常量完全相同，且数分钟内稳定，
// 所以一次 PoW 可全站复用。TTL 与 proxy.ts 的 headerModeCache 对齐（30 分钟）。
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

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

function matchRule(url: string, extra: ParseRule[]): ParseRule | null {
  const host = hostOf(url)
  if (!host) return null
  for (const rule of [...extra, ...BUILTIN_PARSE_RULES]) {
    const p = rule.pattern
    if (!p) continue
    if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
      try { if (new RegExp(p.slice(1, -1), 'i').test(url)) return rule } catch {}
    } else if (host.includes(p)) {
      return rule
    }
  }
  return null
}

async function fetchPage(url: string, cookie?: string): Promise<{ status: number; body: string }> {
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
    // 原始报错只有一句 "fetch failed"，根本没法排查，把 cause 带出来
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const cause = err.cause?.code || err.cause?.message || ''
    throw new Error(cause ? `${err.message} (${cause})` : err.message)
  }
}

/** 挑战页判据用 body 内容而非状态码——站点改状态码时不会整个失效 */
function isChallenge(body: string): boolean {
  return body.includes('cdndefend_js_cookie')
}

/**
 * 从挑战页里抠出常量。
 * 页面 JS 被混淆过，但挑战常量始终是其中唯一的 40 位大写十六进制串（SHA1 长度）。
 * n1（校验字节偏移）由常量首字符决定，目标字节 0xB0 0x0B 是反混淆后固定写死的。
 */
function parseChallenge(body: string): { c: string; n1: number } | null {
  const m = body.match(/['"]([0-9A-F]{40})['"]/)
  if (!m) return null
  const c = m[1]
  const n1 = Number.parseInt(c[0], 16)
  if (!Number.isFinite(n1)) return null
  return { c, n1 }
}

function absolutize(href: string, base: string): string {
  try { return new URL(href, base).href } catch { return href }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()
}

/** 解析线路 × 选集表。该站把所有线路的选集都渲染在同一页，故只需一次请求。 */
function parseLines(html: string, rule: ParseRule, pageUrl: string): { lines: ParsedLine[]; activeIndex: number } {
  if (!rule.lineRe || !rule.episodeGroupRe || !rule.episodeRe) return { lines: [], activeIndex: -1 }

  const lineMatches = [...html.matchAll(new RegExp(rule.lineRe, 'gi'))]
  const groupMatches = [...html.matchAll(new RegExp(rule.episodeGroupRe, 'gi'))]

  const lines: ParsedLine[] = []
  let activeIndex = -1

  // 线路标签与选集容器按出现顺序一一对应（三个不同页面实测恒等：16/16、18/18、17/17）。
  // 数量不等说明页面改版了，此时宁可只输出能对上的前 N 组，也不要错位。
  const n = Math.min(lineMatches.length, groupMatches.length)
  for (let i = 0; i < n; i++) {
    const lm = lineMatches[i]
    const active = /active/i.test(lm[1] ?? '')
    if (active) activeIndex = i

    const inner = groupMatches[i][1] ?? ''
    const episodes: ParsedEpisode[] = [...inner.matchAll(new RegExp(rule.episodeRe, 'gi'))].map(em => ({
      // 电影页这里是「TC高清」这类版本标签而非「第N集」，不要假设是数字
      title: decodeEntities(em[2] ?? ''),
      pageUrl: absolutize(decodeEntities(em[1] ?? ''), pageUrl),
    }))

    lines.push({
      name: decodeEntities(lm[2] ?? `线路${i + 1}`),
      sublabel: decodeEntities(lm[3] ?? '') || undefined,
      active,
      episodes,
    })
  }

  return { lines, activeIndex }
}

function parseSource(html: string, rule: ParseRule): string | undefined {
  const m = html.match(new RegExp(rule.sourceRe, 'i'))
  return m?.[1]
}

function parseTitle(html: string): string | undefined {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  if (!m) return undefined
  // 站点标题形如「斯特林角-网飞猫」，去掉站名后缀
  return decodeEntities(m[1]).replace(/[-|_–]\s*[^-|_–]{1,12}$/, '').trim() || undefined
}

/** 固定并发的任务池（不引第三方依赖） */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export default defineEventHandler(async (event): Promise<ParseResult | { needPow: true; kind: string; c: string; n1: number; target: [number, number] }> => {
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

  const rule = matchRule(pageUrl, extraRules)
  if (!rule) throw createError({ statusCode: 400, statusMessage: '没有匹配的解析规则：' + hostOf(pageUrl) })

  const host = hostOf(pageUrl)
  // step=extract 时用前端算出的 cookie；否则尝试缓存
  const cookieFromClient = (query.cookie as string)?.trim()
  let cookie = cookieFromClient ? `cdndefend_js_cookie=${cookieFromClient}` : readCookie(host)

  let page = await fetchPage(pageUrl, cookie)

  if (isChallenge(page.body)) {
    // 缓存的 cookie 过期了 → 清掉，避免下次继续用错的
    if (!cookieFromClient && cookie) {
      cookieCache.delete(host)
      cookie = undefined
      page = await fetchPage(pageUrl)
    }
  }

  if (isChallenge(page.body)) {
    const ch = parseChallenge(page.body)
    // 抠不出常量说明站点换了反爬方案：明确报错，不要静默拿挑战页去跑正则（那只会得到空结果）
    if (!ch) throw createError({ statusCode: 502, statusMessage: '站点反爬已变更：挑战常量提取失败' })
    if (step === 'extract') {
      // 前端算的 cookie 竟然没过 → 让它重来一轮，别死循环
      throw createError({ statusCode: 409, statusMessage: '校验未通过，请重试解析' })
    }
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { needPow: true, kind: rule.challenge ?? 'cdndefend', c: ch.c, n1: ch.n1, target: [0xb0, 0x0b] }
  }

  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `源站返回 ${page.status}` })
  }

  // 走到这说明页面拿到了：把 cookie 记下来给后续请求复用（实测全站通用）
  if (cookieFromClient) cookieCache.set(host, { cookie: `cdndefend_js_cookie=${cookieFromClient}`, at: Date.now() })

  const html = page.body
  const { lines, activeIndex } = parseLines(html, rule, pageUrl)
  const currentVideoUrl = parseSource(html, rule)

  if (!currentVideoUrl && !lines.length) {
    throw createError({ statusCode: 502, statusMessage: '页面结构不匹配，规则需要更新' })
  }

  // 要解析哪条线路：显式指定 > 页面标记的 active > 第一条
  const targetIndex = Number.isFinite(lineParam as number) && (lineParam as number) >= 0 && (lineParam as number) < lines.length
    ? (lineParam as number)
    : (activeIndex >= 0 ? activeIndex : 0)

  const target = lines[targetIndex]
  let truncated = 0
  let lineUnsupported = false

  if (target?.episodes.length) {
    const cookieForEpisodes = cookie ?? readCookie(host)

    const resolveOne = async (ep: ParsedEpisode) => {
      // 传入的那一集已经解析过了，不重复请求
      if (ep.pageUrl === pageUrl && currentVideoUrl) {
        ep.videoUrl = currentVideoUrl
        return
      }
      try {
        const sub = await fetchPage(ep.pageUrl, cookieForEpisodes)
        if (isChallenge(sub.body)) { ep.error = '需要重新校验'; return }
        const src = parseSource(sub.body, rule)
        if (src) ep.videoUrl = src
        else ep.error = '该线路未给出直链'
      } catch (e) {
        // 单集失败不影响整体：标记后继续
        ep.error = (e as Error).message || '请求失败'
      }
    }

    let todo = target.episodes
    if (todo.length > MAX_EPISODES) {
      truncated = todo.length - MAX_EPISODES
      todo = todo.slice(0, MAX_EPISODES)
      console.log(`[resolve] ${host} 选集 ${target.episodes.length} 集超过上限，本次只解析前 ${MAX_EPISODES} 集`)
    }

    // 有些线路（如「4K」）的页面把 playSource.src 渲染成空串，地址由前端运行时另取，
    // 服务端拿不到。这类线路整条都取不到，先探第一集，不行就立刻收工——
    // 否则要白白等完剩下几十集的请求才知道结果是空的。
    await resolveOne(todo[0])
    if (!todo[0].videoUrl) {
      lineUnsupported = true
      for (let i = 1; i < todo.length; i++) todo[i].error = '该线路未给出直链'
      console.log(`[resolve] ${host} 线路「${target.name}」不提供直链，跳过其余 ${todo.length - 1} 集`)
    } else {
      await pool(todo.slice(1), EPISODE_CONCURRENCY, resolveOne)
    }
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    title: parseTitle(html),
    pageUrl,
    currentVideoUrl,
    lines,
    activeLineIndex: targetIndex,
    truncated: truncated || undefined,
    lineUnsupported: lineUnsupported || undefined,
    referer: rule.referer,
  }
})
