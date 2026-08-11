/**
 * 数据驱动的搜索结果抽取：与 htmlRule.ts 同一个思路，只是抠的是「搜索结果卡片」。
 *
 * 规则表在 composables/videoSearchRules.ts，接新站/站点改版只改那张表。
 * 这里不认识任何具体站点。
 */
import type { SearchItem, SearchRule } from '../../composables/videoSearchRules'
import { absolutize, decodeEntities } from './utils'

/** 一页最多取多少条：各站首页给 6~20 条，60 是防站点把整库吐出来时把响应撑爆 */
const MAX_ITEMS = 60

/** 在一段 HTML 上跑一条正则取第 1 个捕获组，顺手解实体。规则没配就返回空 */
function pick(block: string, re?: string): string {
  if (!re) return ''
  const m = block.match(new RegExp(re, 'i'))
  return m ? decodeEntities(m[1] ?? '') : ''
}

/** 抠出这一页的全部结果卡片。picBase 是上层现抠出来的图床地址（见 SearchRule.picBase），空则用 baseUrl */
export function extractSearchItems(html: string, rule: SearchRule, baseUrl: string, picBase = ''): SearchItem[] {
  if (!rule.itemRe) return []

  const out: SearchItem[] = []
  for (const m of html.matchAll(new RegExp(rule.itemRe, 'gi'))) {
    // 字段正则跑在整段卡片上（不要求 itemRe 留捕获组，规则表少一层括号更好读）
    const block = m[0]
    const title = pick(block, rule.titleRe)
    const play = pick(block, rule.playRe)
    const detail = pick(block, rule.linkRe)
    // 一条没有落点的卡片是没用的（多半是广告位混进了 itemRe 的匹配范围）
    if (!play && !detail) continue

    const pic = pick(block, rule.picRe)
    out.push({
      title: title || '未命名',
      // 卡片直接给了播放页就用它，省掉「详情页 → 第 1 集」那一跳
      url: absolutize(play || detail, baseUrl),
      detailUrl: detail ? absolutize(detail, baseUrl) : undefined,
      playUrl: play ? absolutize(play, baseUrl) : undefined,
      // 封面的相对地址不一定拼站点域名（见 SearchRule.picBase）
      pic: pic ? absolutize(pic, picBase || baseUrl) : undefined,
      note: pick(block, rule.noteRe) || undefined,
      cat: pick(block, rule.catRe) || undefined,
      info: pick(block, rule.infoRe) || undefined,
    })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

// ── JSON / JSONP 接口（见 SearchRule.json）──
// 有的站点的搜索根本不是页面而是接口（实测 kpkuang 首页那颗搜索框调的就是另一个域名上的
// JSONP 接口，还顺带绕开了它 /vodsearch/ 上的 Cloudflare 规则）。取值同样做成纯声明。

/** 点分路径取值，任一层缺失就返回 undefined */
function dig(obj: any, path?: string): any {
  if (!path) return undefined
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

const str = (v: any) => (v == null || v === '' ? '' : String(v))

/**
 * 解析一发 JSON/JSONP 响应。**成功与否要能分辨**：接口偶发回空载荷（实测 kpkuang），
 * 分不出「真没搜到」和「这一发抽了」的话，界面上就是随机搜不到，所以返回 ok 标志让上层重试。
 */
export function extractJsonItems(
  text: string,
  rule: SearchRule,
  base: string,
  picBase = '',
): { ok: boolean; items: SearchItem[] } {
  const cfg = rule.json!
  // JSONP 外壳：`cb({...})` 或 `cb({...});`。取第一个 ( 到最后一个 ) 之间那段，
  // 不要用「非贪婪到第一个 )」——载荷里到处是括号
  let raw = text.trim()
  if (cfg.jsonp) {
    const l = raw.indexOf('('), r = raw.lastIndexOf(')')
    if (l < 0 || r <= l) return { ok: false, items: [] }
    raw = raw.slice(l + 1, r)
  }

  let root: any
  try { root = JSON.parse(raw) } catch { return { ok: false, items: [] } }

  if (cfg.okPath && !dig(root, cfg.okPath)) return { ok: false, items: [] }

  // 载荷再套一层 base64 的 JSON
  if (cfg.base64Path) {
    const b64 = str(dig(root, cfg.base64Path))
    if (!b64) return { ok: false, items: [] }
    try {
      // atob 只给到 latin1，中文要按 UTF-8 再解一次，否则片名全是乱码
      const bin = atob(b64)
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
      root = JSON.parse(new TextDecoder().decode(bytes))
    } catch { return { ok: false, items: [] } }
  }

  const list = cfg.listPath ? dig(root, cfg.listPath) : root
  if (!Array.isArray(list)) return { ok: false, items: [] }

  const f = cfg.fields
  const items: SearchItem[] = []
  for (const row of list.slice(0, MAX_ITEMS)) {
    const id = str(dig(row, f.id))
    const title = str(dig(row, f.title))
    if (!id || !title) continue
    const pic = str(dig(row, f.pic))
    const detailUrl = cfg.urlTemplate.replace(/%ID%/g, encodeURIComponent(id))
    items.push({
      title,
      url: detailUrl,
      detailUrl,
      pic: pic ? absolutize(pic, picBase || base) : undefined,
      note: str(dig(row, f.note)) || undefined,
      cat: str(dig(row, f.cat)) || undefined,
      info: str(dig(row, f.info)) || undefined,
    })
  }
  // 解出来是空数组也算成功：那就是真没搜到（重试多少次都一样）
  return { ok: true, items }
}

/** 站点自报的总数（「找到 86 部影片」）。抠不到就返回 undefined，界面按「就这些」显示 */
export function extractTotal(html: string, rule: SearchRule): number | undefined {
  if (!rule.totalRe) return undefined
  const n = Number.parseInt(html.match(new RegExp(rule.totalRe, 'i'))?.[1] ?? '', 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 还有没有下一页。判据是「『下一页』链接指向的页码 > 当前页」，不是「有没有那颗按钮」
 * —— MacCMS 的分页条在最后一页照样渲染它、只是指回自己（见 SearchRule.nextPageRe）。
 */
export function hasNextPage(html: string, rule: SearchRule, page: number): boolean {
  if (!rule.pageUrl || !rule.nextPageRe) return false
  const n = Number.parseInt(html.match(new RegExp(rule.nextPageRe, 'i'))?.[1] ?? '', 10)
  return Number.isFinite(n) && n > page
}

/**
 * 认出 Cloudflare 的人机校验。
 *
 * 判据优先看响应头 `cf-mitigated: challenge`（明确、不受页面文案影响），
 * 退而求其次看那句 `Just a moment` + 挑战脚本域名。**不能只按状态码判**：
 * 403 也可能是源站自己的防盗链或封 IP，说成「人机校验」会把用户引到错的方向。
 */
export function isCloudflareChallenge(status: number, body: string, headers?: Headers): boolean {
  if (headers?.get('cf-mitigated') === 'challenge') return true
  if (status !== 403 && status !== 503) return false
  return body.includes('challenges.cloudflare.com') || body.includes('Just a moment')
}
