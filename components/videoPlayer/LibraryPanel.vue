<template>
  <div class="space-y-5">
    <!--
      「收藏这部剧」只在**认得出是哪部剧**时出现（剧名或来源页至少有一个）：
      手工贴地址播的那种列表收藏了也找不回来，给个按钮只会让人收藏一堆死条目
    -->
    <button
      v-if="canFavorite"
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
      :class="isFavorited
        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-1 ring-rose-400/30'
        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
      @click="toggleCurrent"
    >
      <UIcon :name="isFavorited ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'" class="w-4 h-4 shrink-0" />
      <span class="truncate">{{ isFavorited ? '已收藏' : '收藏' }}{{ playlistTitle ? '《' + playlistTitle + '》' : '这部剧' }}</span>
    </button>

    <section v-for="sec in sections" :key="sec.kind">
      <header class="flex items-center gap-2 mb-2">
        <UIcon :name="sec.icon" class="w-4 h-4" :class="sec.iconClass" />
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">{{ sec.title }}</h3>
        <UBadge v-if="sec.all.length" color="gray" variant="soft" size="xs">{{ sec.all.length }}</UBadge>
        <!--
          「查看更多」**有没有超出都给**：那扇门后面还有搜索、筛选、批量删除，
          只按「条数 > 4」才给的话，只有 3 条的人永远找不到清空按钮
        -->
        <button
          v-if="sec.all.length"
          type="button"
          class="ml-auto text-xs text-rose-500 hover:text-rose-400 transition-colors"
          @click="emit('browse', sec.kind)"
        >
          查看更多
        </button>
      </header>

      <p v-if="!sec.all.length" class="text-xs text-gray-400 px-1 py-3">{{ sec.empty }}</p>
      <ul v-else class="space-y-1">
        <li v-for="r in sec.top" :key="sec.kind + keyOf(r)">
          <VideoPlayerLibraryRow
            :title="r.title || r.pageUrl || '未知影片'"
            :cover="r.cover"
            :sub="sec.kind === 'history' ? watchSub(r as any) : favSub(r as any)"
            :percent="sec.kind === 'history' ? percentOf(r as any) : percentOf(watchOf(r as any))"
            :current="isCurrent(r)"
            :playable="!!r.pageUrl"
            @open="open(sec.kind, r)"
            @remove="remove(sec.kind, r)"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 侧边抽屉里的「播放历史 / 收藏影片」——**只摆前 4 条**。
 *
 * 抽屉是给「接着看上次那部」用的，四条就覆盖了绝大多数场景；再往下翻要的是找片，
 * 那件事该在一个有搜索和筛选的地方做（`LibraryBrowser`，由「查看更多」打开）。
 * 数据本身在 `useLibrary` 的共享快照里，删一条三处一起变。
 */
import type { LibraryItem, LibraryKind } from '~/composables/useLibrary'

const emit = defineEmits<{ (e: 'close'): void; (e: 'browse', kind: LibraryKind): void }>()

/**
 * **可选**上下文：这块也挂在搜索页和解析页的侧边抽屉里，那两个页面没有播放器。
 * 拿不到时「收藏当前这部剧」那颗按钮整个不出（没有"当前"可言），列表照常。
 * 收藏状态本身由控制器持有——画面顶栏和左侧那颗常驻按钮也在改它，各自读一份就会对不上。
 */
const ctx = useVideoPlayerCtxOptional()
const playlistTitle = computed(() => ctx?.playlistTitle.value ?? '')
const canFavorite = computed(() => !!ctx?.canFavorite.value)
const isFavorited = computed(() => !!ctx?.isFavorited.value)

const { history, favorites, remove: removeItem, keyOf, reload } = useLibrary()
const { play, isCurrent, percentOf, watchSub, favSub, watchOf, pickResume } = useLibraryPlay()

// 抽屉一打开就开始把老记录缺的封面慢慢抓回来（串行 + 间隔，见 useCoverBackfill）；
// 抽屉关掉（组件卸载）就停手 —— 那时用户已经回去看片了
const backfill = useCoverBackfill()
onMounted(() => void backfill.start())
onBeforeUnmount(() => backfill.stop())

/** 抽屉里只摆这么多条，其余去「查看更多」 */
const TOP_N = 4

const sections = computed(() => [
  {
    kind: 'history' as LibraryKind,
    title: '播放历史',
    icon: 'i-heroicons-clock',
    iconClass: 'text-violet-500',
    empty: '还没有记录。看过的剧会自动出现在这里。',
    all: history.value as LibraryItem[],
    top: history.value.slice(0, TOP_N) as LibraryItem[],
  },
  {
    kind: 'favorite' as LibraryKind,
    title: '收藏影片',
    icon: 'i-heroicons-heart',
    iconClass: 'text-rose-500',
    empty: '还没有收藏。点上面那颗心把这部剧留下来。',
    all: favorites.value as LibraryItem[],
    top: favorites.value.slice(0, TOP_N) as LibraryItem[],
  },
])

/** 收藏动作在控制器里，这里只补一件它管不着的事：把下面那份收藏列表重读一遍 */
const toggleCurrent = () => {
  ctx?.toggleFavorite()
  reload()
}

const open = async (kind: LibraryKind, r: LibraryItem) => {
  emit('close')
  await play(kind === 'history' ? (r as any) : { ...r, ...pickResume(r as any) })
}

const remove = (kind: LibraryKind, r: LibraryItem) => {
  removeItem(kind, r)
  // 删掉的可能正是当前这部剧 → 三处按钮共用的那份收藏状态要跟着变回空心
  if (kind === 'favorite') ctx?.refreshFavorite()
}
</script>
