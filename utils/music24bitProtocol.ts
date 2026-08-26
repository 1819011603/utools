/**
 * 24bit.net 协议层的纯函数：请求怎么拼、响应怎么解析。
 *
 * 放在 `utils/` 是因为**前后端都要 import**：服务端 `server/api/music/{search,resolve}.ts`
 * 用它构造转发给 24bit.net 的请求、解析回来的响应；浏览器这边在本机中继可用时
 * （见 `composables/musicSites/localRelay.ts`）绕开 Workers 直连 24bit.net，用的是**同一份**
 * 拼请求/解响应逻辑——两处各写一份，站点接口稍微一变就会有一处漏改，静默出错还很难查。
 *
 * 这个文件本身不发请求（`fetch` 由调用方各自决定：服务端用 `musicFetch`，浏览器用中继），
 * 只管「怎么拼」和「怎么解析」，纯函数，两边都能直接 import。
 */

export const BASE_24BIT = 'https://www.24bit.net'

/** 站点只有这两个搜索接口，白名单挡住拼接注入（服务端那边还会再拦一次非法 source） */
export const SEARCH_APIS_24BIT: Record<'one' | 'two', string> = {
  one: 'searchOnlineMusicOne',
  two: 'searchOnlineMusicTwo',
}

export function build24bitSearchUrl(source: 'one' | 'two'): string {
  return `${BASE_24BIT}/api/player/${SEARCH_APIS_24BIT[source]}`
}

/** `keyword` 是双重编码的：站点前端先 encodeURIComponent() 再 JSON.stringify()，照抄它自己的请求 */
export function build24bitSearchBody(kw: string, page: number): string {
  return JSON.stringify({ keyword: encodeURIComponent(kw), page })
}

export interface Search24bitRow {
  id?: string
  name?: string
  player?: string
  album?: string
  cover?: string
}

/**
 * 解析搜索接口的原始响应体。**`ok: false` 和「搜到 0 条」必须分得清**——
 * 前者是接口本身没吐出预期的 `status:true`（响应格式不对/被拦截页顶替），该报错；
 * 后者是正经搜索、这页恰好没有结果，不该报错。两边混成一个「空数组」的话，
 * 调用方没法区分「该不该抛错」，之前就因为这个在服务端和客户端各写了一份不一致的判断。
 */
export function parse24bitSearchBody(body: string): { ok: boolean; rows: Search24bitRow[] } {
  let json: { status?: boolean; result?: Search24bitRow[] } | null = null
  try { json = JSON.parse(body) } catch { /* ok 会是 false，按下面统一处理 */ }
  if (!json?.status) return { ok: false, rows: [] }
  return { ok: true, rows: Array.isArray(json.result) ? json.result : [] }
}

/**
 * 只留我们要用的字段。`cover` 故意**不透传**：实测它是 segmentfault 图床的占位图，
 * 同一次搜索里所有条目完全相同，摆到界面上只会让整页看起来像同一首歌。
 * 真封面只有详情页的 `itemMusic.cover` 有，取址成功后会回填。
 */
export function toSearch24bitItems(rows: Search24bitRow[]) {
  return rows
    .filter(r => r.id && r.name)
    .map(r => ({ id: r.id!, name: r.name!, player: r.player ?? '', album: r.album ?? '' }))
}

/** 详情页地址：`prefix` 是两个音源（b=酷我/无损，c=网易云/高清环绕声） */
export function build24bitDetailUrl(prefix: 'b' | 'c', id: string): string {
  return `${BASE_24BIT}/music/${prefix}/${id}`
}

/** 站点自报的字段。`url` 之外都是元数据，缺了不影响播放 */
export interface ItemMusic24bit {
  id?: string
  url?: string
  size?: string
  quality?: string
  format?: string
  cover?: string
  name?: string
  player?: string
  album?: string
  /** 歌词。**不是所有源都有**：实测酷我那条（`b`）回的是长度 2 的空占位 */
  lrc?: string
}

/**
 * 从详情页 HTML 里切出 itemMusic。
 *
 * 地址内嵌在 Next.js App Router 的 RSC flight data 里，整段被转义了多层（`\\\"`），
 * 所以不能直接 `JSON.parse`，要先**反复规约**到没有 `\"` 为止（层数不固定，写死几层
 * 在站点改一次构建配置后就会静默失效），再按括号配对切出对象范围。
 */
export function extractItemMusic24bit(html: string): ItemMusic24bit | null {
  const at = html.indexOf('itemMusic')
  if (at < 0) return null

  // 2500 字足够覆盖整个对象（实测最长的 url 288 字符，全部字段加起来不到 1KB）
  let seg = html.slice(at, at + 2500)
  let prev = ''
  while (seg !== prev) {
    prev = seg
    seg = seg.split('\\"').join('"')
  }

  const start = seg.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < seg.length; i++) {
    if (seg[i] === '{') depth++
    else if (seg[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null

  try {
    return JSON.parse(seg.slice(start, end + 1)) as ItemMusic24bit
  } catch {
    return null
  }
}

/** `itemMusic` → 播放器认的取址结果形状（`ResolvedTrack`，这里不直接 import 那个类型避免循环依赖） */
export function toResolvedPayload(item: ItemMusic24bit) {
  return {
    url: item.url!,
    format: item.format,
    sizeText: item.size,
    quality: item.quality,
    cover: item.cover,
    lrc: item.lrc,
    name: item.name,
    artist: item.player,
    album: item.album,
  }
}

/** 认出「今日访问已达限额」。判据用中文原文而不是状态码/路径，这句话只在配额耗尽时才有 */
export function isQuotaExhausted24bit(body: string): boolean {
  return body.includes('今日访问已达限额')
}
