/**
 * 补一张封面（+ 分类）。给「播放历史 / 收藏影片」里那些没有图的老记录用。
 *
 * 为什么不复用 `/api/resolve`：那条要抠整季选集表、可能过反爬握手、按需取址的站点还会被限流，
 * 而这里只需要页面 `<head>` 里的一行 meta。一次抓页 + 两条正则就够，源站压力和延迟都低一个量级。
 * 也**不做任何站点适配**：抠不到就如实回空，前端保持占位块（见 parseCover 的注释）。
 *
 * 前端是**慢速串行**补齐的（见 useCoverBackfill），所以这里不需要限流；
 * module 级缓存只在同一个 isolate 里有效（CF Pages 上换 isolate 就是空的），
 * 命不中也只是多抓一次，任何逻辑都不许依赖它。
 */
import { findDetailUrl, hostOf, parseCategory, parseCover, patternMatches } from '../parsers/utils'
import { readCookie } from '../parsers/cookieStore'
import { matchParser } from '../parsers'
import { coverFromRule } from '../parsers/htmlRule'
import { BUILTIN_PARSE_RULES } from '../../composables/videoParseRules'
import { fetchSitePage } from '../utils/siteFetch'

const cache = new Map<string, { cover?: string; cat?: string; at: number }>()
const TTL = 6 * 3600 * 1000

export default defineEventHandler(async (event) => {
  const url = (getQuery(event).url as string)?.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 url 参数' })
  }

  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < TTL) return { cover: hit.cover, cat: hit.cat, cached: true }

  const host = hostOf(url)
  const cookie = readCookie(host)
  // 反爬 cookie 有就捎上（解析过这个站的话正好有一份），没有也照抓——
  // 挑战页上抠不到封面，回空即可，绝不在这里发起一轮 PoW（那是解析那条路的事）
  const page = await fetchSitePage(url, cookie)
  if (page.status !== 200) {
    // 页面没了（源站删片、地址过期）、或者回的是反爬挑战页（实测 ncat22 回 850）都算常态，
    // 不是错误：回空让前端把它记成「试过了」。报 502 的话前端会当成网络抖动，下次进来又重试一遍
    return { cover: undefined, cat: undefined, status: page.status }
  }

  /**
   * **200 也可能是挑战页**（有的站不用非标状态码）。拿站点自己的 `challenge.detect` 认一道——
   * 不认的话会把挑战页里的图当成封面存进清单，而那张图看着完全正常（只是跟这部剧毫无关系），
   * 界面上根本看不出错。这里绝不去算 PoW：那要 6.5 万次 SHA1，是解析那条路上前端干的活。
   */
  const parser = matchParser(url, [])
  if (parser?.challenge?.detect(page.body)) return { cover: undefined, cat: undefined, blocked: true }

  let cover = parseCover(page.body, url)
  let cat = parseCategory(page.body)

  // 播放页没有海报就跟一跳去详情页（ncat22 那种）。同 htmlRule 里那段，只是这里是事后补抓
  if (!cover) {
    const detailUrl = findDetailUrl(page.body, url)
    if (detailUrl) {
      try {
        const d = await fetchSitePage(detailUrl, cookie)
        if (d.status === 200 && !parser?.challenge?.detect(d.body)) {
          // 与解析那条路同一套：先 og:image，再退回规则里那条（连 og:image 都不写的站点）
          const rule = BUILTIN_PARSE_RULES.find(r => patternMatches(r.pattern, url, host))
          cover = parseCover(d.body, detailUrl)
            || (rule ? await coverFromRule(d.body, detailUrl, rule, u => fetchSitePage(u, cookie)) : undefined)
          cat = cat || parseCategory(d.body)
        }
      } catch { /* 详情页也抓不到，那就是真没有 */ }
    }
  }

  const out = { cover, cat, at: Date.now() }
  cache.set(url, out)
  return { cover, cat }
})
