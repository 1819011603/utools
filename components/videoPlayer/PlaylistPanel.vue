<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
        {{ playlistTitle || '播放列表' }}
        <span v-if="playlistTitle" class="font-normal text-gray-400">· 共 {{ playlist.length }} 集</span>
        <!-- Toast 会消失，这里常驻一个上次刷新时间，随时能确认刷没刷过 -->
        <span v-if="lastRefreshAt" class="font-normal text-xs text-gray-400">
          · 已于 {{ formatClock(lastRefreshAt) }} 刷新
        </span>
      </span>
      <div class="flex gap-2">
        <!-- 带签名的地址会过期，用交接槽里的来源就地重解析，不用回解析页 -->
        <UButton
          v-if="playlistSource"
          size="xs"
          variant="soft"
          color="violet"
          icon="i-heroicons-arrow-path"
          :loading="isRefreshingLinks"
          title="链接过期播不了时，用同一来源和线路重新解析并替换"
          @click="refreshPlaylistLinks"
        >
          刷新链接
        </UButton>
        <UButton size="xs" variant="soft" @click="clearAllProgress">清除进度</UButton>
        <UButton size="xs" variant="ghost" color="red" @click="clearPlaylist">清空列表</UButton>
      </div>
    </div>

    <!-- 网格排布：几十集竖着列要滚很久，横着摆一眼能扫到目标集 -->
    <div ref="scroller" class="max-h-80 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
      <!-- 列数给足：一屏能扫到的集数越多越省事，超长剧尤其明显 -->
      <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2">
        <div
          v-for="(item, index) in playlist"
          :key="index"
          :ref="el => { if (index === currentIndex) curEl = el as HTMLElement }"
          class="rounded cursor-pointer transition-colors text-sm text-center px-2 py-2 truncate"
          :class="[
            index === currentIndex
              ? 'bg-violet-500 text-white font-medium'
              : 'bg-white dark:bg-gray-700 hover:bg-violet-100 dark:hover:bg-gray-600',
            // 看过的（有进度记录）标成琥珀色，跟没看过的区分开
            index !== currentIndex && getSavedProgress(item) > 0 ? 'text-amber-600 dark:text-amber-400' : '',
          ]"
          :title="getSavedProgress(item) > 0
            ? `${getVideoName(item, index)}（看到 ${formatTime(getSavedProgress(item))}）`
            : getVideoName(item, index)"
          @click="playByIndex(index)"
        >
          <UIcon
            v-if="index === currentIndex && isPlaying"
            name="i-heroicons-speaker-wave"
            class="w-3.5 h-3.5 inline-block mr-1 align-text-bottom"
          />
          {{ getVideoName(item, index) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  playlist, currentIndex, playlistTitle, playlistSource, lastRefreshAt, isRefreshingLinks,
  isPlaying,
  getSavedProgress, getVideoName, playByIndex,
  refreshPlaylistLinks, clearAllProgress, clearPlaylist,
} = useVideoPlayerCtx()

/**
 * 把当前集滚进视野（与全屏选集抽屉 EpisodeOverlay 同样的处置）。
 *
 * 这块是 `max-h-80` 的滚动区，78 集的剧要滚三四屏。切集后当前那格常常落在视野外，
 * 于是「现在是第几集」得靠自己找那枚紫格子——用户的原话是「不知道播到第多少集了」。
 * `block: 'nearest'` 而不是 'center'：已经在视野里就别动，否则每次切集整块都跳一下。
 */
const curEl = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const scrollCurrentIntoView = () => nextTick(() => curEl.value?.scrollIntoView({ block: 'nearest' }))
watch([currentIndex, () => playlist.value.length], scrollCurrentIntoView, { immediate: true })

/*
 * **这张卡默认是折起来的**（`openPlaylist = ref(false)`），而 CollapseCard 用的是 `v-show`
 * —— 元素在 DOM 里但没有布局，此时 `scrollIntoView` 是彻底的空操作。
 * 于是「切集时滚一下」全发生在看不见的时候，用户真正展开面板那一刻反而没人滚，
 * 当前集照旧躺在视野外（差点当成已经修好，实测量到这个滚动区 clientHeight 恒为 0 才发现）。
 * 展开那一下没有任何事件可听（开合状态在父组件里），所以只能观察元素自己。
 *
 * **用 ResizeObserver 而不是 IntersectionObserver**：后者要等元素进入**视口**才触发，
 * 而这张卡在长页面里通常还在首屏下面 —— 展开了却不在视口里，一次都不会回调（踩过，
 * 测出来是「展开之后 scrollTop 仍为 0、当前集在视野外」）。尺寸从 0 变成 320 才是
 * 「现在滚才有意义」的准确信号，跟页面滚到哪儿无关。
 */
onMounted(() => {
  if (!scroller.value || typeof ResizeObserver === 'undefined') return
  let wasVisible = scroller.value.clientHeight > 0
  const ro = new ResizeObserver(() => {
    const visible = (scroller.value?.clientHeight ?? 0) > 0
    if (visible && !wasVisible) scrollCurrentIntoView()   // 只在「刚露出来」这一下滚，别每次尺寸抖动都抢滚动位置
    wasVisible = visible
  })
  ro.observe(scroller.value)
  onUnmounted(() => ro.disconnect())
})
</script>
