/**
 * fangpi.net（放屁音乐网）协议层的纯函数：请求怎么拼、页面怎么抠。
 *
 * 放在 `utils/` 是因为**前后端都要 import**：服务端 `server/api/music/fangpi/*.ts`
 * 用它构造转发给 fangpi.net 的请求、解析抓回来的 HTML；浏览器这边在本机中继可用时
 * （见 `composables/musicSites/localRelay.ts`）绕开 Workers 直连 fangpi.net，用的是
 * **同一份**拼请求/抠页面逻辑（同 `music24bitProtocol.ts` 的分工）。
 *
 * 这个站没有任何 JSON 搜索接口可用（`/api/guess-musics` 是只回 6 条的自动补全），
 * 所以搜索/取址都是抓 HTML 页面自己抠，不是调接口。
 */

export const BASE_FANGPI = 'https://www.fangpi.net'

export function buildFangpiSearchUrl(kw: string): string {
  return `${BASE_FANGPI}/s/${encodeURIComponent(kw)}`
}

export function buildFangpiDetailUrl(id: string): string {
  return `${BASE_FANGPI}/music/${id}`
}

export const PLAY_URL_ENDPOINT_FANGPI = `${BASE_FANGPI}/member/common-play-url`

/** 详情页 `window.appData` 里我们会用到的字段。其余的（广告位、网盘分享链）一律不碰 */
export interface FangpiAppData {
  mp3_id?: number
  /**
   * 取址令牌，`POST /member/common-play-url` 的唯一入参。
   *
   * 是 Laravel `encrypt()` 的产物（随机 IV + HMAC），**我们生成不了**，只能从页面里拿 ——
   * 所以取址必然是两跳（详情页 + POST），没有捷径。
   *
   * 好消息是它的**明文是稳定的**：实测同一个 `play_id` 连调两次拿到**完全相同**的地址，
   * 换一次页面刷新拿到的密文不同（随机 IV）但地址还是同一条。所以地址值得缓存。
   */
  play_id?: string
  mp3_title?: string
  mp3_author?: string
  mp3_cover?: string
  /** `03:35` 这种可读时长。站点少见地把它给了，正好补上 `Track.duration` */
  mp3_duration?: string
  /**
   * 有没有歌词。**必须认这个标志，不能只看 `#content-lrc` 有没有内容** ——
   * 没歌词时那个容器里躺着一行「该歌曲暂无歌词」，看着像有词。详见 parseInlineLrc。
   */
  lrc_is_empty?: boolean
}

/** 搜索结果的一条。这个站不给专辑，也不给时长（时长要到详情页才有） */
export interface FangpiRow {
  id: string
  name: string
  artist: string
}

/**
 * 解 HTML 实体。只覆盖歌名/歌手/歌词里真会出现的那几个 ——
 * 引一个完整的实体表纯属浪费，这些文本里不会有 `&copy;` 之类的东西。
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // `&amp;` 必须最后解，否则 `&amp;lt;` 会被两步解成 `<`
    .replace(/&amp;/g, '&')
}

/**
 * 抠出 `window.appData`。
 *
 * 页面里长这样（注意是**单引号 JS 字符串**里套一份 JSON，引号全被写成 `"`）：
 *   `window.appData = JSON.parse('{"mp3_id":9618,"play_id":"eyJ…",…}')`
 *
 * 所以要解**两层**：先把 JS 字符串字面量解出来（借 `JSON.parse` 一个双引号串来干这活，
 * 因为里面的 `"` 全是 `"`、不会提前收尾），再 `JSON.parse` 那份 JSON。
 * 只解一层拿到的是带 `"` 的原文，`JSON.parse` 会当场抛。
 */
export function parseAppData(html: string): FangpiAppData | null {
  const m = html.match(/window\.appData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/)
  if (!m) return null
  try {
    return JSON.parse(JSON.parse(`"${m[1]}"`)) as FangpiAppData
  } catch {
    return null
  }
}

/**
 * 抠搜索结果。
 *
 * 认的是 `<a href="/music/<id>" … title="歌名 - 歌手">`。**不去认那两个 `<span>`**
 * （歌名和歌手确实各在一个 span 里，但只能靠 `text-primary` / `text-jade` 这类
 * 排版 class 定位，而排版比 `title` 更容易被改）。
 *
 * **每行有两个 `<a>` 带同一个 title**（歌名那个 + 右侧「播放&下载」按钮），所以必须按 id 去重：
 * 不去重的话 33 首会变成 66 条，界面上每首都出现两遍。
 */
export function parseSearchRows(html: string): FangpiRow[] {
  const out: FangpiRow[] = []
  const seen = new Set<string>()

  const re = /<a\s+href="\/music\/(\d+)"[^>]*\stitle="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const id = m[1]
    if (seen.has(id)) continue

    const title = decodeEntities(m[2]).trim()
    if (!title) continue

    /*
     * 按**最后**一个 ` - ` 切，不是第一个：歌名里带 ` - ` 比歌手里带要常见得多
     * （「Love - Remix - 周杰伦」按第一个切会得到歌手「Remix - 周杰伦」）。
     * 切不出来就整串当歌名 —— 宁可少一个歌手，也别把歌名截半。
     */
    const at = title.lastIndexOf(' - ')
    const name = at > 0 ? title.slice(0, at).trim() : title
    const artist = at > 0 ? title.slice(at + 3).trim() : ''
    if (!name) continue

    seen.add(id)
    out.push({ id, name, artist })
  }

  return out
}

/** 站点自报的总数（`共33首`）。只用来给界面显示，拿不到就算了 */
export function parseTotal(html: string): number | undefined {
  const m = html.match(/共\s*(\d+)\s*首/)
  return m ? Number(m[1]) : undefined
}

/**
 * 抠内嵌歌词。**这个站的歌词就在详情页里，不用另发请求** —— 比 24bit 强的地方
 * （那边两个源都不给词，只能去网易云按歌名歌手现查，还常常匹配到翻唱版）。
 *
 * ⚠️ **没有歌词时容器并不是空的**，里面是这么一份「占位歌词」：
 *   `[ti:青花瓷]` `[ar:周杰伦]` `[al:青花瓷-周杰伦]` `[00:00.00]该歌曲暂无歌词`
 * 它有四行、几十个字符，任何「够长就算有词」的判断都会被它骗过去。
 * 而一旦把它当成歌词交出去，前端 `useMusicLyrics` 的第 ② 步就会认下它、
 * **跳过第 ③ 步的在线查询** —— 用户看到的是一行「该歌曲暂无歌词」，
 * 而那首歌其实在网易云那边有完整的词。
 *
 * 所以判据交给调用方的 `appData.lrc_is_empty`（站点自己的标志，最可信），
 * 这里只负责把文本取干净。
 */
export function parseInlineLrc(html: string): string {
  const m = html.match(/id="content-lrc"[^>]*>([\s\S]*?)<\/div>/)
  if (!m) return ''

  return decodeEntities(
    m[1]
      .replace(/<br\s*\/?>/gi, '\n')
      // 容器里理论上只有文本和 <br>，但站点加个 <span> 包裹是很常见的改动，先剥干净
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map(l => l.trim())
    // `<br />` 后面还跟着真换行，直接切会得到一半空行
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * `03:35` / `1:02:03` → 秒。
 *
 * 值得要是因为**站点在别处都不给时长**：搜索结果没有，`<audio>` 也要等
 * `loadedmetadata` 才知道 —— 而那意味着得先下几十 KB。这里白捡一个。
 */
export function parseDuration(text?: string): number | undefined {
  if (!text) return undefined
  const parts = text.trim().split(':').map(Number)
  if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return undefined
  // 从右往左按 秒/分/时 加权，这样 `03:35` 和 `1:02:03` 用同一段代码
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0)
  return secs > 0 ? secs : undefined
}

/**
 * 从地址里读码率当音质标注。
 *
 * **不编规格参数**：站点自己压根不报音质，凭空写一个「无损」出来而文件其实是 128K MP3，
 * 比什么都不写更糟。这里读的是地址上真实带着的 `bitrate$128`（是 `$` 不是 `=`，站点就这么写的）。
 */
export function qualityOfFangpi(url: string): string {
  const m = url.match(/bitrate\$(\d+)/)
  return m ? `MP3 ${m[1]}K` : 'MP3'
}

/**
 * 封面升到 https。
 *
 * 站点给的是 `http://img3.kuwo.cn/…`，而我们的页面是 https ——
 * 浏览器对这种**混合内容**的图片会先尝试自动升级、升不动就直接拦掉。
 * 实测这个图床 https 完全正常，所以直接换掉。只动 `http:` 前缀，别的形状原样放过。
 */
export function toHttpsFangpi(url?: string): string | undefined {
  return url?.startsWith('http://') ? `https://${url.slice(7)}` : url
}

/** `POST /member/common-play-url` 的请求体：唯一入参就是详情页里的取址令牌 */
export function buildPlayUrlBody(playId: string): string {
  return new URLSearchParams({ id: playId }).toString()
}

export interface PlayUrlResult {
  url?: string
  code?: number
  msg?: string
}

/** 解析取址接口的响应体。解析失败一律当「没给地址」处理，不抛错 */
export function parsePlayUrlBody(body: string): PlayUrlResult {
  let json: { code?: number; data?: { url?: string }; msg?: string } | null = null
  try { json = JSON.parse(body) } catch { /* 按「没给地址」处理 */ }
  return { url: json?.data?.url, code: json?.code, msg: json?.msg }
}

/** 取址结果的最终形状（跟 `ResolvedTrack` 对应，这里不直接 import 避免循环依赖） */
export function toFangpiResolvedPayload(url: string, app: FangpiAppData, pageHtml: string) {
  return {
    url,
    // **必须显式给 `mp3`**：CDN 的 content-type 会谎报，下载扩展名只信这个字段
    format: 'mp3',
    quality: qualityOfFangpi(url),
    cover: toHttpsFangpi(app.mp3_cover),
    duration: parseDuration(app.mp3_duration),
    // 只有站点说有词的时候才给词，理由见 parseInlineLrc 的长注释
    lrc: app.lrc_is_empty === false ? parseInlineLrc(pageHtml) : undefined,
    name: app.mp3_title,
    artist: app.mp3_author,
  }
}
