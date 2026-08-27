<template>
  <Transition name="sheet">
    <div
      v-if="showEpisodes && playlist.length > 1"
      data-no-gesture
      class="absolute inset-0 z-20 flex flex-col bg-black/55 backdrop-blur-[2px]"
      @click="onBlankClick"
    >
      <!-- 顶部一行：剧名 + 进度 + 关闭。空白处点哪都能关（见 onBlankClick） -->
      <div class="flex items-center gap-3 px-4 pt-3 pb-2 shrink-0 text-white">
        <span class="font-semibold truncate">{{ playlistTitle || '选集' }}</span>
        <span class="text-xs text-white/60 shrink-0">共 {{ playlist.length }} 集</span>
        <button class="ml-auto p-2 rounded-lg hover:bg-white/10 active:scale-90 transition-all shrink-0" title="关闭" @click="showEpisodes = false">
          <UIcon name="i-heroicons-x-mark" class="w-6 h-6" />
        </button>
      </div>

      <!--
        格子本身**不给底色**，只有当前集用一条下划线标出来——这是腾讯那版最值得抄的地方：
        画面透过来还看得见，选集面板就不像是「盖了一块板子」，而是浮在片子上。
        原来那版给每个格子都上了 bg-white/10，几十个灰块糊成一片，画面也全挡住了。
      -->
      <div class="flex-1 overflow-y-auto px-3 pb-4">
        <div class="grid grid-cols-5 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-10 gap-x-1 gap-y-1">
          <button
            v-for="(item, index) in playlist"
            :key="index"
            :ref="el => { if (index === currentIndex) curEl = el as HTMLElement }"
            class="relative py-3 px-1 rounded-md text-sm transition-colors group/ep"
            :class="index === currentIndex
              ? 'text-white font-semibold'
              : getSavedProgress(item) > 0
                ? 'text-amber-300/80 hover:bg-white/10'
                : 'text-white/75 hover:bg-white/10'"
            :title="getVideoName(item, index)"
            @click="pick(index)"
          >
            <span class="block truncate">{{ getVideoName(item, index) }}</span>
            <!-- 当前集：底部一条渐变横杠（腾讯是纯白，这里跟播放器其余部分统一成紫粉） -->
            <span
              v-if="index === currentIndex"
              class="absolute bottom-1 left-1/2 -translate-x-1/2 w-7 h-[3px] rounded-full
                     bg-gradient-to-r from-violet-400 to-fuchsia-400 shadow-[0_0_8px_rgba(167,139,250,.9)]"
            />
            <!-- 看过但没看完：右上角一个小点，比写「已看」省地方 -->
            <span
              v-else-if="getSavedProgress(item) > 0"
              class="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-400/80"
            />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 播放器内嵌的选集面板（版式参照腾讯视频全屏选集）。
 *
 * 页面下方那份列表在全屏时根本够不着，而「看完这集换下一集」正是全屏里最高频的动作。
 * 挂在播放器容器内（`position: absolute`），全屏时跟着一起进全屏。
 */
const {
  playlist, currentIndex, playlistTitle, showEpisodes,
  getSavedProgress, getVideoName, playByIndex,
} = useVideoPlayerCtx()

const curEl = ref<HTMLElement>()

/**
 * 点空白即关。判据是「这一下有没有落在按钮上」，而不是 `@click.self`——
 * 后者只认根元素本身，标题栏、滚动容器、格子之间的缝隙、列表下方的空白全都不算，
 * 结果就是只有边缘那一圈能关，用户只能去够右上角那个 X。
 */
const onBlankClick = (e: MouseEvent) => {
  if ((e.target as HTMLElement | null)?.closest?.('button')) return
  showEpisodes.value = false
}

const pick = (index: number) => {
  showEpisodes.value = false
  void playByIndex(index)
}

// 打开时把当前集滚到可见处：七十多集的剧默认停在第一屏，每次都得自己找
watch(showEpisodes, async (open) => {
  if (!open) return
  await nextTick()
  curEl.value?.scrollIntoView({ block: 'center' })
})
</script>

<style scoped>
/* 从下往上铺开，配合半透明底：像是从播放器里长出来的，而不是盖上去一块板 */
.sheet-enter-active { transition: opacity .2s ease, transform .3s cubic-bezier(.2, 1.1, .4, 1); }
.sheet-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.sheet-enter-from,
.sheet-leave-to { opacity: 0; transform: translateY(16px); }
</style>
