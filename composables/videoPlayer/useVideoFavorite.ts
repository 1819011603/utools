/**
 * 「这部剧收了没」——播放器侧的收藏状态。
 *
 * 单独成模块而不是塞进某个组件：收藏这颗按钮同时出现在**三处**（画面顶栏、左侧常驻按钮、
 * 媒体库抽屉里那条），三处各自去读一遍 localStorage 的话，在一处点了另外两处不会变
 *（表现是「点了收藏，顶栏那颗心还是空的」）。这里持一份 ref，三处共用。
 *
 * 只吃 handoff（剧名 / 来源页 / 封面都在那儿），不碰 playlist —— 收藏记的是「哪部剧」，
 * 跟播到第几集、地址是什么毫无关系。
 */
import type { VideoHandoff } from './useVideoHandoff'
import { onSyncApplied } from '../cloudSyncLocal'

export function useVideoFavorite(deps: { handoff: VideoHandoff }) {
  const { handoff } = deps
  const { isFav, toggleFav } = useFavorites()

  /** 认得出是哪部剧才谈得上收藏：手工贴地址播的列表收了也找不回来 */
  const canFavorite = computed(() =>
    !!(handoff.playlistTitle.value || handoff.playlistSource.value?.pageUrl))

  const favQuery = () => ({
    title: handoff.playlistTitle.value || '',
    pageUrl: handoff.playlistSource.value?.pageUrl,
  })

  const isFavorited = ref(false)
  const refreshFavorite = () => { isFavorited.value = canFavorite.value && isFav(favQuery()) }

  // 换了一部剧（或解析完拿到剧名）就重算
  watch([() => handoff.playlistTitle.value, () => handoff.playlistSource.value?.pageUrl],
    refreshFavorite, { immediate: true })

  // 另一台设备收藏/取消之后，同步引擎把结果写进 localStorage —— 这里的 ref 要跟着变，
  // 否则得刷新页面才对得上（同两处搜索历史那条）
  const off = onSyncApplied('video-fav', refreshFavorite)
  onScopeDispose(() => off())

  const toggleFavorite = () => {
    if (!canFavorite.value) return
    const src = handoff.playlistSource.value
    isFavorited.value = toggleFav({
      title: handoff.playlistTitle.value || '',
      pageUrl: src?.pageUrl,
      line: src?.line,
      lineName: src?.lineName,
      // 封面只在解析那一下拿得到；没有就不写，别把已有的那张覆盖成空（addFav 里也兜了一道）
      cover: handoff.playlistCover.value || undefined,
    })
  }

  return { canFavorite, isFavorited, toggleFavorite, refreshFavorite }
}

export type VideoFavorite = ReturnType<typeof useVideoFavorite>
