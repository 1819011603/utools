/**
 * 媒体库（播放历史 + 收藏影片）的**共享快照**与查找/批量操作。
 *
 * 为什么要一份共享状态而不是各组件自己 `ref(allWatched())`：这两份清单同时出现在
 * 三个地方（抽屉里的前几条、「查看更多」那个大面板、以及收藏那颗心），
 * 在任一处删一条、收藏一部，其余两处都得当场跟着变。各自持快照的话就是「删了还在」。
 *
 * 模块级单例（同 useSegmentCache 那套）：整页只有一份数据，谁先用谁触发首次加载。
 * 云同步把另一台设备的改动写进 localStorage 之后也要重读，所以在这里**一次性**订阅
 * `cloud-sync-applied`——放进组件里的话，组件没挂载时那次同步就白同步了。
 */
import type { WatchRecord } from './useWatchHistory'
import type { FavoriteRecord } from './useFavorites'
import { showKeyOf } from './useWatchHistory'
import { onSyncApplied, recordClear } from './cloudSyncLocal'

export type LibraryKind = 'history' | 'favorite'
/** 两份清单在界面上要显示的字段是同一套，差别只在「哪来的」 */
export type LibraryItem = (WatchRecord | FavoriteRecord) & { index?: number; epName?: string; total?: number }

const history = ref<WatchRecord[]>([])
const favorites = ref<FavoriteRecord[]>([])
let started = false

export function useLibrary() {
  const { allWatched, forgetWatch } = useWatchHistory()
  const { allFavorites, removeFav } = useFavorites()

  const reload = () => {
    history.value = allWatched()
    favorites.value = allFavorites()
  }

  if (!started && typeof window !== 'undefined') {
    started = true
    reload()
    onSyncApplied('video-watch', reload)
    onSyncApplied('video-fav', reload)
  }

  const keyOf = (r: { title?: string; pageUrl?: string }) => showKeyOf(r) || (r.pageUrl ?? r.title ?? '')

  /** 删一条（两份清单各自的删除都要留墓碑，那在各自的模块里做了） */
  const remove = (kind: LibraryKind, r: { title?: string; pageUrl?: string }) => {
    if (kind === 'history') forgetWatch({ title: r.title, pageUrl: r.pageUrl })
    else removeFav({ title: r.title, pageUrl: r.pageUrl })
    reload()
  }

  /** 删一批（管理模式里的「删除已选」） */
  const removeMany = (kind: LibraryKind, items: { title?: string; pageUrl?: string }[]) => {
    for (const r of items) {
      if (kind === 'history') forgetWatch({ title: r.title, pageUrl: r.pageUrl })
      else removeFav({ title: r.title, pageUrl: r.pageUrl })
    }
    reload()
  }

  /**
   * 整份清空。**走 `recordClear` 而不是逐条删**：一条条删会给每条都记一个墓碑，
   * 200 部剧就是 200 个墓碑要上云；`clearedAt` 只占一个时间戳，语义还更准
   *（「这个时间点之前的都不要了」）。
   */
  const clearAll = (kind: LibraryKind) => {
    const lsKey = kind === 'history' ? 'video-watch-history' : 'video-favorites'
    try { localStorage.setItem(lsKey, '{}') } catch { /* 写不进去也就算了，下面照样刷新界面 */ }
    recordClear(kind === 'history' ? 'video-watch' : 'video-fav')
    reload()
  }

  return { history, favorites, reload, remove, removeMany, clearAll, keyOf }
}
