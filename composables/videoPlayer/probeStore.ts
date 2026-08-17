/**
 * 「直连是黑洞」的按 host 负面记忆（`markDirectDead/isDirectDead`）：
 * 上次直连超时不返回 → 这次照样发探测，但不给它优先级预算，结论不等它。
 *
 * **和那条老坑的区别（很重要）**：CLAUDE.md 里禁的是「按 host 缓存可达性**结论**」——
 * 按需取址的站点每集都是现签的地址，上一集测出的「直连可达」对这一集就是 403，
 * 表现是「切一集就播不了」（反复踩过）。这里存的只有**负面记忆**，
 * 而且只影响「等多久」，不影响「用哪条」——每次仍然真发直连探测，
 * 它哪天通了就立刻清掉记忆，自愈。
 *
 * **曾经这里还有一份 `saveProbe/loadProbe`**：按完整 URL 把探测结论落进 localStorage，
 * 让解析页「可达性检测」刚测过的那条地址在播放器新标签页里免掉整轮重测（`warmProbes`
 * 是播放器实例内的 Map，跨不过去）。已按需求整块删除——结论一律当场实测，
 * 代价是起播多等一轮探测（自带两级超时：单通道 8s、整轮 12s 硬顶）。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

const DEAD_DIRECT_KEY = 'video-probe-dead-direct'

/** 「直连是黑洞」的记忆存活 30 分钟。网络环境（开关代理/换 Wi-Fi）通常在这个尺度上变 */
const DEAD_TTL = 30 * 60_000
const DEAD_MAX = 32

const readJson = <T>(key: string): Record<string, T> => {
  try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} }
}
const writeJson = (key: string, val: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* 配额满/隐私模式：丢掉就是了 */ }
}

/** 按插入序裁到上限（JS 对象保留字符串键的插入顺序，够做 LRU） */
const trim = <T>(map: Record<string, T>, max: number): Record<string, T> => {
  const keys = Object.keys(map)
  if (keys.length <= max) return map
  const out: Record<string, T> = {}
  for (const k of keys.slice(keys.length - max)) out[k] = map[k]!
  return out
}

/**
 * 记下「这个 host 的直连是黑洞」。只在 `unknown`（超时/压根不返回）时记——
 * `fail`（CORS 拒绝、证书错）是快速失败，本来就不占等待时间，没必要记。
 */
export function markDirectDead(host: string) {
  if (!host || typeof localStorage === 'undefined') return
  const map = readJson<number>(DEAD_DIRECT_KEY)
  delete map[host]
  map[host] = Date.now()
  writeJson(DEAD_DIRECT_KEY, trim(map, DEAD_MAX))
}

/** 直连通了 → 立刻清掉记忆（自愈：开关代理/换网络之后不该继续按黑洞对待） */
export function clearDirectDead(host: string) {
  if (!host || typeof localStorage === 'undefined') return
  const map = readJson<number>(DEAD_DIRECT_KEY)
  if (!(host in map)) return
  delete map[host]
  writeJson(DEAD_DIRECT_KEY, map)
}

export function isDirectDead(host: string): boolean {
  if (!host || typeof localStorage === 'undefined') return false
  const at = readJson<number>(DEAD_DIRECT_KEY)[host]
  return !!at && Date.now() - at < DEAD_TTL
}
