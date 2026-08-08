<template>
  <Transition name="slide-down">
    <div
      v-show="controlsVisible"
      data-no-gesture
      class="absolute top-0 left-0 right-0 z-[5] bg-gradient-to-b from-black/80 to-transparent px-3 pt-3 pb-10
             flex items-center gap-2 text-white"
      @pointerdown="keepControlsAlive"
      @pointerup="keepControlsAlive"
    >
      <!-- 全屏里没有浏览器的返回键，退出全屏得有个显眼的入口（横屏握持时右上角够不着） -->
      <button
        v-if="isFullscreen"
        class="p-2 rounded-lg hover:bg-white/15 active:scale-90 transition-all shrink-0"
        title="退出全屏"
        @click="toggleFullscreen"
      >
        <UIcon name="i-heroicons-arrow-left" class="w-6 h-6" />
      </button>

      <div class="min-w-0 flex-1">
        <div class="font-semibold truncate drop-shadow">{{ playlistTitle || '放映厅' }}</div>
        <div class="text-xs text-white/70 truncate">
          <span v-if="playlist.length > 1">{{ currentVideoName }} · 第 {{ currentIndex + 1 }}/{{ playlist.length }} 集</span>
          <span v-else>{{ currentVideoName }}</span>
        </div>
      </div>

      <button
        v-if="playlist.length > 1"
        class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium shrink-0 transition-all active:scale-95"
        :class="showEpisodes ? 'bg-violet-500/80' : 'bg-white/10 hover:bg-white/20'"
        title="选集"
        @click="showEpisodes = !showEpisodes"
      >
        <UIcon name="i-heroicons-queue-list" class="w-5 h-5" />
        <span class="hidden sm:inline">选集</span>
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面顶部的信息条，与底部控制栏**同进同出**（共用 `controlsVisible`）。
 *
 * 全屏时页面上的标题栏整个看不见，「在看什么、第几集」就此消失；
 * 而这恰恰是切集前最需要确认的两件事，所以它必须画在画面里。
 */
const {
  playlistTitle, currentVideoName, playlist, currentIndex,
  showEpisodes, isFullscreen, controlsVisible,
  toggleFullscreen, keepControlsAlive,
} = useVideoPlayerCtx()
</script>

<style scoped>
.slide-down-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-down-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-down-enter-from,
.slide-down-leave-to { opacity: 0; transform: translateY(-24px); }
</style>
