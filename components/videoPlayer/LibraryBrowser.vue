<template>
  <Teleport to="body">
    <Transition name="lib-fade">
      <div v-if="open" class="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" @click="close" />
    </Transition>
    <Transition name="lib-pop">
      <section
        v-if="open"
        class="fixed inset-2 sm:inset-6 lg:inset-x-[8vw] lg:inset-y-8 z-[61] flex flex-col overflow-hidden
               rounded-2xl bg-white dark:bg-gray-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
      >
        <!-- 头：标题 + 管理 / 清空 / 关闭 -->
        <header class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <UIcon :name="kind === 'history' ? 'i-heroicons-clock' : 'i-heroicons-heart'"
                 class="w-5 h-5" :class="kind === 'history' ? 'text-violet-500' : 'text-rose-500'" />
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">{{ title }}</h2>
          <UBadge color="gray" variant="soft" size="xs">{{ source.length }}</UBadge>

          <div class="ml-auto flex items-center gap-2">
            <UButton size="xs" :variant="managing ? 'solid' : 'ghost'" :color="managing ? 'primary' : 'gray'"
                     @click="toggleManaging">
              {{ managing ? '完成' : '管理' }}
            </UButton>
            <UButton size="xs" variant="ghost" color="red" icon="i-heroicons-trash"
                     :disabled="!source.length" @click="askClear">清空</UButton>
            <UButton size="xs" variant="ghost" color="gray" icon="i-heroicons-x-mark" @click="close" />
          </div>
        </header>

        <!-- 搜索 + 分类 -->
        <div class="shrink-0 px-4 pt-3 space-y-3">
          <div class="flex items-center gap-2">
            <UInput
              v-model="kw"
              size="sm"
              class="flex-1"
              icon="i-heroicons-magnifying-glass"
              placeholder="搜索片名、分类、线路"
              :ui="{ rounded: 'rounded-xl' }"
            />
            <!--
              「删除已选」只在管理模式出现，且**选中 0 条时不出**：一颗永远点不动的红按钮
              比没有更让人犹豫（它到底是坏了还是我没选对？）
            -->
            <UButton
              v-if="managing && selected.size"
              size="sm"
              color="red"
              icon="i-heroicons-trash"
              @click="removeSelected"
            >
              删除已选 {{ selected.size }}
            </UButton>
          </div>

          <!-- 分类按钮**按实际出现过的值生成**：抠不到分类的站点很多，
               写死一张表只会摆出一排点进去空空如也的按钮 -->
          <div v-if="cats.length" class="flex items-center gap-2 flex-wrap">
            <button
              v-for="c in ['', ...cats]"
              :key="c || 'all'"
              type="button"
              class="px-3 py-1 rounded-full text-xs font-medium transition-colors"
              :class="cat === c
                ? 'bg-rose-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
              @click="cat = c"
            >{{ c || '全部' }}</button>
          </div>
        </div>

        <!-- 列表 -->
        <div class="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
          <p v-if="!filtered.length" class="text-sm text-gray-400 py-10 text-center">
            {{ source.length ? '没有匹配的条目' : emptyText }}
          </p>

          <div v-for="g in groups" :key="g.label">
            <!-- 日期分组头。收藏那份按收藏时间分，历史按最后观看时间分 —— 两者都是「什么时候的事」 -->
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xs font-semibold px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                {{ g.label }}
              </span>
              <span class="text-xs text-gray-400">{{ g.items.length }}</span>
            </div>
            <ul class="space-y-2">
              <li v-for="r in g.items" :key="keyOf(r)">
                <VideoPlayerLibraryBigRow
                  :title="r.title || r.pageUrl || '未知影片'"
                  :cover="r.cover"
                  :cat="r.cat"
                  :sub="subOf(r)"
                  :percent="percentFor(r)"
                  :current="isCurrent(r)"
                  :playable="!!r.pageUrl"
                  :managing="managing"
                  :selected="selected.has(keyOf(r))"
                  @open="openItem(r)"
                  @toggle="toggleSelect(r)"
                  @remove="removeOne(r)"
                />
              </li>
            </ul>
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 「查看更多」：整份播放历史 / 收藏影片，带搜索、分类筛选、按天分组、批量删除、清空。
 *
 * 与抽屉里那份短列表共用同一份数据（`useLibrary` 的共享快照）和同一套落点逻辑
 * （`useLibraryPlay`）—— 两处各写一份的话，删一条会出现「这边没了那边还在」。
 *
 * 打开时顺便启动**封面补齐**（`useCoverBackfill`）：老记录没有图，趁用户在翻列表
 * 慢慢把它们抓回来；关掉就停手（用户回去看片了，那时抓页只会跟播放抢带宽）。
 */
import type { LibraryItem, LibraryKind } from '~/composables/useLibrary'
import type { WatchRecord } from '~/composables/useWatchHistory'
import type { FavoriteRecord } from '~/composables/useFavorites'
import { filterLibrary, groupByDay, libraryCategories } from '~/composables/libraryFilter'

const props = defineProps<{ kind: LibraryKind | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const toast = useToast()
const { history, favorites, remove, removeMany, clearAll, keyOf } = useLibrary()
const { play, isCurrent, percentOf, watchSub, favSub, watchOf, pickResume } = useLibraryPlay()
const { refreshFavorite } = useVideoPlayerCtx()
const backfill = useCoverBackfill()

const open = computed(() => !!props.kind)
const kind = computed<LibraryKind>(() => props.kind ?? 'history')
const title = computed(() => kind.value === 'history' ? '播放历史' : '收藏影片')
const emptyText = computed(() => kind.value === 'history'
  ? '还没有记录。看过的剧会自动出现在这里。'
  : '还没有收藏。在播放器里点那颗心把剧留下来。')

const source = computed<LibraryItem[]>(() =>
  (kind.value === 'history' ? history.value : favorites.value) as LibraryItem[])

// ── 搜索 / 筛选 / 分组 ──

const kw = ref('')
const cat = ref('')
const cats = computed(() => libraryCategories(source.value))
const filtered = computed(() => filterLibrary(source.value, kw.value, cat.value))
const groups = computed(() => groupByDay(filtered.value))

// 换一份清单（历史 ↔ 收藏）时把筛选条件和选中态全清掉：留着上一份的关键词
// 会让人以为新这份是空的
watch(() => props.kind, () => {
  kw.value = ''
  cat.value = ''
  managing.value = false
  selected.value = new Set()
})

// 分类按钮是按实际数据生成的，删着删着某个分类可能整个没了 → 筛选条件跟着退回「全部」，
// 否则列表会空着而用户找不到原因
watch(cats, list => { if (cat.value && !list.includes(cat.value)) cat.value = '' })

// 打开时补封面，关掉就停
watch(open, (v) => { if (v) void backfill.start(); else backfill.stop() }, { immediate: true })
onBeforeUnmount(() => backfill.stop())

// ── 每行显示什么 ──

const subOf = (r: LibraryItem) =>
  kind.value === 'history' ? watchSub(r as WatchRecord) : favSub(r as FavoriteRecord)

const percentFor = (r: LibraryItem) =>
  kind.value === 'history' ? percentOf(r as WatchRecord) : percentOf(watchOf(r as FavoriteRecord))

// ── 管理模式 ──

const managing = ref(false)
const selected = ref<Set<string>>(new Set())

const toggleManaging = () => {
  managing.value = !managing.value
  if (!managing.value) selected.value = new Set()
}

const toggleSelect = (r: LibraryItem) => {
  const k = keyOf(r)
  const next = new Set(selected.value)
  next.has(k) ? next.delete(k) : next.add(k)
  selected.value = next    // 换新 Set 而不是原地改：Set 的增删不触发依赖它的 computed
}

const removeSelected = () => {
  const picks = filtered.value.filter(r => selected.value.has(keyOf(r)))
  removeMany(kind.value, picks)
  selected.value = new Set()
  if (kind.value === 'favorite') refreshFavorite()
  toast.add({ title: `已删除 ${picks.length} 条`, color: 'green', timeout: 2000 })
}

const removeOne = (r: LibraryItem) => {
  remove(kind.value, r)
  if (kind.value === 'favorite') refreshFavorite()
}

/**
 * 清空要二次确认：这一下删的是几十上百条、且**跨设备**（墓碑会同步出去，
 * 另一台设备下次同步也跟着清）。用原生 confirm 而不是自造弹窗——本页已经有两层浮层了，
 * 再叠一层对话框的层级和焦点管理不值得为一颗按钮做
 */
const askClear = () => {
  if (!source.value.length) return
  const ok = window.confirm(`确定清空${title.value}吗？共 ${source.value.length} 条，登录状态下另一台设备也会跟着清空。`)
  if (!ok) return
  clearAll(kind.value)
  selected.value = new Set()
  if (kind.value === 'favorite') refreshFavorite()
  toast.add({ title: title.value + '已清空', color: 'green', timeout: 2000 })
}

// ── 打开一条 ──

const openItem = async (r: LibraryItem) => {
  // 管理模式下整行是「选中/取消」，不是「播放」：点一条就跳走的话根本选不完
  if (managing.value) { toggleSelect(r); return }
  close()
  await play(kind.value === 'history'
    ? (r as WatchRecord)
    : { ...(r as FavoriteRecord), ...pickResume(r as FavoriteRecord) })
}

const close = () => emit('close')

// Esc 关闭。捕获阶段 + 只在开着时拦，免得跟播放器的快捷键（Esc 也管退出全屏）抢
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<style scoped>
.lib-fade-enter-active,
.lib-fade-leave-active { transition: opacity .2s ease; }
.lib-fade-enter-from,
.lib-fade-leave-to { opacity: 0; }

.lib-pop-enter-active { transition: opacity .25s ease, transform .3s cubic-bezier(.22, 1, .36, 1); }
.lib-pop-leave-active { transition: opacity .18s ease, transform .18s ease-in; }
.lib-pop-enter-from,
.lib-pop-leave-to { opacity: 0; transform: scale(.97); }
</style>
