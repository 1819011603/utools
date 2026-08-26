<script setup lang="ts">
/**
 * 播放队列：**右侧滑出的抽屉**（网易云那种「播放列表」）。
 *
 * 为什么不摆在页面流里：队列是**看一眼就关**的东西，摆在页面里就得先滚到它那儿，
 * 而搜索结果一长它就被推到几屏之外；一次搜索能排进几十首，铺开还会把页面顶长。
 * 左边是常驻的收藏（`SideLibrary`），右边是随手开合的队列——两侧分工照的是网易云/QQ 音乐。
 *
 * 盖在内容上而不是把内容推开（跟左边那条相反）：队列是临时看的，
 * 每开一次就把整页版式挪一下，比它本身还烦。
 *
 * **收起时不卸载**（用位移而不是 `v-if`）：卸载就没有滑出滑入，一开一关是「啪」地闪现；
 * 几十行的列表留在 DOM 里不值一提。
 *
 * 不接收 props，自己从 ctx 解构（同 videoPlayer 那套约定）。
 * 队列里存的是**剥掉 url 的占位**（见 types.ts 的 toStorableTrack）——
 * 地址约 20 分钟就过期，所以这里显示的曲目多半没有 `url`，点了才现取。
 * 因此**不能按「有没有 url」判断能不能点**，那会把整份队列锁死。
 */
import { formatTrackTime } from '~/composables/musicPlayer/display'

const { queue, queueIndex, isPlaying, showQueue, playAt, removeAt, clearQueue } = useMusicPlayerCtx()

const listEl = ref<HTMLElement>()

/**
 * 切歌时把当前这首滚进视野。用 `nearest` 而不是 `center`——
 * 已经在视野里就别动，否则每次切歌整块跳一下（同 PlaylistPanel 那条教训）。
 * 抽屉打开时也要滚一次：收起期间切过的歌，打开时该直接看到，而不是停在上次的位置。
 */
watch([queueIndex, showQueue], async () => {
  if (!showQueue.value) return
  await nextTick()
  listEl.value?.querySelector('[data-current="1"]')?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <!-- 窄屏抽屉的遮罩：那边它几乎占满屏幕，得有个「点空白关掉」的出口 -->
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-200"
    leave-to-class="opacity-0"
  >
    <div
      v-if="showQueue"
      class="lg:hidden fixed inset-0 z-30 bg-black/30"
      @click="showQueue = false"
    />
  </Transition>

  <!-- 上下留白同左侧那条：上边贴着 header，下边给 fixed 播放条让位，否则最后几行点不着 -->
  <aside
    class="fixed right-0 top-16 bottom-24 z-40 w-80 max-w-[85vw] flex flex-col overflow-hidden
           border-l border-gray-200 dark:border-gray-800 rounded-l-2xl
           bg-white/95 dark:bg-gray-900/95 backdrop-blur shadow-lg shadow-rose-100/40 dark:shadow-none
           transition-transform duration-300 ease-out"
    :class="showQueue ? 'translate-x-0' : 'translate-x-full'"
    :aria-hidden="!showQueue"
  >
    <div class="flex items-center gap-2 px-4 h-12 shrink-0 border-b border-gray-200 dark:border-gray-800">
      <UIcon name="i-heroicons-queue-list" class="w-5 h-5 text-primary-500 shrink-0" />
      <span class="font-medium text-sm">播放列表</span>
      <UBadge v-if="queue.length" color="gray" variant="soft" size="xs">
        {{ queueIndex + 1 }} / {{ queue.length }}
      </UBadge>
      <div class="flex-1" />
      <UButton
        v-if="queue.length"
        size="2xs"
        color="gray"
        variant="ghost"
        @click="clearQueue"
      >
        清空
      </UButton>
      <UButton
        icon="i-heroicons-chevron-double-right"
        size="2xs"
        color="gray"
        variant="ghost"
        title="收起"
        aria-label="收起"
        @click="showQueue = false"
      />
    </div>

    <div v-if="!queue.length" class="px-4 py-10 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300 dark:text-gray-700" />
      <p>队列是空的</p>
      <p class="text-xs mt-1 text-gray-400">搜一首歌，点音质档就会把整份结果排进来</p>
    </div>

    <div v-else ref="listEl" class="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
      <div
        v-for="(t, i) in queue"
        :key="t.key + i"
        :data-current="i === queueIndex ? '1' : undefined"
        class="group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer
               hover:bg-gray-50 dark:hover:bg-gray-800/60"
        :class="i === queueIndex && 'bg-primary-50/70 dark:bg-primary-950/30'"
        @dblclick="playAt(i)"
      >
        <UButton
          :icon="i === queueIndex && isPlaying ? 'i-heroicons-speaker-wave' : 'i-heroicons-play'"
          :color="i === queueIndex ? 'primary' : 'gray'"
          variant="ghost"
          size="2xs"
          :title="`播放《${t.name}》`"
          :aria-label="`播放 ${t.name}`"
          @click.stop="playAt(i)"
        />
        <div class="min-w-0 flex-1">
          <div
            class="truncate text-sm"
            :class="i === queueIndex ? 'text-primary-600 dark:text-primary-400 font-medium' : ''"
          >
            {{ t.name }}
          </div>
          <div class="truncate text-xs text-gray-500">
            {{ [t.artist, t.album].filter(Boolean).join(' · ') }}
          </div>
        </div>
        <span v-if="t.duration" class="text-xs tabular-nums text-gray-400 shrink-0">
          {{ formatTrackTime(t.duration) }}
        </span>
        <!-- 移除按钮宽屏才靠 hover 露出：触摸端没有 hover，藏起来等于这功能不存在 -->
        <UButton
          icon="i-heroicons-x-mark"
          color="gray"
          variant="ghost"
          size="2xs"
          class="lg:invisible lg:group-hover:visible"
          title="从队列移除"
          aria-label="从队列移除"
          @click.stop="removeAt(i)"
        />
      </div>
    </div>
  </aside>
</template>
