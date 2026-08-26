/**
 * 「媒体库里点一条会怎样」——落点、副行文案、进度百分比。
 *
 * 抽出来是因为抽屉里那份短列表和「查看更多」那个大面板要的是**同一套**答案：
 * 各写一份的话，两处显示的百分比迟早对不上（一处算了实时秒数、另一处只读记录）。
 *
 * 它要读播放器上下文（当前播的是哪部剧、跳集），所以只能在播放页的组件里调。
 */
import type { WatchRecord } from '../useWatchHistory'
import type { FavoriteRecord } from '../useFavorites'

export interface LibraryTarget {
  title?: string
  pageUrl?: string
  line?: number
  lineName?: string
  index?: number
  epName?: string
  time?: number
}

export function useLibraryPlay() {
  /**
   * **可选**上下文：这套组件也挂在搜索页和解析页上，那两个页面没有播放器。
   * 拿不到就一律按「没有正在播的那部剧」处理——点一条整页跳去播放器（见 play）。
   */
  const ctx = useVideoPlayerCtxOptional()

  const { findWatch } = useWatchHistory()
  const { keyOf } = useLibrary()

  const currentRef = computed(() => ({
    title: ctx?.playlistTitle.value || '',
    pageUrl: ctx?.playlistSource.value?.pageUrl,
  }))
  const hasCurrent = computed(() => !!(currentRef.value.title || currentRef.value.pageUrl))

  const isCurrent = (r: { title?: string; pageUrl?: string }) =>
    hasCurrent.value && keyOf(r) === keyOf(currentRef.value)

  // 正在播的那部剧用**实时**秒数：记录每隔一会儿才落一次库，照它显示的话进度条看着像不动
  const liveTime = (r: { title?: string; pageUrl?: string }) => isCurrent(r) ? (ctx?.currentTime.value ?? 0) : 0
  const liveDur = (r: { title?: string; pageUrl?: string }) => isCurrent(r) ? (ctx?.duration.value ?? 0) : 0

  const percentOf = (r?: WatchRecord | null) => {
    if (!r) return 0
    const dur = liveDur(r) || r.duration || 0
    const t = liveTime(r) || r.time || 0
    if (!dur || !t) return 0
    return Math.min(100, Math.max(0, Math.round((t / dur) * 100)))
  }

  // 集名多半就是个纯数字（「10」），孤零零一个数字看不出是什么 → 补成「第10集」
  const epLabel = (r: WatchRecord) =>
    r.epName && !/^\d{1,4}$/.test(r.epName) ? r.epName : `第${r.index + 1}集`

  const watchSub = (r: WatchRecord) => {
    const parts = [epLabel(r)]
    const t = liveTime(r) || r.time || 0
    if (t > 0) parts.push(formatTime(t))
    const p = percentOf(r)
    if (p > 0) parts.push(p + '%')
    return parts.join(' · ')
  }

  /** 收藏条目不记进度，借用同一部剧的观看记录（两份清单共用 showKeyOf 这把钥匙） */
  const watchOf = (r: FavoriteRecord) => findWatch({ title: r.title, pageUrl: r.pageUrl })

  const favSub = (r: FavoriteRecord) => {
    const w = watchOf(r)
    return w ? watchSub(w) : (r.lineName || '未看过')
  }

  /** 收藏点进去要落在「上次看到那一集」上，所以先去观看记录里取集数和秒数 */
  const pickResume = (r: FavoriteRecord): LibraryTarget => {
    const w = watchOf(r)
    return w
      ? { index: w.index, epName: w.epName, time: w.time, line: w.line ?? r.line, lineName: w.lineName ?? r.lineName }
      : {}
  }

  /** 落到哪一集：集名优先、序号兜底（源站往中间加塞时序号会指到别人身上） */
  const targetIndex = (r: LibraryTarget) => {
    const list = ctx?.playlist.value ?? []
    const byName = r.epName && ctx
      ? list.findIndex((u, i) => ctx.getVideoName(u, i) === r.epName)
      : -1
    if (byName >= 0) return byName
    return Math.min(Math.max(r.index ?? 0, 0), Math.max(list.length - 1, 0))
  }

  /**
   * 打开一条：**同一集 + 同一进度**。
   *   · 就是正在播的这部剧这条线路 → 直接跳集，不重解析（快，也不打断已经建好的连接）；
   *   · 别的剧 → 走 `?parseUrl=…&t=…` **整页重进**。不用 router：本页只在 mount 时读一次
   *     地址栏，同路由换 query 不会重新装配，点了看着像没反应。
   */
  const play = async (r: LibraryTarget) => {
    if (!r.pageUrl) return
    // 没有播放器（搜索页/解析页）时这一整段都跳过，直接走下面的整页跳转
    const src = ctx?.playlistSource.value
    ctx?.saveCurrentProgress()

    if (ctx && src?.pageUrl === r.pageUrl && (r.line === undefined || r.line === src.line) && ctx.playlist.value.length) {
      const idx = targetIndex(r)
      const url = ctx.playlist.value[idx]
      // 本机记的进度多半比清单里那份新，取靠后的那个（拿旧的盖掉 = 点一下续看反而倒退）
      if (url && r.time && r.time > (ctx.savedProgress.value[url] || 0)) ctx.savedProgress.value[url] = r.time
      if (idx !== ctx.currentIndex.value) await ctx.playByIndex(idx)
      return
    }

    // 手工拼 query 而不用 URLSearchParams——后者把空格编码成 `+`，
    // 而播放器那边刻意「不把 + 当空格」（视频签名里常有裸 +），剧名/集名带空格时会串成字面的 +
    const q = ['parseUrl=' + encodeURIComponent(r.pageUrl)]
    if (r.line) q.push('line=' + r.line)
    if (r.lineName) q.push('lineName=' + encodeURIComponent(r.lineName))
    q.push('index=' + (r.index ?? 0))
    if (r.epName) q.push('ep=' + encodeURIComponent(r.epName))
    if (r.time && r.time > 1) q.push('t=' + Math.floor(r.time))
    window.location.href = '/video-player?' + q.join('&')
  }

  return { play, isCurrent, percentOf, watchSub, favSub, watchOf, pickResume }
}
