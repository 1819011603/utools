<template>
  <!--
    全屏时整块不渲染：`fixed` 定位的元素挂在全屏元素**外面**，全屏下一个像素都看不见，
    留着只是让它在退出全屏的那一瞬间闪一下。全屏里要换集有画面内的选集抽屉。
  -->
  <div v-if="!hidden">
    <!--
      贴着左边缘的一竖条按钮。放左边而不是右边：右下角归控制栏和手势（长按 2x 就在那一带），
      而这两颗是「看片之外」的入口，离得越远越不容易误触。
    -->
    <div class="fixed left-0 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-1.5">
      <!--
        收藏单独一颗**常驻**按钮，不藏进抽屉：收藏是一下就完的动作，
        为它先点开一层面板不值当（而画面里那颗心要等控制栏出来才看得见）
      -->
      <button
        v-if="canFavorite"
        type="button"
        class="group flex items-center gap-1.5 py-3 pl-1.5 pr-2 rounded-r-xl shadow-lg
               bg-white/85 dark:bg-gray-900/85 backdrop-blur
               ring-1 ring-black/5 dark:ring-white/10
               hover:pl-2.5 transition-all active:scale-95"
        :class="isFavorited ? 'text-rose-500' : 'text-gray-500 dark:text-gray-400 hover:text-rose-500'"
        :title="isFavorited ? '取消收藏' : '收藏这部剧'"
        @click="toggleFavorite"
      >
        <UIcon :name="isFavorited ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'" class="w-5 h-5 shrink-0" />
        <span class="hidden sm:block text-[10px] leading-tight tracking-wider" style="writing-mode: vertical-rl">
          {{ isFavorited ? '已收藏' : '收藏' }}
        </span>
      </button>

      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        class="group flex items-center gap-1.5 py-3 pl-1.5 pr-2 rounded-r-xl shadow-lg
               bg-white/85 dark:bg-gray-900/85 backdrop-blur
               ring-1 ring-black/5 dark:ring-white/10
               text-gray-500 dark:text-gray-400
               hover:text-rose-500 hover:pl-2.5 transition-all active:scale-95"
        :title="t.label"
        @click="toggle(t.id)"
      >
        <UIcon :name="t.icon" class="w-5 h-5 shrink-0" />
        <!-- 竖排的文字标签：只在够宽的屏上出，手机上光留图标 -->
        <span class="hidden sm:block text-[10px] leading-tight tracking-wider" style="writing-mode: vertical-rl">
          {{ t.label }}
        </span>
      </button>
    </div>

    <!--
      抽屉挂到 body 上：播放器容器上有 transform（全屏动画、手势），
      而 `fixed` 一旦落在带 transform 的祖先里就会以那个祖先为参照，位置直接跑偏。
    -->
    <Teleport to="body">
      <Transition name="dock-fade">
        <div v-if="active" class="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" @click="close" />
      </Transition>
      <Transition name="dock-slide">
        <aside
          v-if="active"
          class="fixed inset-y-0 left-0 z-50 w-[min(86vw,22rem)] flex flex-col
                 bg-white dark:bg-gray-900 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
        >
          <header class="shrink-0 flex items-center gap-2 px-3 py-3 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-1 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800">
              <button
                v-for="t in tabs"
                :key="t.id"
                type="button"
                class="px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5"
                :class="active === t.id
                  ? 'bg-white dark:bg-gray-900 text-rose-600 dark:text-rose-300 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
                @click="active = t.id"
              >
                <UIcon :name="t.icon" class="w-4 h-4" />
                {{ t.label }}
              </button>
            </div>
            <button
              type="button"
              class="ml-auto p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="关闭"
              @click="close"
            >
              <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto overscroll-contain px-3 py-3">
            <VideoPlayerLibraryPanel v-if="active === 'library'" @close="close" @browse="browse" />
            <VideoPlayerLinePicker v-else @close="close" />
          </div>
        </aside>
      </Transition>
    </Teleport>

    <!-- 「查看更多」：整份清单 + 搜索/筛选/管理。自己也是 Teleport 到 body 的浮层，
         层级排在抽屉之上（它是从抽屉里点开的，盖住抽屉才对） -->
    <VideoPlayerLibraryBrowser :kind="browsing" @close="browsing = null" />
  </div>
</template>

<script setup lang="ts">
/**
 * 左侧悬浮抽屉：**收藏** / **媒体库**（播放历史 + 收藏影片） / **换源**（线路表）。
 *
 * **同一套挂在三个页面上**：放映厅、按片名搜索、视频解析。追剧这件事在这三处是连着的
 * ——搜片时想看看上次追到哪、解析页里想接着看昨天那部——为它们各做一套入口只会漂移。
 *
 * 做成常驻悬浮按钮而不是页面下方又一张折叠卡：这些都是「看着看着想起来要做」的事，
 * 而折叠卡在滑三屏之外。
 *
 * 本组件只管开合与版式，每块内容各自成组件、数据也各自去取，
 * 免得这里变成一个什么都知道的大文件。
 */
import type { LibraryKind } from '~/composables/useLibrary'

/**
 * **可选**上下文：这套 dock 同时挂在播放页、搜索页、解析页上，后两个页面没有播放器。
 * 没有 ctx 时只剩「媒体库」一个入口——「换源」和「收藏当前」都要有正在播的那部剧才谈得上。
 */
const ctx = useVideoPlayerCtxOptional()

// 全屏时整块不渲染：`fixed` 元素挂在全屏元素**外面**，全屏下一个像素都看不见，
// 留着只会在退出全屏那一瞬间闪一下。没有播放器的页面自然不存在全屏这回事
const hidden = computed(() => !!ctx?.isFullscreen.value)
const canFavorite = computed(() => !!ctx?.canFavorite.value)
const isFavorited = computed(() => !!ctx?.isFavorited.value)
const toggleFavorite = () => ctx?.toggleFavorite()

type TabId = 'library' | 'lines'

// 换源那颗只在**真的有线路可换**时出现：手工贴地址播的列表没有「线路」这回事，
// 给一颗点开是空的按钮比不给更糟
const tabs = computed(() => {
  const list: { id: TabId; label: string; icon: string }[] = [
    { id: 'library', label: '媒体库', icon: 'i-heroicons-rectangle-stack' },
  ]
  // 换源只在播放器里有意义：搜索页/解析页压根没有播放列表，更没有「当前这一集」可保留
  if ((ctx?.playlistLines.value.length ?? 0) > 1) list.push({ id: 'lines', label: '换源', icon: 'i-heroicons-arrows-right-left' })
  return list
})

const active = ref<TabId | null>(null)
const close = () => { active.value = null }
const toggle = (id: TabId) => { active.value = active.value === id ? null : id }

/** 「查看更多」打开的是哪一份清单（null = 没开） */
const browsing = ref<LibraryKind | null>(null)
const browse = (kind: LibraryKind) => {
  // 抽屉一起收掉：大面板几乎占满屏，底下压着一条抽屉只是徒增层次
  active.value = null
  browsing.value = kind
}

// 线路表没了（换成一份手工列表）而面板正停在换源页 → 退回媒体库，别留个空面板
watch(tabs, list => {
  if (active.value && !list.some(t => t.id === active.value)) active.value = 'library'
})

// Esc 关闭。抽屉是浮层，用户的第一反应就是按 Esc；
// **只在开着时才拦**，否则会跟播放器自己的快捷键抢（Esc 还兼着退出全屏）
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && active.value) {
    e.stopPropagation()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<style scoped>
.dock-fade-enter-active,
.dock-fade-leave-active { transition: opacity .2s ease; }
.dock-fade-enter-from,
.dock-fade-leave-to { opacity: 0; }

.dock-slide-enter-active { transition: transform .3s cubic-bezier(.22, 1, .36, 1); }
.dock-slide-leave-active { transition: transform .2s ease-in; }
.dock-slide-enter-from,
.dock-slide-leave-to { transform: translateX(-100%); }
</style>
