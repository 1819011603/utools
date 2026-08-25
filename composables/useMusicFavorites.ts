/**
 * 音乐收藏（歌单）。
 *
 * **收藏里绝对不能存播放地址**：24bit 的地址带时效签名、约 20 分钟就过期，
 * 存下来下次打开必是死链，而失败是静默的（音频元素只是不出声），比不存更难查
 * ——同 `musicPlayer/types.ts` 里 `Track.url` 那条注释、也同 video-parse 的「占位地址」那条教训。
 * 所以存的是**占位**：`key` + 元数据 + `resolver` + `locator`，播的时候由播放器重新取址。
 * 剥字段一律走 `toStorableTrack`，别在这里再写一份——两份迟早漂移，
 * 而漂移的表现正是「某天开始收藏又存进 url 了」，得等到二十分钟后才看得出来。
 *
 * 去重、比对「这首是否已收藏」一律用 `Track.key`（形如 `24bit:<id>`）：
 * 名字会重（同名翻唱），地址会变，只有 key 是稳定的。
 */
import type { Track } from '~/composables/musicPlayer/types'
import { toStorableTrack } from '~/composables/musicPlayer/types'
// 云同步的记事本。**取消收藏必须记墓碑**，否则另一台设备下次同步会把它推回来
// （表现是「取消收藏之后它自己回来了」，且只在多设备时发作）
import { markDirty, recordClear, recordDelete } from './cloudSyncLocal'

const KEY = 'music-favorites'
/** 上限：500 首足够，超了淘汰最早收藏的（同 useWatchHistory 的 MAX_SHOWS 思路） */
const MAX_FAVORITES = 500

/** 收藏的一条 = 可持久化的 Track + 收藏时间。时间既用来排序，也用来做超量淘汰 */
export interface FavoriteTrack extends Track {
  at: number
}

const read = (): FavoriteTrack[] => {
  // SSR 关着（ssr: false），但 composable 仍可能在服务端被求值一次，别炸
  if (typeof window === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    // 坏掉的存档不该拖垮整个页面：形状不对就当没有，而不是让后面的 .filter 抛异常
    return Array.isArray(raw) ? (raw as FavoriteTrack[]).filter(t => t && typeof t.key === 'string') : []
  } catch { return [] }
}

const write = (list: FavoriteTrack[]) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* 配额满了就算了 */ }
}

/**
 * 模块级单例，**不能做成每次调用新建一个 ref**：
 * 搜索结果里的收藏心和收藏面板是两个组件、各调一次 `useMusicFavorites()`，
 * 各持一份状态的话点了心之后面板不会更新，要刷新页面才看得到（而数据其实已经存进去了，
 * 这种「存对了但界面不动」最难归因）。
 */
const favorites = ref<FavoriteTrack[]>([])
/** 只在第一次调用时读盘：localStorage 是同步 IO，每个组件挂载都读一遍纯属浪费 */
let loaded = false

/** 收藏时间倒序 = 最近收藏的排最前。排序在写入时做一次，读的时候就不用每次都排 */
const sortDesc = (list: FavoriteTrack[]) => list.sort((a, b) => b.at - a.at)

const commit = (list: FavoriteTrack[]) => {
  favorites.value = sortDesc(list)
  write(favorites.value)
  markDirty('music-fav')
}

/**
 * 从 localStorage 重读一遍。给云同步用：引擎合并完是直接写 localStorage 的，
 * 上面那个模块级 ref 不会知道，不重读的话「另一台设备收的歌要刷新页面才出现」。
 */
export function reloadFavorites(): void {
  if (typeof window === 'undefined') return
  loaded = true
  favorites.value = sortDesc(read())
}

export function useMusicFavorites() {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true
    favorites.value = sortDesc(read())
  }

  /** 已收藏的 key 集合。列表里每行都要判一次，逐个 `.some()` 在 500 条上是平方级 */
  const favoriteKeys = computed(() => new Set(favorites.value.map(t => t.key)))

  const isFavorite = (key?: string) => !!key && favoriteKeys.value.has(key)

  /** 收藏一首。已在收藏里就**只更新时间**（顺手把元数据刷新成更准的那份），不产生第二条 */
  const addFavorite = (track: Track) => {
    if (!track?.key) return
    const rest = favorites.value.filter(t => t.key !== track.key)
    rest.push({ ...toStorableTrack(track), at: Date.now() })
    // 超量按最早收藏的淘汰。排序后 slice 比逐个 shift 好读，条数又只有几百
    commit(sortDesc(rest).slice(0, MAX_FAVORITES))
  }

  const removeFavorite = (key: string) => {
    if (!key) return
    recordDelete('music-fav', key)
    commit(favorites.value.filter(t => t.key !== key))
  }

  /** 返回收藏后的状态（true = 现在是收藏态），调用方可以据此弹 toast 说清是加还是取消 */
  const toggleFavorite = (track: Track) => {
    if (!track?.key) return false
    if (isFavorite(track.key)) { removeFavorite(track.key); return false }
    addFavorite(track)
    return true
  }

  const clearFavorites = () => {
    // 记一个「清空时间」而不是给几百条各发一个墓碑：语义一样，只占一个数字
    recordClear('music-fav')
    commit([])
  }

  /**
   * 把已收藏那条的元数据刷成更全的一份（封面、音质、格式、体积）。**已在收藏里才更新，绝不新增**
   * ——调用点是「正在播的这首」，新增等于把听过的歌自动收藏了。
   *
   * 为什么需要这个：**封面不在搜索结果里，要取址（播一次）之后才有**。
   * 所以「搜出来直接点心收藏、没播过」的那些，存下来时 `cover` 是空的，
   * 在收藏列表里就是一片灰色占位——看着像图挂了，其实是压根没存过图。
   * 播到哪首就顺手把那条补上。`at` 必须保留：这是补数据，不是重新收藏，不该把它顶到最前面。
   */
  const refreshMeta = (track: Track) => {
    if (!track?.key) return
    const i = favorites.value.findIndex(t => t.key === track.key)
    if (i < 0) return
    const old = favorites.value[i]
    const merged: FavoriteTrack = {
      ...old,
      cover: track.cover || old.cover,
      quality: track.quality || old.quality,
      format: track.format || old.format,
      sizeText: track.sizeText || old.sizeText,
      duration: track.duration || old.duration,
    }
    // 一个字段都没变就别写盘：这个函数挂在播放状态上，会被调很多次
    if ((['cover', 'quality', 'format', 'sizeText', 'duration'] as const).every(k => merged[k] === old[k])) return
    const next = favorites.value.slice()
    next[i] = merged
    commit(next)
  }

  return {
    favorites,
    favoriteKeys,
    isFavorite,
    addFavorite,
    removeFavorite,
    toggleFavorite,
    refreshMeta,
    clearFavorites,
  }
}
