/**
 * 拼音搜中文：输入 `xianni` 或 `xn` 都能搜到《仙逆》。
 *
 * 字典 40 多 KB，**只在用户真的敲了纯字母时才动态 import**（同「重依赖动态 import」那条）：
 * 绝大多数搜索是直接打中文的，为它们白背一份字典不值当。加载是一次性的，
 * 加载完 `ready` 变真，调用方的 computed 会自己重算一遍 —— 表现是「敲下第一个字母，
 * 结果晚一拍出来」，比先加载再让人等着强。
 *
 * 索引按**字符串**缓存（不是按记录），所以片名、分类、线路名共用同一份缓存，
 * 「动漫」这种到处都是的词只算一次。
 */
type PinyinIndex = { full: string; initials: string }

let mod: { pinyin: (s: string, opts: any) => string[] } | null = null
let loading: Promise<void> | null = null
const cache = new Map<string, PinyinIndex>()

/** 纯 ASCII 字母/数字才当拼音查询处理：夹了中文说明用户就是在打中文，直接子串匹配更准 */
export const isPinyinQuery = (q: string) => !!q && /^[a-z0-9]+$/i.test(q)

export function usePinyinMatch() {
  const ready = ref(!!mod)

  const ensure = async () => {
    if (mod) { ready.value = true; return }
    loading ??= import('pinyin-pro').then((m) => { mod = m as any })
    try {
      await loading
    } catch {
      // 字典没加载出来（离线/CDN 挂了）就退回纯中文匹配，不该让搜索框整个失灵
      loading = null
      return
    }
    ready.value = true
  }

  const indexOf = (text: string): PinyinIndex | null => {
    if (!mod || !text) return null
    const hit = cache.get(text)
    if (hit) return hit
    const full = mod.pinyin(text, { toneType: 'none', type: 'array' }).join('')
    const initials = mod.pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
    const out = { full: full.toLowerCase(), initials: initials.toLowerCase() }
    cache.set(text, out)
    return out
  }

  /** 全拼和首字母都认：「xianni」「xn」「xianN」都能命中《仙逆》 */
  const matches = (text: string, q: string) => {
    const idx = indexOf(text)
    if (!idx) return false
    const needle = q.toLowerCase()
    return idx.full.includes(needle) || idx.initials.includes(needle)
  }

  return { ready, ensure, matches }
}
