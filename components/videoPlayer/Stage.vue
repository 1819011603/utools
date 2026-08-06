<template>
  <UCard class="overflow-hidden">
    <template #header>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-play-circle" class="w-5 h-5 text-emerald-500" />
          <!-- 解析页会把剧名一起带过来（交接槽的 title），有就顶掉「播放器」这个泛标题 -->
          <span class="font-semibold truncate">{{ playlistTitle || '播放器' }}</span>
          <UBadge v-if="playlistTitle && playlist.length > 1" color="violet" variant="soft" size="xs">
            {{ getVideoName(videoUrl, currentIndex) }}
          </UBadge>
          <UBadge :color="isHls ? 'violet' : 'blue'" variant="soft" size="xs">
            {{ isHls ? 'HLS/M3U8' : 'MP4' }}
          </UBadge>
        </div>
        <div class="flex items-center gap-2 text-sm text-gray-500">
          <template v-if="hlsStats">
            <UBadge color="green" variant="soft" size="xs">缓冲: {{ hlsStats.buffered.toFixed(1) }}s</UBadge>
            <UBadge color="cyan" variant="soft" size="xs">{{ hlsStats.level }}</UBadge>
          </template>
        </div>
      </div>
    </template>

    <div
      ref="playerContainer"
      class="relative bg-black rounded-lg overflow-hidden group flex items-center justify-center"
      :class="[
        { 'cursor-none': isPlaying && !showControls },
        isFullscreen ? 'fixed inset-0 z-50 rounded-none' : '',
      ]"
      @mousemove="handleMouseMove"
      @mouseleave="hideControlsDelayed"
      @click="togglePlay"
      @dblclick="toggleFullscreen"
    >
      <!-- 播放器已移除本地文件，只放网络地址，crossorigin 恒为 anonymous -->
      <video
        ref="videoEl"
        :key="videoKey"
        class="max-w-full max-h-full"
        :class="isFullscreen ? 'w-auto h-full' : 'w-full aspect-video'"
        crossorigin="anonymous"
        playsinline
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
        @loadeddata="onLoadedData"
        @play="isPlaying = true"
        @pause="isPlaying = false"
        @ended="onVideoEnded"
        @waiting="onWaiting"
        @canplay="onCanPlay"
        @canplaythrough="onCanPlayThrough"
        @seeking="onSeeking"
        @seeked="onSeeked"
        @playing="onPlaying"
        @volumechange="onVolumeChange"
        @error="onVideoError"
      />

      <div v-if="isBuffering || isResolvingUrl" class="absolute inset-0 flex items-center justify-center bg-black/30">
        <div class="flex flex-col items-center gap-2">
          <UIcon name="i-heroicons-arrow-path" class="w-12 h-12 text-white animate-spin" />
          <span class="text-white text-sm">
            {{ isResolvingUrl ? '正在获取播放地址...' : isProbing ? '正在探测连接方式...' : '加载中...' }}
          </span>
        </div>
      </div>

      <Transition name="fade">
        <div v-if="showPlayIcon" class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center">
            <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-10 h-10 text-white" />
          </div>
        </div>
      </Transition>

      <!-- 全屏时固定显示的退出全屏按钮（控制栏隐藏时也可见） -->
      <Transition name="fade">
        <button
          v-if="isFullscreen && !showControls"
          class="absolute top-3 right-3 z-10 text-white/60 hover:text-white transition-colors bg-black/30 rounded-full p-1.5"
          title="退出全屏"
          @click.stop="toggleFullscreen"
        >
          <UIcon name="i-heroicons-arrows-pointing-in" class="w-5 h-5" />
        </button>
      </Transition>

      <Transition name="slide-up">
        <div
          v-show="showControls || !isPlaying"
          class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12"
          @click.stop
        >
          <!-- 进度条 -->
          <div
            ref="progressBar"
            class="relative h-1.5 bg-white/30 rounded-full cursor-pointer group/progress mb-3"
            @mousedown="startSeek"
            @mousemove="updateHoverTime"
            @mouseleave="hoverTime = null"
          >
            <div class="absolute h-full bg-white/40 rounded-full" :style="{ width: bufferedPercent + '%' }" />
            <div class="absolute h-full bg-violet-500 rounded-full transition-all" :style="{ width: progressPercent + '%' }" />
            <div
              class="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity"
              :style="{ left: `calc(${progressPercent}% - 8px)` }"
            />
            <div
              v-if="hoverTime !== null"
              class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2 pointer-events-none"
              :style="{ left: hoverPercent + '%' }"
            >
              {{ formatTime(hoverTime) }}
            </div>
            <div
              v-else-if="seekPreviewTime !== null"
              class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2"
              :style="{ left: seekPreviewPercent + '%' }"
            >
              {{ formatTime(seekPreviewTime) }}
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 flex-wrap min-w-0">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <button
                v-if="playlist.length > 1"
                class="text-white transition-colors"
                :class="hasPrev ? 'hover:text-violet-400' : 'opacity-40 cursor-not-allowed'"
                :disabled="!hasPrev"
                title="上一集"
                @click="playPrev"
              >
                <UIcon name="i-heroicons-backward-solid" class="w-5 h-5" />
              </button>

              <button class="text-white hover:text-violet-400 transition-colors" @click="togglePlay">
                <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-6 h-6" />
              </button>

              <button
                v-if="playlist.length > 1"
                class="text-white transition-colors"
                :class="hasNext ? 'hover:text-violet-400' : 'opacity-40 cursor-not-allowed'"
                :disabled="!hasNext"
                title="下一集"
                @click="playNext"
              >
                <UIcon name="i-heroicons-forward-solid" class="w-5 h-5" />
              </button>

              <button class="text-white hover:text-violet-400 transition-colors" title="后退 10 秒" @click="skip(-10)">
                <UIcon name="i-heroicons-backward" class="w-5 h-5" />
              </button>
              <button class="text-white hover:text-violet-400 transition-colors" title="前进 10 秒" @click="skip(10)">
                <UIcon name="i-heroicons-forward" class="w-5 h-5" />
              </button>

              <div class="flex items-center gap-2 group/volume">
                <button class="text-white hover:text-violet-400 transition-colors" @click="toggleMute">
                  <UIcon :name="volumeIcon" class="w-5 h-5" />
                </button>
                <div class="w-0 group-hover/volume:w-20 overflow-hidden transition-all duration-200">
                  <input
                    type="range" min="0" max="1" step="0.05"
                    :value="volume"
                    class="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer accent-violet-500"
                    @input="setVolume"
                  />
                </div>
              </div>

              <span class="text-white text-sm font-mono shrink-0">
                {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
              </span>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <div ref="speedMenuRef" class="relative">
                <button
                  class="text-white hover:text-violet-400 transition-colors px-2 py-1 rounded text-sm font-medium"
                  :title="autoBestRate && playbackRate !== autoRateCap
                    ? `自动最佳倍速：上限 ${autoRateCap}x，当前带宽下实际 ${playbackRate}x` : ''"
                  @click="showSpeedMenu = !showSpeedMenu"
                >
                  {{ playbackRate }}x<span v-if="autoBestRate && playbackRate !== autoRateCap" class="text-white/50">/{{ autoRateCap }}</span>
                </button>
                <Transition name="fade">
                  <div v-if="showSpeedMenu" class="absolute bottom-full right-0 mb-2 bg-black/90 rounded-lg overflow-hidden min-w-[80px]">
                    <button
                      v-for="rate in PLAYBACK_RATES"
                      :key="rate"
                      class="block w-full px-4 py-2 text-sm text-white hover:bg-violet-500/50 transition-colors text-center"
                      :class="{ 'bg-violet-500': desiredRate === rate }"
                      @click="setPlaybackRate(rate)"
                    >
                      {{ rate }}x
                    </button>
                  </div>
                </Transition>
              </div>

              <template v-if="canDownload">
                <template v-if="isDownloading">
                  <span class="text-white text-xs font-medium w-8 text-center">{{ downloadProgress }}%</span>
                  <button class="text-amber-400 hover:text-red-400 transition-colors" title="取消下载" @click="cancelDownload">
                    <UIcon name="i-heroicons-x-circle" class="w-5 h-5" />
                  </button>
                </template>
                <button v-else class="text-white hover:text-violet-400 transition-colors" title="下载视频" @click="downloadVideo()">
                  <UIcon name="i-heroicons-arrow-down-tray" class="w-5 h-5" />
                </button>
              </template>

              <button v-if="supportsPiP" class="text-white hover:text-violet-400 transition-colors" title="画中画" @click="togglePiP">
                <UIcon name="i-heroicons-rectangle-stack" class="w-5 h-5" />
              </button>

              <button class="text-white hover:text-violet-400 transition-colors" title="全屏" @click="toggleFullscreen">
                <UIcon
                  :name="isFullscreen ? 'i-heroicons-arrows-pointing-in' : 'i-heroicons-arrows-pointing-out'"
                  class="w-5 h-5"
                />
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'

const {
  videoEl, playerContainer, progressBar, speedMenuRef, videoKey, videoUrl,
  isHls, isPlaying, isBuffering, isResolvingUrl, isProbing, isFullscreen,
  showControls, showPlayIcon, showSpeedMenu,
  currentTime, duration, volume, playbackRate, desiredRate, autoBestRate, autoRateCap,
  progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, hoverTime, hoverPercent,
  hlsStats, playlist, currentIndex, playlistTitle, hasPrev, hasNext,
  getVideoName, volumeIcon, supportsPiP, canDownload,
  togglePlay, skip, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate,
  toggleFullscreen, togglePiP, handleMouseMove, hideControlsDelayed,
  playPrev, playNext,
  isDownloading, downloadProgress, downloadVideo, cancelDownload,
  onTimeUpdate, onLoadedMetadata, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onVolumeChange, onVideoError,
} = useVideoPlayerCtx()

// 倍速菜单点击外部关闭
onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })
</script>
