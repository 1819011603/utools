<script setup lang="ts">
/**
 * 左侧「我的音乐」栏（网易云 / QQ 音乐那种常驻侧边栏，可收起成一条窄轨）。
 *
 * ## 为什么是侧边栏，不是页面里的一张卡片
 *
 * 收藏是**一直要用**的东西：边搜边听时随时要回去点一首、随手收一首。
 * 摆在页面流里就得先滚到它那儿，而搜索结果一长，它就被推到几屏之外；
 * 收藏本身还有几百条，展开又会把页面顶长。侧边栏两个问题一起解决——
 * 位置固定不随页面滚动，自己滚自己的。
 *
 * ## 两套形态共用一份标记
 *
 * 宽屏：常驻。收起 = 一条 `w-14` 的窄轨（只留一枚心和条数），展开 = `w-72` 的完整列表。
 * 窄屏：屏幕就那么宽，常驻会把内容挤没 → 收起时整块滑出屏幕，展开时当抽屉盖在内容上（带遮罩）。
 * 这两套只差几个响应式类名，**不做成两个组件**：做成两个立刻要同步两份列表标记和交互。
 *
 * 开关复用 ctx 里的 `showFavorites`（播放条上那枚星星按钮），不另起一个状态——
 * 两个开关管同一块东西，迟早会不同步。
 *
 * 点一首的行为是「把整份收藏当队列、从这一首开始播」而不是只播这一首：
 * 收藏本来就是个歌单，只播一首会让「下一首」无处可去，播完就停。
 */
import type { Track } from '~/composables/musicPlayer/types'

const { setQueue, showFavorites, current } = useMusicPlayerCtx()
// 收藏数据不走 ctx：`useMusicFavorites` 是模块级单例，搜索结果里的收藏心和这里是同一份状态
const { favorites, removeFavorite, clearFavorites } = useMusicFavorites()

/** 从第 index 首开始播整份收藏 */
const playFrom = (index: number) => {
  if (!favorites.value.length) return
  // 收藏里存的是剥掉 url 的占位，播放器会自己按 resolver 取址，这里不需要（也不能）预先补地址
  void setQueue(favorites.value.slice() as Track[], index)
}

/**
 * 清空做成两步确认，但不用 `window.confirm`：
 * 收藏是用户一首首攒的，误点一下全没了没有撤销；而每次都弹系统弹窗又太重。
 * 5 秒没点第二下就自己撤销——一直亮着「确认清空」也是一种误点风险。
 */
const confirmingClear = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

const askClear = () => {
  if (confirmingClear.value) {
    clearFavorites()
    confirmingClear.value = false
    return
  }
  confirmingClear.value = true
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => { confirmingClear.value = false }, 5000)
}

onBeforeUnmount(() => { if (confirmTimer) clearTimeout(confirmTimer) })

/** 副标题：歌手 · 专辑。没有的项直接不占位，别显示一串「—」（同 PlayerBar 的 subtitle） */
const sub = (t: { artist?: string; album?: string }) => [t.artist, t.album].filter(Boolean).join(' · ')
</script>

<template>
  <!-- 窄屏抽屉的遮罩。宽屏是常驻栏，没有遮罩这回事 -->
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-200"
    leave-to-class="opacity-0"
  >
    <div
      v-if="showFavorites"
      class="lg:hidden fixed inset-0 z-30 bg-black/30"
      @click="showFavorites = false"
    />
  </Transition>

  <!--
    上边贴着 header（sticky h-16），下边给播放条留出 6rem——播放条是 fixed 的，
    压到它下面的那截列表点不着，比看不见更让人以为是坏的。
  -->
  <aside
    class="fixed left-0 top-16 bottom-24 z-40 flex flex-col overflow-hidden
           border-r border-gray-200 dark:border-gray-800 rounded-r-2xl
           bg-white/95 dark:bg-gray-900/95 backdrop-blur shadow-lg shadow-rose-100/40 dark:shadow-none
           transition-[width,transform] duration-300 ease-out"
    :class="showFavorites
      ? 'w-72 translate-x-0'
      : 'w-72 lg:w-14 -translate-x-full lg:translate-x-0'"
  >
    <!-- ── 收起态：只留一枚心和条数（窄屏这一支看不到，整块已经滑出屏幕了） ── -->
    <template v-if="!showFavorites">
      <button
        type="button"
        class="relative mt-4 mx-auto w-10 h-10 grid place-items-center rounded-xl
               text-primary-500 hover:bg-primary-50 dark:hover:bg-primary-950/40 transition-colors"
        title="展开我的收藏"
        aria-label="展开我的收藏"
        @click="showFavorites = true"
      >
        <UIcon name="i-heroicons-heart-solid" class="w-5 h-5" />
        <span
          v-if="favorites.length"
          class="absolute -top-1 -right-1 min-w-4 px-1 rounded-full bg-primary-500 text-white
                 text-[10px] leading-4 text-center tabular-nums"
        >
          {{ favorites.length > 99 ? '99+' : favorites.length }}
        </span>
      </button>
      <!-- 竖排的标题：窄轨上只有 3.5rem 宽，横着写一个字都放不下 -->
      <p class="mt-3 mx-auto text-[11px] tracking-widest text-gray-400 [writing-mode:vertical-rl]">
        我的收藏
      </p>
    </template>

    <!-- ── 展开态 ── -->
    <template v-else>
      <div class="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-gray-200 dark:border-gray-800">
        <UIcon name="i-heroicons-heart-solid" class="w-5 h-5 text-primary-500 shrink-0" />
        <span class="font-medium text-sm">我的收藏</span>
        <span class="text-xs text-gray-500 tabular-nums">{{ favorites.length }}</span>
        <div class="flex-1" />
        <UButton
          icon="i-heroicons-chevron-double-left"
          color="gray"
          variant="ghost"
          size="2xs"
          title="收起"
          aria-label="收起"
          @click="showFavorites = false"
        />
      </div>

      <div class="flex items-center gap-1 px-3 py-2 shrink-0">
        <UButton
          icon="i-heroicons-play"
          color="primary"
          variant="soft"
          size="xs"
          :disabled="!favorites.length"
          @click="playFrom(0)"
        >
          全部播放
        </UButton>
        <div class="flex-1" />
        <UButton
          :icon="confirmingClear ? 'i-heroicons-exclamation-triangle' : 'i-heroicons-trash'"
          :color="confirmingClear ? 'red' : 'gray'"
          variant="ghost"
          size="xs"
          :disabled="!favorites.length"
          @click="askClear"
        >
          {{ confirmingClear ? '确认清空' : '清空' }}
        </UButton>
      </div>

      <!-- 空态要把「怎么才会有东西」说清楚，只留一片空白等于让用户猜是不是坏了 -->
      <div v-if="!favorites.length" class="px-4 py-10 text-center">
        <UIcon name="i-heroicons-heart" class="w-8 h-8 text-gray-300 dark:text-gray-700" />
        <p class="mt-2 text-sm text-gray-500">还没有收藏任何歌曲</p>
        <p class="mt-1 text-xs text-gray-400">
          在搜索结果或播放条上点一下爱心就能收藏。收藏只记歌曲信息、不记播放地址，换天再来也不会失效。
        </p>
      </div>

      <!-- 收藏可能有几百首，这一块自己滚（整栏是 fixed 的，不会把页面撑长） -->
      <div v-else class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        <div
          v-for="(t, i) in favorites"
          :key="t.key"
          class="group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer
                 hover:bg-gray-50 dark:hover:bg-gray-800/60"
          :class="t.key === current?.key && 'bg-primary-50/70 dark:bg-primary-950/30'"
          @dblclick="playFrom(i)"
        >
          <!-- 封面必须走公共组件：有的图床（如 img1.kuwo.cn）浏览器直连**超时且不报错**，
               自己写 <img> 就是「有时候封面出不来」，要靠它降级到 /api/thumb -->
          <MusicCoverArt :src="t.cover" :alt="t.name" size-class="w-9 h-9" icon-class="w-4 h-4" />

          <div class="min-w-0 flex-1">
            <div
              class="truncate text-sm"
              :class="t.key === current?.key ? 'text-primary-600 dark:text-primary-400 font-medium' : ''"
            >
              {{ t.name }}
            </div>
            <div class="truncate text-xs text-gray-500">{{ sub(t) || '未知歌手' }}</div>
          </div>

          <!--
            按钮平时留着位置（`invisible` 不是 `hidden`）：显隐会让每行宽度跳一下。
            **窄屏一律常显**——触摸端没有 hover，藏起来就等于这两个功能不存在
            （同 PlayerBar 里音量条那条取舍）。
          -->
          <UButton
            icon="i-heroicons-play"
            color="gray"
            variant="ghost"
            size="2xs"
            class="lg:invisible lg:group-hover:visible"
            :title="`播放《${t.name}》`"
            aria-label="播放"
            @click.stop="playFrom(i)"
          />
          <UButton
            icon="i-heroicons-heart-solid"
            color="primary"
            variant="ghost"
            size="2xs"
            class="lg:invisible lg:group-hover:visible"
            title="取消收藏"
            aria-label="取消收藏"
            @click.stop="removeFavorite(t.key)"
          />
        </div>
      </div>
    </template>
  </aside>
</template>
