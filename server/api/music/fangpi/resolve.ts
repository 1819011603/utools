/**
 * fangpi.net 取址：详情页 → 取址令牌 → 播放地址。
 *
 * ## 为什么是两跳，绕不开
 *
 *   ① `GET /music/<id>`                 → `window.appData.play_id`
 *   ② `POST /member/common-play-url`    → `{code:1,data:{url}}`
 *
 * `play_id` 是 Laravel `encrypt()` 的产物（随机 IV + HMAC 签名），**我们生成不了**，
 * 只能从页面里拿。所以哪怕手上已经有 `mp3_id`，也必须先抓一次详情页。
 *
 * 顺路的收获让这一跳不算白花：封面、时长（`03:35`）、**内嵌歌词**都在同一份 HTML 里 ——
 * 尤其歌词，24bit 那两个源一个都不给，只能去网易云按歌名歌手现查（还常匹配到翻唱版）。
 *
 * ## 地址值得缓存，而且缓存很划算
 *
 * 实测同一个 `play_id` 连调两次拿到**完全相同**的地址（明文稳定，只有密文因随机 IV 而变），
 * 而且那条地址在它路径里那个 hex 时间戳过去 23 分钟之后仍然正常回 206 ——
 * 也就是说它不像 24bit 那样 20 分钟就死。命中缓存能同时省掉上面两跳。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { parseAppData, parseDuration, parseInlineLrc } from '../../../utils/fangpi'
import { CF_WALL_MESSAGE, isCloudflareWall, musicFetch } from '../../../utils/musicFetch'
import { readUrlCache, writeUrlCache } from '../../../utils/musicUrlCache'

const BASE = 'https://www.fangpi.net'

/** 缓存命名空间。与 24bit 的 `b`/`c` 同处一张表，键是 `<prefix>:<id>`，不能撞 */
const CACHE_PREFIX = 'fangpi'

/**
 * 从地址里读码率当音质标注。
 *
 * **不编规格参数**：站点自己压根不报音质，凭空写一个「无损」出来而文件其实是 128K MP3，
 * 比什么都不写更糟。这里读的是地址上真实带着的 `bitrate$128`（是 `$` 不是 `=`，站点就这么写的）。
 */
function qualityOf(url: string): string {
  const m = url.match(/bitrate\$(\d+)/)
  return m ? `MP3 ${m[1]}K` : 'MP3'
}

/**
 * 封面升到 https。
 *
 * 站点给的是 `http://img3.kuwo.cn/…`，而我们的页面是 https ——
 * 浏览器对这种**混合内容**的图片会先尝试自动升级、升不动就直接拦掉。
 * 拦掉倒不至于坏事（`CoverArt.vue` 会 onerror 退到 `/api/thumb`），
 * 但那等于让**每一张**封面都白绕我们的服务器一趟。
 *
 * 实测这个图床 https 完全正常（同一张图 200 / image/jpeg / 字节数一致），所以直接换掉。
 * 只动 `http:` 前缀，别的形状（协议相对、已经是 https）原样放过。
 */
function toHttps(url?: string): string | undefined {
  return url?.startsWith('http://') ? `https://${url.slice(7)}` : url
}

export default defineEventHandler(async (event) => {
  const id = (getQuery(event).id as string)?.trim()
  // 这个站的 id 是纯数字自增（1720 / 11561889 / 34006802），挡住拼接注入
  if (!id || !/^\d{1,12}$/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 id' })
  }

  const cached = readUrlCache(id, CACHE_PREFIX)
  if (cached) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { ...cached, cached: true }
  }

  // ── ① 详情页 ──
  const pageUrl = `${BASE}/music/${id}`
  const page = await musicFetch(pageUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${BASE}/`,
    },
  })

  // 撞 CF 墙：本地开发下几乎总是 dev server 带了 HTTPS_PROXY（这个站经代理恒 403）
  if (isCloudflareWall(page.status, page.body)) {
    throw createError({ statusCode: 502, statusMessage: CF_WALL_MESSAGE })
  }
  if (page.status === 404) {
    throw createError({ statusCode: 404, statusMessage: '这个站点上没有这首歌' })
  }
  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `详情页返回 ${page.status}` })
  }

  const app = parseAppData(page.body)
  /*
   * 页面拿到了却没有令牌 → 这是**我们的解析该修了**，不是「这首没资源」。
   * 两者说法必须分开：报成「没资源」会让人去换歌试，而真正该做的是来看这个正则。
   */
  if (!app?.play_id) {
    throw createError({ statusCode: 502, statusMessage: '详情页里没有取址令牌，站点可能改版了' })
  }

  // ── ② 换地址 ──
  const play = await musicFetch(`${BASE}/member/common-play-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      // 这三个头是照站点自己那一发抄的。实测不带也能成，但带上更稳（WAF 常拿它们做一致性检查）
      'Origin': BASE,
      'Referer': pageUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ id: app.play_id }).toString(),
  })

  if (play.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `取址接口返回 ${play.status}` })
  }

  let json: { code?: number; data?: { url?: string }; msg?: string } | null = null
  try { json = JSON.parse(play.body) } catch { /* 下面统一按「没给地址」处理 */ }

  const url = json?.data?.url
  if (json?.code !== 1 || !url) {
    // 站点自己的 msg 比我们编的话准，有就用它
    throw createError({
      statusCode: 404,
      statusMessage: json?.msg?.trim() || '这首歌取不到播放地址',
    })
  }

  const payload = {
    url,
    /*
     * **必须显式给 `mp3`**：CDN 的 `content-type` 会谎报（见 display.ts 的 buildFileName），
     * 下载时的扩展名只信这个字段。不给的话存下来是个没有扩展名的文件。
     */
    format: 'mp3',
    quality: qualityOf(url),
    cover: toHttps(app.mp3_cover),
    duration: parseDuration(app.mp3_duration),
    /*
     * ⚠️ **只有站点说有词的时候才给词。**
     *
     * 没词时 `#content-lrc` 里并不是空的，而是一份占位：
     *   `[ti:…]` `[ar:…]` `[al:…]` `[00:00.00]该歌曲暂无歌词`
     * 它足够长，会被前端 `useMusicLyrics` 的第 ② 步（曲目自带歌词）当真收下，
     * 于是**第 ③ 步的网易云在线查询被整个跳过** —— 用户盯着一行「该歌曲暂无歌词」，
     * 而那首歌在网易云那边其实有完整的词。宁可这里交白卷，让在线查询去试。
     */
    lrc: app.lrc_is_empty === false ? parseInlineLrc(page.body) : undefined,
    /*
     * `name`/`artist` 只是参考值，**前端不会拿它覆盖搜索结果里那一条**
     * （理由见 musicPlayer/types.ts 的 ResolvedTrack 注释）。带回来是为了排查时能对账。
     */
    name: app.mp3_title,
    artist: app.mp3_author,
  }

  writeUrlCache(id, CACHE_PREFIX, payload)

  // 地址本身有时效，**绝不能被 HTTP 层缓存**：那一层不认识它什么时候作废
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return { ...payload, cached: false }
})
