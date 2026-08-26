/**
 * fangpi.net 搜索：抓搜索页 HTML，抠出曲目行。
 *
 * ## 为什么是抓 HTML 而不是调接口
 *
 * 这个站没有可用的 JSON 搜索接口。看着像的那个 `/api/guess-musics` 是**自动补全**：
 * 只回 6 条，而且把歌名和歌手拼成一个 `keyword` 字符串（「告白气球 周杰伦」）。
 * 搜索页 `/s/<kw>` 一次就给全（实测「周杰伦」33 条），行里还有干净的
 * `title="歌名 - 歌手"`，所以走这条。
 *
 * ## 为什么必须走服务端
 *
 * 整站在 Cloudflare 后面，响应没有 `ACAO`，浏览器跨域拿不到。
 * 而且 **CF 会按客户端指纹拦人**：实测 Node 的 `fetch`（undici）和 curl 都能过，
 * Python urllib 恒 403 —— 我们这条链正好是前者，能过。
 *
 * ## 这个站没有分页
 *
 * `?page=2` 回的还是第一页原文（实测两页字节数与首条 id 完全一致），所以这里
 * **不收 `page` 参数**，前端那边也把 `pageSize` 标成 0、不画「加载更多」。
 * 收一个永远不起作用的参数，比不收更容易让人以为翻页坏了。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { buildFangpiSearchUrl, parseSearchRows, parseTotal } from '~/utils/musicFangpiProtocol'
import { cfWallMessage, isCloudflareWall, musicFetch } from '../../../utils/musicFetch'

export default defineEventHandler(async (event) => {
  const kw = (getQuery(event).kw as string)?.trim()
  if (!kw) throw createError({ statusCode: 400, statusMessage: '缺少 kw 参数' })

  const res = await musicFetch(buildFangpiSearchUrl(kw), {
    headers: {
      // 照浏览器发，别给 CF 多一个判我们是脚本的理由
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://www.fangpi.net/',
    },
  })

  /*
   * 撞 CF 墙时说人话。本地开发下这几乎总是「dev server 带了 HTTPS_PROXY」——
   * 实测这个站直连 200、经代理恒 403（`Just a moment`）。
   * `musicFetch` 已经会在撞墙后自动退一次直连，所以走到这里说明两条路都没成。
   */
  if (isCloudflareWall(res.status, res.body)) {
    throw createError({ statusCode: 502, statusMessage: cfWallMessage('放屁音乐网') })
  }
  if (res.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `搜索页返回 ${res.status}` })
  }

  const rows = parseSearchRows(res.body)

  // 搜索结果不缓存：理由同 24bit 那边 —— 缓存只会让「刚搜到的东西点不开」更难归因
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return {
    /** 站点自报的总数。抠到的条数正常应该与它相等，不等就是解析规则该修了 */
    total: parseTotal(res.body),
    /*
     * 字段名 `player` 是**沿用 24bit 那边的叫法**（它的接口字段就是这个），
     * 好让前端 `MusicSearchRow` 一份形状同时装两个站的结果 ——
     * 同一个东西两套名字，迟早在某个组件里漂移。
     */
    items: rows.map(r => ({ id: r.id, name: r.name, player: r.artist })),
  }
})
