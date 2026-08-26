/**
 * 云同步的合并规则（纯函数，不碰 localStorage、不发请求）。
 *
 * ## 为什么是「合并」而不是「谁最后写谁赢」
 *
 * 手机上收了 3 首、电脑上收了 5 首，整份覆盖的话必然丢掉一边。所以每一份清单都按条目合并：
 * 同一条以**时间较新**的那份为准，两边独有的都留下。
 *
 * ## 为什么必须有墓碑（`tomb`）
 *
 * 只做并集的话删除永远传不出去：A 设备取消收藏 → 下次同步时 B 设备那份里还有它 → 又被推回 A。
 * 表现是「取消收藏之后它自己回来了」，而且**只在多设备时发作**，本机怎么试都是对的。
 * 所以删除要单独记一笔 `{ key: 删除时间 }` 跟着上传，合并时「删除时间 ≥ 条目时间」就丢掉。
 * 条目时间比删除时间新（删掉之后又重新收藏）则保留 —— 这也是为什么比的是时间而不是「存不存在」。
 *
 * `clearedAt` 是「清空」这一个动作的时间戳，语义等同于「给当时所有条目一次性发墓碑」，
 * 但只占一个数字（搜索历史那两份只有清空、没有单条删除，正好合用）。
 *
 * 墓碑要有 TTL 和条数上限，否则它会无限长大；代价是**离线超过 90 天的设备再上线时，
 * 那些过期墓碑对应的条目会复活**。这是有意的取舍：无上限的墓碑最终会比数据本身还大。
 *
 * ## 输出必须是确定性的
 *
 * 「合并结果跟云端那份一样吗」这个判断是靠 `JSON.stringify` 比出来的（`sameJson`），
 * 所以 map 的键要排序输出、list 的排序要有稳定的第二关键字。否则每次同步都会认为「变了」，
 * 于是每 5 分钟白推一次，额度和写入量都是白烧。
 */

/** `{ 条目 key: 删除时间 }` */
export interface Tomb { [key: string]: number }

/** 存进 D1 的一份清单。`items` 的形状就是这份清单在 localStorage 里原本的形状 */
export interface CollPayload {
  v: 1
  items: any
  tomb: Tomb
  clearedAt: number
}

export type SyncKind = 'map' | 'list'

export interface SyncSpec {
  /** 服务端 `user_blobs.coll` 的值，白名单在 `server/utils/syncColls.ts` */
  id: string
  /** 对应的 localStorage 键 */
  lsKey: string
  /** 界面上怎么称呼它 */
  label: string
  kind: SyncKind
  /** 条数上限，与各模块自己的上限保持一致 */
  cap: number
  /** list 用：一条的身份。名字会重、地址会变，这个必须是稳定的键 */
  keyOf?: (item: any) => string
  /** 一条的时间戳，合并的先后与墓碑比对都看它 */
  timeOf: (item: any) => number
  /**
   * 同一个键两边都有时**取本机那条**，不比时间（追剧进度就是这样：`video-watch`）。
   *
   * 理由是「这台设备上我正看着这部剧」比「另一台的时间戳更新」更可信：
   * 本地那条是眼前正在发生的观看，被远端顶掉的话续看提示会当场跳到另一台的集数上。
   * **不同的剧不受影响**——那是不同的键，照旧取并集，两边的剧都留着。
   *
   * 代价要认：同一部剧上「谁最后同步谁赢」，而不是「谁看得晚谁赢」。
   * 在 A 上追到 20 集、B 上只打开过第 3 集的话，B 同步之后云端就是第 3 集。
   */
  preferLocal?: boolean
  /** 合并结果落盘后额外要做的事（刷新那些持在模块级 ref 里的状态） */
  onApplied?: () => void
}

const TOMB_TTL_MS = 90 * 24 * 3600_000
const TOMB_CAP = 200

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 键排序后再 `Object.fromEntries`：JSON.stringify 的结果跟键的插入顺序有关 */
const byKeyAsc = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function emptyItems(kind: SyncKind): any {
  return kind === 'map' ? {} : []
}

export function isEmptyItems(kind: SyncKind, items: any): boolean {
  return kind === 'map' ? Object.keys(items ?? {}).length === 0 : !(items?.length)
}

/**
 * 解析云端那份 payload。**任何一步不对都退回空**而不是抛异常：
 * 一份坏掉的存档不该让整个同步（以及其余四份清单）停摆。
 */
export function parsePayload(raw: string | null | undefined, kind: SyncKind): CollPayload {
  const empty = (): CollPayload => ({ v: 1, items: emptyItems(kind), tomb: {}, clearedAt: 0 })
  if (!raw) return empty()
  try {
    const p = JSON.parse(raw)
    if (!isObj(p)) return empty()
    const items = kind === 'map'
      ? (isObj(p.items) ? p.items : {})
      : (Array.isArray(p.items) ? p.items : [])
    return {
      v: 1,
      items,
      tomb: isObj(p.tomb) ? p.tomb as Tomb : {},
      clearedAt: Number(p.clearedAt) || 0,
    }
  } catch { return empty() }
}

export function mergeTomb(a: Tomb, b: Tomb, now: number): Tomb {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  const rows: Array<[string, number]> = []
  for (const k of keys) {
    const t = Math.max(Number(a?.[k]) || 0, Number(b?.[k]) || 0)
    if (!t || now - t > TOMB_TTL_MS) continue
    rows.push([k, t])
  }
  // 超量按最旧的丢：留着的应该是最近的删除，那些才可能还没传到别的设备上
  rows.sort((x, y) => y[1] - x[1])
  return Object.fromEntries(rows.slice(0, TOMB_CAP).sort(byKeyAsc))
}

/**
 * 时间相同时**偏向字段更全的那条**。
 *
 * 这不是洁癖：音乐收藏的 `refreshMeta` 是「播到哪首就把封面补进已收藏的那条」，
 * 补的时候**故意不动 `at`**（那是补数据不是重新收藏）。所以同一首会出现两个 `at` 相同、
 * 一个有封面一个没有的版本 —— 单看时间会把有封面的那条盖成空的，
 * 表现是「收藏列表里的封面时有时无」。
 */
function richness(o: any): number {
  if (!isObj(o)) return 0
  let n = 0
  for (const v of Object.values(o)) if (v !== undefined && v !== null && v !== '') n++
  return n
}

function pickNewer(spec: SyncSpec, a: any, b: any): any {
  const ta = spec.timeOf(a) || 0
  const tb = spec.timeOf(b) || 0
  if (ta !== tb) return ta > tb ? a : b
  return richness(b) > richness(a) ? b : a
}

function mergeMap(spec: SyncSpec, local: any, cloud: any, tomb: Tomb, clearedAt: number) {
  const l = isObj(local) ? local : {}
  const c = isObj(cloud) ? cloud : {}
  const rows: Array<[string, any]> = []
  for (const k of new Set([...Object.keys(l), ...Object.keys(c)])) {
    const a = l[k]
    const b = c[k]
    // 两边都有这一条时才谈得上「谁赢」：preferLocal 的那几份一律本机说了算（见那个字段的注释），
    // 其余按时间。**只有一边有的照旧留下**——不同的剧是不同的键，谁也不会被对方顶掉
    const v = a === undefined ? b : b === undefined ? a : (spec.preferLocal ? a : pickNewer(spec, a, b))
    if (v === undefined || v === null) continue
    const t = spec.timeOf(v) || 0
    if ((tomb[k] ?? 0) >= t || clearedAt >= t) continue
    rows.push([k, v])
  }
  rows.sort((x, y) => (spec.timeOf(y[1]) || 0) - (spec.timeOf(x[1]) || 0))
  return Object.fromEntries(rows.slice(0, spec.cap).sort(byKeyAsc))
}

function mergeList(spec: SyncSpec, local: any, cloud: any, tomb: Tomb, clearedAt: number) {
  const keyOf = spec.keyOf
  if (!keyOf) return Array.isArray(local) ? local : []
  const m = new Map<string, any>()
  // 云端先入本地后入只是为了确定性，真正的胜负由 pickNewer 决定
  for (const it of [...(Array.isArray(cloud) ? cloud : []), ...(Array.isArray(local) ? local : [])]) {
    if (!it) continue
    let k = ''
    try { k = keyOf(it) } catch { continue }
    if (!k) continue
    const prev = m.get(k)
    m.set(k, prev === undefined ? it : pickNewer(spec, prev, it))
  }
  const rows = [...m.entries()].filter(([k, it]) => {
    const t = spec.timeOf(it) || 0
    return (tomb[k] ?? 0) < t && clearedAt < t
  })
  rows.sort((x, y) => ((spec.timeOf(y[1]) || 0) - (spec.timeOf(x[1]) || 0)) || byKeyAsc(x, y))
  return rows.slice(0, spec.cap).map(([, it]) => it)
}

export function mergeItems(spec: SyncSpec, local: any, cloud: any, tomb: Tomb, clearedAt: number): any {
  return spec.kind === 'map'
    ? mergeMap(spec, local, cloud, tomb, clearedAt)
    : mergeList(spec, local, cloud, tomb, clearedAt)
}
