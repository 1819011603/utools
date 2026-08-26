/**
 * 媒体库列表的筛选与分组（纯函数，无状态）。
 *
 * 单独成文件是为了让「查看更多」那个大面板只剩版式：它已经背着搜索、筛选、分组、
 * 多选管理四件事，再把这几个算式塞进去就该破 500 行了。
 */
import type { LibraryItem } from './useLibrary'

/** 一天的毫秒数。分组按「本地日期」算，不是按「距今多少小时」——凌晨 1 点看的片属于今天，不是昨天 */
const startOfDay = (ts: number) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 按标题/分类/线路名模糊找。**大小写与空白都归一化**：用户搜「仙逆」不该被标题里的空格挡住。
 *
 * `pinyinMatch` 是可选的第四个参数（拼音字典是动态加载的，没加载好时就是 undefined，
 * 那时退回纯子串匹配）。它按**单个字段**问，而不是拼成一整条 haystack 再问：
 * 拼起来的话「仙逆」+「动漫」会连成 `xiannidongman`，搜 `nid` 这种跨字段的乱码反而能命中。
 */
export function filterLibrary(
  items: LibraryItem[],
  kw: string,
  cat: string,
  pinyinMatch?: (text: string, q: string) => boolean,
): LibraryItem[] {
  const q = kw.trim().replace(/\s+/g, '').toLowerCase()
  return items.filter((r) => {
    if (cat && (r.cat || '') !== cat) return false
    if (!q) return true
    const fields = [r.title, r.cat, (r as any).lineName].filter(Boolean) as string[]
    const hay = [...fields, r.pageUrl].filter(Boolean).join(' ').replace(/\s+/g, '').toLowerCase()
    if (hay.includes(q)) return true
    return !!pinyinMatch && fields.some(f => pinyinMatch(f, q))
  })
}

/** 出现过哪些分类（按出现次数多的排前面）。**不写死一张分类表**：抠不到分类的站点很多，
 *  写死会摆出一排点进去空空如也的按钮 */
export function libraryCategories(items: LibraryItem[]): string[] {
  const count = new Map<string, number>()
  for (const r of items) {
    if (!r.cat) continue
    count.set(r.cat, (count.get(r.cat) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
}

/** 按天分组（今天 / 昨天 / 具体日期）。入参必须已按时间倒序，这里不再排序 */
export function groupByDay(items: LibraryItem[]): { label: string; items: LibraryItem[] }[] {
  const today = startOfDay(Date.now())
  const out: { label: string; items: LibraryItem[] }[] = []
  let lastLabel = ''
  for (const r of items) {
    const at = Number(r.at) || 0
    const day = startOfDay(at)
    const diff = Math.round((today - day) / 86400_000)
    const label = diff <= 0 ? '今天'
      : diff === 1 ? '昨天'
        : new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    if (label !== lastLabel) {
      out.push({ label, items: [] })
      lastLabel = label
    }
    out[out.length - 1].items.push(r)
  }
  return out
}
