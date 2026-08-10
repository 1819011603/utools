/**
 * 探测结论的跨页/跨标签存储。两件事，都为了「别重复等已经知道答案的东西」：
 *
 *  1. `saveProbe/loadProbe`：按**完整 URL**存近期结论。解析页的「可达性检测」刚测过的那条地址，
 *     点播放后播放器会在新标签页里再整轮测一遍（`warmProbes` 是播放器实例内的 Map，跨不过去）。
 *  2. `markDirectDead/isDirectDead`：按 host 记「直连是黑洞」，让分片轴不再为它付优先级预算。
 *
 * **和那条老坑的区别（很重要）**：CLAUDE.md 里禁的是「按 host 缓存可达性**结论**」——
 * 按需取址的站点每集都是现签的地址，上一集测出的「直连可达」对这一集就是 403，
 * 表现是「切一集就播不了」（反复踩过）。这里守住两条底线：
 *   · 结论一律按**完整 URL**存（签名一换 URL 就变、自然 miss），不按 host；
 *   · 按 host 存的只有**负面记忆**，而且只影响「等多久」，不影响「用哪条」——
 *     每次仍然真发直连探测，它哪天通了就立刻清掉记忆，自愈。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import type { ProbeResult } from './useReachabilityProbe'

const PROBE_KEY = 'video-probe-cache'
const DEAD_DIRECT_KEY = 'video-probe-dead-direct'

/** 结论存活 90s。与播放器内存里的 warmProbes 同规格——它就是那份缓存的跨页版本 */
const PROBE_TTL = 90_000
/** 条数上限：够覆盖「解析页测的那条 + 上一集/当前/下一集」，又不至于攒一堆过期结论 */
const PROBE_MAX = 8
/** 「直连是黑洞」的记忆存活 30 分钟。网络环境（开关代理/换 Wi-Fi）通常在这个尺度上变 */
const DEAD_TTL = 30 * 60_000
const DEAD_MAX = 32

type Stored = { at: number; r: ProbeResult }

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
 * 存一份结论。**`manifestText` 会被剥掉**：它是给 pLoader 省一个 RTT 用的 m3u8 原文，
 * 长剧的清单动辄上百 KB，几条就能把 localStorage 的配额撑爆（写失败是静默的，
 * 到时候整个缓存都不工作，比不缓存更难查）。省 RTT 那点收益不值这个风险。
 */
export function saveProbe(url: string, r: ProbeResult) {
  if (!url || typeof localStorage === 'undefined') return
  const { manifestText: _drop, ...lean } = r
  const map = readJson<Stored>(PROBE_KEY)
  delete map[url]                                  // 重新插到队尾，维持 LRU 顺序
  map[url] = { at: Date.now(), r: lean as ProbeResult }
  writeJson(PROBE_KEY, trim(map, PROBE_MAX))
}

/** 取一份还没过期的结论（**按完整 URL 严格匹配**）。取用即删：结论用一次就该重新实测 */
export function loadProbe(url: string): ProbeResult | null {
  if (!url || typeof localStorage === 'undefined') return null
  const map = readJson<Stored>(PROBE_KEY)
  const hit = map[url]
  if (!hit) return null
  delete map[url]
  writeJson(PROBE_KEY, map)
  return Date.now() - hit.at < PROBE_TTL ? hit.r : null
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
