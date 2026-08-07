<template>
  <Transition name="drawer">
    <div
      v-if="showEpisodes && playlist.length > 1"
      data-no-gesture
      class="absolute inset-y-0 right-0 z-10 w-full sm:w-80 bg-black/85 backdrop-blur-md
             ring-1 ring-white/10 flex flex-col text-white"
    >
      <div class="flex items-center gap-2 px-3 py-2.5 border-b border-white/10 shrink-0">
        <UIcon name="i-heroicons-queue-list" class="w-5 h-5 text-violet-400" />
        <span class="font-semibold text-sm truncate">{{ playlistTitle || '选集' }}</span>
        <span class="text-xs text-white/50 shrink-0">{{ currentIndex + 1 }}/{{ playlist.length }}</span>
        <button class="ml-auto p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="关闭" @click="showEpisodes = false">
          <UIcon name="i-heroicons-x-mark" class="w-5 h-5" />
        </button>
      </div>

      <div ref="listEl" class="flex-1 overflow-y-auto p-3">
        <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
          <button
            v-for="(item, index) in playlist"
            :key="index"
            :ref="el => { if (index === currentIndex) curEl = el as HTMLElement }"
            class="px-2 py-2.5 rounded-lg text-xs truncate transition-all active:scale-95"
            :class="index === currentIndex
              ? 'bg-gradient-to-r from-violet-600 to-fuchsia-500 font-semibold shadow-lg shadow-violet-900/40'
              : getSavedProgress(item) > 0
                ? 'bg-white/10 text-amber-300 hover:bg-white/20'
                : 'bg-white/10 hover:bg-white/20'"
            :title="getVideoName(item, index)"
            @click="pick(index)"
          >
            {{ getVideoName(item, index) }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 播放器内嵌的选集抽屉。
 *
 * 页面下方那份列表在全屏时根本够不着，而「看完这集换下一集」正是全屏里最高频的动作。
 * 挂在播放器容器内（`position: absolute`），全屏时跟着一起进全屏。
 */
const {
  playlist, currentIndex, playlistTitle, showEpisodes,
  getSavedProgress, getVideoName, playByIndex,
} = useVideoPlayerCtx()

const listEl = ref<HTMLElement>()
const curEl = ref<HTMLElement>()

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
.drawer-enter-active { transition: opacity .2s ease, transform .3s cubic-bezier(.2, 1.2, .4, 1); }
.drawer-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.drawer-enter-from,
.drawer-leave-to { opacity: 0; transform: translateX(100%); }
</style>
