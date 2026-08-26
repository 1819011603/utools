/**
 * 收藏影片（按**剧**存，不是按地址存）。
 *
 * 与 `useWatchHistory` 是一对：那份记「我看到哪了」（自动写，会被淘汰），
 * 这份记「我要留着」（手动点，不淘汰、不因为几个月没看就消失）。
 * 两份共用同一把钥匙 `showKeyOf` —— 同一部剧在两份清单里必须是同一条，
 * 否则「收藏了但列表里点进去续不上上次那一集」这种事只会在剧名多个空格时发作，肉眼查不出来。
 *
 * 存的东西刻意只有「怎么再找到这部剧」：源站播放页 + 线路 + 剧名 + 封面地址。
 * **一个播放地址都不存**（解析出来的地址带时效签名，存下来下次就是死链），
 * 点进去一律重新解析 —— 这与 `?parseUrl=` 那条路是同一套。
 */
import { markDirty, recordDelete } from './cloudSyncLocal'
import { showKeyOf } from './useWatchHistory'

export interface FavoriteRecord {
  /** 剧名（有就有，没有则空串——那时靠 pageUrl 认） */
  title: string
  /** 源站播放页地址：点进去重新解析，没有它这条收藏就只是个名字 */
  pageUrl?: string
  /** 收藏时看的是哪条线路。只是个默认值，线路没了也不影响解析（服务端会退回第一条） */
  line?: number
  lineName?: string
  /** 封面图地址。理由同 WatchRecord.cover：存地址不存图 */
  cover?: string
  /** 分类（「电视剧」「动漫」…），给「查看更多」里那排筛选按钮用 */
  cat?: string
  /** 收藏时间，列表按它倒序 */
  at: number
}

const KEY = 'video-favorites'
/**
 * 收藏是手动行为，正常人不会攒到几百部；给 500 是防手滑脚本，
 * 顶到了就淘汰最早收藏的那些（同 `useWatchHistory` 的 MAX_SHOWS，只是那份按「最近看过」淘汰）。
 */
const MAX_FAVS = 500

type Store = Record<string, FavoriteRecord>

const load = (): Store => {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store } catch { return {} }
}

const save = (s: Store) => {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 配额满了就算了 */ }
  markDirty('video-fav')
}

export function useFavorites() {
  const favKeyOf = showKeyOf

  const isFav = (q: { title?: string; pageUrl?: string }): boolean => {
    const k = favKeyOf(q)
    return !!k && !!load()[k]
  }

  const addFav = (r: Omit<FavoriteRecord, 'at'>) => {
    const k = favKeyOf(r)
    if (!k) return
    const s = load()
    // 已收藏就只补信息不刷时间：重新收藏一遍不该把它顶到列表最前面（用户没做「收藏」这个动作），
    // 而封面/线路这类信息该趁这次解析补齐（老记录常常没有封面）
    const old = s[k]
    s[k] = {
      ...old,
      ...r,
      cover: r.cover || old?.cover,
      cat: r.cat || old?.cat,
      at: old?.at ?? Date.now(),
    }
    const keys = Object.keys(s)
    if (keys.length > MAX_FAVS) {
      keys.sort((a, b) => (s[a]!.at) - (s[b]!.at))
      for (const dead of keys.slice(0, keys.length - MAX_FAVS)) delete s[dead]
    }
    save(s)
  }

  const removeFav = (q: { title?: string; pageUrl?: string }) => {
    const s = load()
    const k = favKeyOf(q)
    if (!k) return
    delete s[k]
    // 墓碑：只做并集的话删除永远传不出去，另一台设备下次同步又把它推回来
    recordDelete('video-fav', k)
    save(s)
  }

  /** 收藏/取消，返回操作后的状态（按钮直接拿它当新状态用） */
  const toggleFav = (r: Omit<FavoriteRecord, 'at'>): boolean => {
    if (isFav(r)) { removeFav(r); return false }
    addFav(r)
    return true
  }

  const allFavorites = (): FavoriteRecord[] => Object.values(load()).sort((a, b) => b.at - a.at)

  /** 补封面/分类。同 `patchWatchMeta`：**不动 `at`**（那是收藏时间，列表按它排序），只补空位 */
  const patchFavMeta = (q: { title?: string; pageUrl?: string }, patch: { cover?: string; cat?: string }) => {
    const k = favKeyOf(q)
    if (!k) return false
    const s = load()
    const r = s[k]
    if (!r) return false
    let changed = false
    if (patch.cover && !r.cover) { r.cover = patch.cover; changed = true }
    if (patch.cat && !r.cat) { r.cat = patch.cat; changed = true }
    if (changed) save(s)
    return changed
  }

  return { isFav, addFav, removeFav, toggleFav, allFavorites, favKeyOf, patchFavMeta }
}
