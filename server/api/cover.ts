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
import { hostOf, parseCategory, parseCover } from '../parsers/utils'
import { readCookie } from '../parsers/cookieStore'
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

  // 反爬 cookie 有就捎上（解析过这个站的话正好有一份），没有也照抓——
  // 挑战页上抠不到封面，回空即可，绝不在这里发起一轮 PoW（那是解析那条路的事）
  const page = await fetchSitePage(url, readCookie(hostOf(url)))
  if (page.status !== 200) {
    // 页面没了（源站删片、地址过期）是常态，不是错误：回空让前端把它记成「试过了」，
    // 报 502 的话前端那边会当成网络抖动，下次进来又重试一遍
    return { cover: undefined, cat: undefined, status: page.status }
  }

  const out = { cover: parseCover(page.body, url), cat: parseCategory(page.body), at: Date.now() }
  cache.set(url, out)
  return { cover: out.cover, cat: out.cat }
})
