/**
 * 各站点策略共用的小工具。放这里是为了接新站时能直接拿来用，
 * 不要在单个站点的 .ts 里重复实现（尤其是实体解码和标题清洗，漏一个就是脏数据）。
 */

export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

export function absolutize(href: string, base: string): string {
  try { return new URL(href, base).href } catch { return href }
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * 剥掉所有标签只留文本。
 *
 * 注意：只对「确定不含标签的片段」用它。现代前端框架的属性里常有 `=>`、`>` 这类字符
 * （x-effect="…() => …"），`<[^>]*>` 会在属性中间断开，把剩下的属性当成正文吐出来。
 * 要从一段含开标签的 HTML 里取可见文字，用 innerTexts 定位到具体标签再剥。
 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '))
}

/** 按出现顺序取出某个标签的全部内层文本（已剥内层标签、已解实体、已去空） */
export function innerTexts(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  return [...html.matchAll(re)].map(m => stripTags(m[1])).filter(Boolean)
}

/**
 * 取影片名。站点标题普遍是「片名 - 第N集 - 站名」这类拼接，
 * 站名后缀统一削一刀，其余各站不同的尾巴由 strips 传进来。
 */
export function parseTitle(html: string, strips: RegExp[] = []): string | undefined {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  if (!m) return undefined
  let t = decodeEntities(m[1]).replace(/[-|_–]\s*[^-|_–]{1,12}$/, '').trim()
  for (const re of strips) t = t.replace(re, '').trim()
  return t || undefined
}

/**
 * 苹果 CMS（`player_aaaa`）系站点的播放地址解码。
 *
 * 站点按 `encrypt` 字段给三种形态：0=明文、1=percent、2=base64 套 percent。
 * 这里**不读 encrypt**，而是「不是 http 开头就再剥一层」——同一站点不同线路的 encrypt
 * 可以不同（实测 ylsp=0、netflixgc=2），按字段分支会在换线路时漏解。
 *
 * 层数硬性封在 2 层：地址本身常带 percent 编码的签名参数，无限循环解码会把它越解越坏。
 */
export function decodeMaccmsUrl(raw: string): string {
  // JSON 里的 `\/` 转义先还原，否则明文地址也过不了下面的 http 判定
  let s = (raw || '').trim().replace(/\\\//g, '/')
  if (!s) return s

  for (let i = 0; i < 2 && !/^(https?:|\/\/)/i.test(s); i++) {
    let next = ''
    try {
      // 纯 base64 字母表才当 base64 解；percent 串含 `%`，天然落到另一条分支
      next = /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? atob(s) : decodeURIComponent(s)
    } catch {
      break   // 解不动就交回原值，让上层按「取不到地址」处理，别吐半截脏串
    }
    if (!next || next === s) break
    s = next
  }
  return s
}

/** pattern 与 URL 是否匹配。`/xxx/` 视为正则（匹配整个 URL），否则按 host 子串。 */
export function patternMatches(pattern: string, url: string, host: string): boolean {
  if (!pattern) return false
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try { return new RegExp(pattern.slice(1, -1), 'i').test(url) } catch { return false }
  }
  return host.includes(pattern)
}

/** 固定并发的任务池（不引第三方依赖） */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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
