<template>
  <div class="space-y-5">
    <!--
      「收藏这部剧」只在**认得出是哪部剧**时出现（剧名或来源页至少有一个）：
      手工贴地址播的那种列表收藏了也找不回来，给个按钮只会让人收藏一堆死条目
    -->
    <button
      v-if="canFavCurrent"
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
      :class="curFaved
        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-1 ring-rose-400/30'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
      @click="toggleCurrent"
    >
      <UIcon :name="curFaved ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'" class="w-4 h-4 shrink-0" />
      <span class="truncate">{{ curFaved ? '已收藏' : '收藏' }}{{ playlistTitle ? '《' + playlistTitle + '》' : '这部剧' }}</span>
    </button>

    <section>
      <header class="flex items-center gap-2 mb-2">
        <UIcon name="i-heroicons-clock" class="w-4 h-4 text-violet-500" />
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">播放历史</h3>
        <UBadge v-if="history.length" color="gray" variant="soft" size="xs">{{ history.length }}</UBadge>
      </header>
      <p v-if="!history.length" class="text-xs text-gray-400 px-1 py-3">还没有记录。看过的剧会自动出现在这里。</p>
      <ul v-else class="space-y-1">
        <li v-for="r in history" :key="'h' + keyOf(r)">
          <VideoPlayerLibraryRow
            :title="r.title || r.pageUrl || '未知影片'"
            :cover="r.cover"
            :sub="watchSub(r)"
            :percent="percentOf(r)"
            :current="isCurrent(r)"
            :playable="!!r.pageUrl"
            @open="play(r)"
            @remove="dropWatch(r)"
          />
        </li>
      </ul>
    </section>

    <section>
      <header class="flex items-center gap-2 mb-2">
        <UIcon name="i-heroicons-heart" class="w-4 h-4 text-rose-500" />
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">收藏影片</h3>
        <UBadge v-if="favorites.length" color="gray" variant="soft" size="xs">{{ favorites.length }}</UBadge>
      </header>
      <p v-if="!favorites.length" class="text-xs text-gray-400 px-1 py-3">还没有收藏。点上面那颗心把这部剧留下来。</p>
      <ul v-else class="space-y-1">
        <li v-for="r in favorites" :key="'f' + keyOf(r)">
          <VideoPlayerLibraryRow
            :title="r.title || r.pageUrl || '未知影片'"
            :cover="r.cover"
            :sub="favSub(r)"
            :percent="percentOf(watchOf(r))"
            :current="isCurrent(r)"
            :playable="!!r.pageUrl"
            @open="play({ ...r, ...pickResume(r) })"
            @remove="dropFav(r)"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 侧边抽屉里的「播放历史 / 收藏影片」两份清单。
 *
 * 两份清单都**按剧**存、都能整份上云（见 cloudSyncSpec.ts），所以这里显示的东西
 * 在另一台设备上也一样 —— 这正是它存在的理由：换台设备打开就能接着看。
 *
 * 点一条要落到「同一集 + 同一进度」，两条路：
 *   · 就是正在播的这部剧这条线路 → 直接跳集，不重解析（快，且不打断已经建好的连接）；
 *   · 别的剧 → 走 `?parseUrl=…&t=…` **整页重进**。不用 router 跳：本页只在 mount 时读一次
 *     地址栏，同路由换 query 不会重新装配，页面看着像没反应。
 */
import type { WatchRecord } from '~/composables/useWatchHistory'
import type { FavoriteRecord } from '~/composables/useFavorites'
// 显式 import 而不是靠自动导入：这几个是**普通导出**（不是 use* 组合式），
// 一旦谁往那两个文件里加了数组常量，紧跟其后的导出会被 unimport 静默漏掉（CLAUDE.md 里那条）
import { showKeyOf } from '~/composables/useWatchHistory'
import { onSyncApplied } from '~/composables/cloudSyncLocal'

const emit = defineEmits<{ (e: 'close'): void }>()

const {
  playlistTitle, playlistCover, playlistSource, playlist, currentIndex,
  savedProgress, currentTime, duration, getVideoName, playByIndex, saveCurrentProgress,
} = useVideoPlayerCtx()

const { allWatched, forgetWatch, findWatch } = useWatchHistory()
const { allFavorites, isFav, toggleFav, removeFav } = useFavorites()

const history = ref<WatchRecord[]>([])
const favorites = ref<FavoriteRecord[]>([])

const reload = () => {
  history.value = allWatched()
  favorites.value = allFavorites()
}
reload()

// 云同步把另一台设备的改动写进 localStorage 之后，这里的两份快照要重读，
// 否则得刷新页面才看得到（同两处搜索历史那条）
const offs = [
  onSyncApplied('video-watch', reload),
  onSyncApplied('video-fav', reload),
]
onBeforeUnmount(() => offs.forEach(off => off()))

const keyOf = (r: { title?: string; pageUrl?: string }) => showKeyOf(r) || (r.pageUrl ?? r.title ?? '')

// ── 当前这部剧 ──

const currentRef = computed(() => ({
  title: playlistTitle.value || '',
  pageUrl: playlistSource.value?.pageUrl,
}))
const canFavCurrent = computed(() => !!(currentRef.value.title || currentRef.value.pageUrl))
const curFaved = ref(false)
const syncCurFaved = () => { curFaved.value = canFavCurrent.value && isFav(currentRef.value) }
watch(currentRef, syncCurFaved, { immediate: true, deep: true })

const toggleCurrent = () => {
  if (!canFavCurrent.value) return
  const src = playlistSource.value
  curFaved.value = toggleFav({
    title: currentRef.value.title,
    pageUrl: src?.pageUrl,
    line: src?.line,
    lineName: src?.lineName,
    cover: playlistCover.value || undefined,
  })
  reload()
}

const isCurrent = (r: { title?: string; pageUrl?: string }) =>
  canFavCurrent.value && keyOf(r) === keyOf(currentRef.value)

// ── 副行文案与进度 ──

/** 正在播的这部剧用**实时**秒数，别用记录里那份（它每隔一会儿才落一次库，看着像不动） */
const liveTime = (r: { title?: string; pageUrl?: string }) => isCurrent(r) ? currentTime.value : 0
const liveDur = (r: { title?: string; pageUrl?: string }) => isCurrent(r) ? duration.value : 0

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

const watchOf = (r: FavoriteRecord) => findWatch({ title: r.title, pageUrl: r.pageUrl })

const favSub = (r: FavoriteRecord) => {
  const w = watchOf(r)
  if (w) return watchSub(w)
  return r.lineName || '未看过'
}

/** 收藏条目本身不记进度，点进去时借用同一部剧的观看记录（两份清单共用 showKeyOf） */
const pickResume = (r: FavoriteRecord) => {
  const w = watchOf(r)
  return w ? { index: w.index, epName: w.epName, time: w.time, line: w.line ?? r.line, lineName: w.lineName ?? r.lineName } : {}
}

// ── 打开一条 ──

interface OpenTarget {
  title?: string
  pageUrl?: string
  line?: number
  lineName?: string
  index?: number
  epName?: string
  time?: number
}

/** 落到哪一集：集名优先、序号兜底（源站往中间加塞时序号会指到别人身上） */
const targetIndex = (r: OpenTarget) => {
  const byName = r.epName
    ? playlist.value.findIndex((u, i) => getVideoName(u, i) === r.epName)
    : -1
  if (byName >= 0) return byName
  return Math.min(Math.max(r.index ?? 0, 0), Math.max(playlist.value.length - 1, 0))
}

const play = async (r: OpenTarget) => {
  if (!r.pageUrl) return
  const src = playlistSource.value
  saveCurrentProgress()

  // 同一部剧同一条线路：列表已经在手上，重解析纯属白等几秒
  if (src?.pageUrl === r.pageUrl && (r.line === undefined || r.line === src.line) && playlist.value.length) {
    const idx = targetIndex(r)
    const url = playlist.value[idx]
    // 本机记的进度多半比清单里那份新（那份每隔一会儿才落一次库），取靠后的那个
    if (url && r.time && r.time > (savedProgress.value[url] || 0)) savedProgress.value[url] = r.time
    emit('close')
    if (idx !== currentIndex.value) await playByIndex(idx)
    return
  }

  // 换一部剧：整页重进。手工拼 query 而不用 URLSearchParams——后者把空格编码成 `+`，
  // 而播放器那边刻意「不把 + 当空格」（视频签名里常有裸 +），剧名/集名带空格时会串成字面的 +
  const q = ['parseUrl=' + encodeURIComponent(r.pageUrl)]
  if (r.line) q.push('line=' + r.line)
  if (r.lineName) q.push('lineName=' + encodeURIComponent(r.lineName))
  q.push('index=' + (r.index ?? 0))
  if (r.epName) q.push('ep=' + encodeURIComponent(r.epName))
  if (r.time && r.time > 1) q.push('t=' + Math.floor(r.time))
  window.location.href = '/video-player?' + q.join('&')
}

// ── 删一条 ──

const dropWatch = (r: WatchRecord) => {
  forgetWatch({ title: r.title, pageUrl: r.pageUrl })
  reload()
}

const dropFav = (r: FavoriteRecord) => {
  removeFav({ title: r.title, pageUrl: r.pageUrl })
  syncCurFaved()
  reload()
}
</script>
