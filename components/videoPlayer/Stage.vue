<template>
  <UCard class="overflow-hidden">
    <template #header>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-play-circle" class="w-5 h-5 text-emerald-500" />
          <!-- 解析页会把剧名一起带过来（交接槽的 title），有就顶掉「播放器」这个泛标题 -->
          <span class="font-semibold truncate">{{ playlistTitle || '播放器' }}</span>
          <UBadge v-if="playlistTitle && playlist.length > 1" color="violet" variant="soft" size="xs">
            {{ currentVideoName }}
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

    <!--
      手势全部走 Pointer Events（鼠标/触摸同一套，见 useVideoGestures）：
      单击唤出控制栏、双击左右 ±5s、长按右侧临时 2x、横滑进度、全屏内竖滑音量/亮度。
      原来的 @click="togglePlay" 已移除——单击即暂停会让「只想看一眼进度」必然误触。
    -->
    <div
      ref="playerContainer"
      class="relative bg-black rounded-lg overflow-hidden group flex items-center justify-center select-none"
      :class="[
        { 'cursor-none': isPlaying && !showControls },
        isFullscreen ? 'fixed inset-0 z-50 rounded-none' : '',
      ]"
      :style="{ touchAction }"
      @mousemove="handleMouseMove"
      @mouseleave="hideControlsDelayed"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @contextmenu.prevent
    >
      <!-- 播放器已移除本地文件，只放网络地址，crossorigin 恒为 anonymous -->
      <video
        ref="videoEl"
        :key="videoKey"
        class="max-w-full max-h-full"
        :class="isFullscreen ? 'w-auto h-full' : 'w-full aspect-video'"
        :style="{ filter: brightness === 1 ? undefined : `brightness(${brightness})` }"
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

      <!-- 双击 ±5s 的落点反馈：不给这一下反馈的话，跳了 5 秒和「没点到」看起来一模一样 -->
      <Transition name="fade">
        <div
          v-if="seekFlash"
          :key="seekFlash.key"
          class="absolute inset-y-0 w-[30%] flex items-center justify-center pointer-events-none bg-white/10"
          :class="seekFlash.side === 'left' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'"
        >
          <div class="flex flex-col items-center text-white">
            <UIcon
              :name="seekFlash.side === 'left' ? 'i-heroicons-backward-solid' : 'i-heroicons-forward-solid'"
              class="w-8 h-8"
            />
            <span class="text-sm font-medium">5 秒</span>
          </div>
        </div>
      </Transition>

      <!-- 长按加速中的常驻提示：不显示的话松手前用户不知道自己触发了什么 -->
      <Transition name="fade">
        <div v-if="boostActive" class="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none">
          <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/70 text-white text-sm font-medium">
            <UIcon name="i-heroicons-forward-solid" class="w-4 h-4 animate-pulse" />
            {{ boostRate }}x 快进中
          </div>
        </div>
      </Transition>

      <!-- 滑动手势的中央读数（进度/音量/亮度共用一张） -->
      <Transition name="fade">
        <div v-if="gestureHud" class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="px-4 py-3 rounded-xl bg-black/70 text-white min-w-[140px] flex flex-col items-center gap-2">
            <div class="flex items-center gap-2">
              <UIcon
                :name="gestureHud.kind === 'seek' ? 'i-heroicons-arrows-right-left'
                  : gestureHud.kind === 'volume' ? volumeIcon : 'i-heroicons-sun'"
                class="w-5 h-5"
              />
              <span class="font-mono text-sm">{{ gestureHud.text }}</span>
              <span v-if="gestureHud.delta" class="text-violet-300 text-sm font-mono">{{ gestureHud.delta }}</span>
            </div>
            <div class="w-32 h-1 bg-white/25 rounded-full overflow-hidden">
              <div class="h-full bg-violet-400" :style="{ width: (gestureHud.percent ?? 0) + '%' }" />
            </div>
          </div>
        </div>
      </Transition>

      <!-- 锁定按钮：锁上后它是唯一还能点的东西，所以点画面任意处都会让它露 3 秒 -->
      <Transition name="fade">
        <button
          v-if="isLocked ? showLockBtn : (showControls || !isPlaying)"
          data-no-gesture
          class="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/55 text-white
                 flex items-center justify-center hover:bg-black/75 transition-colors"
          :title="isLocked ? '解锁' : '锁定屏幕（屏蔽手势与控制栏）'"
          @click="toggleLock"
        >
          <UIcon :name="isLocked ? 'i-heroicons-lock-closed' : 'i-heroicons-lock-open'" class="w-5 h-5" />
        </button>
      </Transition>

      <Transition name="slide-up">
        <div
          v-show="controlsVisible"
          data-no-gesture
          class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12"
          @click.stop
        >
          <!-- 进度条 -->
          <div
            ref="progressBar"
            class="relative h-1.5 bg-white/30 rounded-full cursor-pointer group/progress mb-3 touch-none"
            @pointerdown="startSeek"
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
                  :title="autoBestRate
                    ? `自动最佳倍速：上限 ${autoRateCap}x，当前带宽下实际 ${playbackRate}x` : `倍速 ${playbackRate}x`"
                  @click="showSpeedMenu = !showSpeedMenu"
                >
                  <!-- 「/上限」只要开着自动就常显：早先加了 playbackRate !== autoRateCap 的条件，
                       生效倍速一爬到上限后缀就消失，控制栏上反而看不出自动还开着、上限是几 -->
                  {{ playbackRate }}x<span v-if="autoBestRate" class="text-white/50">/{{ autoRateCap }}</span>
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
  hlsStats, playlist, playlistTitle, hasPrev, hasNext,
  currentVideoName, volumeIcon, supportsPiP, canDownload,
  togglePlay, skip, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate,
  toggleFullscreen, togglePiP, handleMouseMove, hideControlsDelayed,
  // 手势层（useVideoGestures）
  isLocked, showLockBtn, toggleLock, brightness, gestureHud, seekFlash, touchAction, controlsVisible,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, boostActive, boostRate,
  playPrev, playNext,
  isDownloading, downloadProgress, downloadVideo, cancelDownload,
  onTimeUpdate, onLoadedMetadata, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onVolumeChange, onVideoError,
} = useVideoPlayerCtx()

// 倍速菜单点击外部关闭
onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })
</script>
