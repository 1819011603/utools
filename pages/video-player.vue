<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频播放器</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">支持 M3U8/MP4 播放，并发加载分片，倍速/音量调整</p>
      </div>
    </div>

    <!-- 视频输入 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-link" class="w-5 h-5 text-violet-500" />
          <span class="font-semibold">视频源</span>
          <UBadge v-if="playlist.length > 1" color="green" variant="soft" size="xs">
            播放列表: {{ currentIndex + 1 }}/{{ playlist.length }}
          </UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <!-- URL 输入 - 支持多行 -->
        <UFormGroup label="视频地址" help="支持多个链接，每行一个，自动按顺序播放">
          <UTextarea 
            v-model="videoUrlInput" 
            placeholder="输入 m3u8 或 mp4 视频地址...&#10;支持多个链接，每行一个"
            :rows="3"
            @keydown.ctrl.enter="parseAndLoad"
          />
        </UFormGroup>
        
        <div class="flex gap-2 flex-wrap">
          <UButton color="primary" @click="parseAndLoad" :disabled="!videoUrlInput.trim()" :loading="isLoading">
            <UIcon name="i-heroicons-play" class="w-4 h-4 mr-1" />
            解析并播放
          </UButton>
          <UCheckbox v-model="autoFullscreen" label="加载后自动全屏" />
          <UCheckbox v-model="useProxy" label="使用跨域代理" />
        </div>
        
        <!-- 片头片尾跳过设置 -->
        <div class="flex gap-4 flex-wrap items-end">
          <UFormGroup label="跳过片头" help="视频开始时自动跳过的时间">
            <div class="flex items-center gap-2">
              <UInput 
                v-model.number="skipIntro" 
                type="number" 
                :min="0" 
                :max="300"
                :step="5"
                class="w-24"
                @change="saveState"
              />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
          <UFormGroup label="跳过片尾" help="剩余时间少于此值时自动下一集">
            <div class="flex items-center gap-2">
              <UInput 
                v-model.number="skipOutro" 
                type="number" 
                :min="0" 
                :max="300"
                :step="5"
                class="w-24"
                @change="saveState"
              />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
        </div>

        <!-- 播放列表 -->
        <div v-if="playlist.length > 1" class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">播放列表</span>
            <div class="flex gap-2">
              <UButton size="xs" variant="soft" @click="clearAllProgress">清除进度</UButton>
              <UButton size="xs" variant="ghost" color="red" @click="clearPlaylist">清空列表</UButton>
            </div>
          </div>
          <div class="max-h-40 overflow-y-auto space-y-1 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div
              v-for="(item, index) in playlist"
              :key="index"
              class="flex items-center gap-2 p-2 rounded cursor-pointer transition-colors text-sm group/item"
              :class="index === currentIndex ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'hover:bg-gray-100 dark:hover:bg-gray-700'"
              @click="playByIndex(index)"
            >
              <UIcon 
                :name="index === currentIndex && isPlaying ? 'i-heroicons-speaker-wave' : 'i-heroicons-play'" 
                class="w-4 h-4 shrink-0"
              />
              <span class="flex-1 truncate">{{ getVideoName(item, index) }}</span>
              <span v-if="getSavedProgress(item) > 0" class="text-xs text-gray-400">
                {{ formatTime(getSavedProgress(item)) }}
              </span>
              <button
                v-if="item.startsWith('http') && !isDownloading"
                class="opacity-0 group-hover/item:opacity-100 p-1 rounded hover:bg-violet-500/30 transition-all shrink-0"
                title="下载"
                @click.stop="downloadVideo(item)"
              >
                <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4" />
              </button>
              <UBadge v-if="index === currentIndex" color="violet" variant="soft" size="xs">当前</UBadge>
            </div>
          </div>
        </div>

        <!-- 本地文件 -->
        <div class="text-center text-sm text-gray-500 dark:text-gray-400">或</div>
        
        <FileUpload
          accept="video/*,.m3u8,.mp4,.webm,.mkv"
          accept-text="视频文件 (MP4, WebM, MKV, M3U8)"
          icon="i-heroicons-film"
          :multiple="true"
          @files="handleLocalFiles"
        />

        <!-- 示例链接 -->
        <div class="flex flex-wrap gap-2">
          <span class="text-sm text-gray-500">示例：</span>
          <UButton 
            v-for="example in exampleUrls" 
            :key="example.url"
            size="xs" 
            variant="soft" 
            @click="loadExample(example.url)"
          >
            {{ example.name }}
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- 播放器 -->
    <UCard v-if="isVideoLoaded" class="overflow-hidden">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-play-circle" class="w-5 h-5 text-emerald-500" />
            <span class="font-semibold">播放器</span>
            <UBadge :color="isHls ? 'violet' : 'blue'" variant="soft" size="xs">
              {{ isHls ? 'HLS/M3U8' : 'MP4' }}
            </UBadge>
          </div>
          <div class="flex items-center gap-2 text-sm text-gray-500">
            <template v-if="hlsStats">
              <UBadge color="green" variant="soft" size="xs">
                缓冲: {{ hlsStats.buffered.toFixed(1) }}s
              </UBadge>
              <UBadge color="cyan" variant="soft" size="xs">
                {{ hlsStats.level }}
              </UBadge>
            </template>
          </div>
        </div>
      </template>

      <!-- 视频容器 -->
      <div 
        ref="playerContainer"
        class="relative bg-black rounded-lg overflow-hidden group flex items-center justify-center"
        :class="[
          { 'cursor-none': isPlaying && !showControls },
          isFullscreen ? 'fixed inset-0 z-50 rounded-none' : ''
        ]"
        @mousemove="handleMouseMove"
        @mouseleave="hideControlsDelayed"
        @click="togglePlay"
        @dblclick="toggleFullscreen"
      >
        <video
          ref="videoEl"
          :key="videoKey"
          class="max-w-full max-h-full"
          :class="isFullscreen ? 'w-auto h-full' : 'w-full aspect-video'"
          :crossorigin="isLocalFile ? undefined : 'anonymous'"
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

        <!-- 加载中 -->
        <div 
          v-if="isBuffering" 
          class="absolute inset-0 flex items-center justify-center bg-black/30"
        >
          <div class="flex flex-col items-center gap-2">
            <UIcon name="i-heroicons-arrow-path" class="w-12 h-12 text-white animate-spin" />
            <span class="text-white text-sm">加载中...</span>
          </div>
        </div>

        <!-- 播放/暂停大图标 -->
        <Transition name="fade">
          <div 
            v-if="showPlayIcon"
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div class="w-20 h-20 rounded-full bg-black/50 flex items-center justify-center">
              <UIcon 
                :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" 
                class="w-10 h-10 text-white"
              />
            </div>
          </div>
        </Transition>

        <!-- 控制栏 -->
        <Transition name="slide-up">
          <div 
            v-show="showControls || !isPlaying"
            class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12"
            @click.stop
          >
            <!-- 进度条 -->
            <div 
              class="relative h-1.5 bg-white/30 rounded-full cursor-pointer group/progress mb-3"
              @click="seekTo"
              @mousedown="startSeek"
              @mousemove="updateHoverTime"
              @mouseleave="hoverTime = null"
              ref="progressBar"
            >
              <!-- 缓冲进度 -->
              <div 
                class="absolute h-full bg-white/40 rounded-full"
                :style="{ width: bufferedPercent + '%' }"
              />
              <!-- 播放进度 -->
              <div 
                class="absolute h-full bg-violet-500 rounded-full transition-all"
                :style="{ width: progressPercent + '%' }"
              />
              <!-- 拖动手柄 -->
              <div 
                class="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity"
                :style="{ left: `calc(${progressPercent}% - 8px)` }"
              />
              <!-- 悬停时间预览（始终显示） -->
              <div 
                v-if="hoverTime !== null"
                class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2 pointer-events-none"
                :style="{ left: hoverPercent + '%' }"
              >
                {{ formatTime(hoverTime) }}
              </div>
              <!-- 拖动时间预览 -->
              <div 
                v-else-if="seekPreviewTime !== null"
                class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2"
                :style="{ left: seekPreviewPercent + '%' }"
              >
                {{ formatTime(seekPreviewTime) }}
              </div>
            </div>

            <!-- 控制按钮 -->
            <div class="flex items-center justify-between gap-2 flex-wrap min-w-0">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <!-- 上一集 -->
                <button 
                  v-if="playlist.length > 1"
                  class="text-white transition-colors"
                  :class="hasPrev ? 'hover:text-violet-400' : 'opacity-40 cursor-not-allowed'"
                  :disabled="!hasPrev"
                  @click="playPrev"
                  title="上一集"
                >
                  <UIcon name="i-heroicons-backward-solid" class="w-5 h-5" />
                </button>

                <!-- 播放/暂停 -->
                <button 
                  class="text-white hover:text-violet-400 transition-colors"
                  @click="togglePlay"
                >
                  <UIcon 
                    :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" 
                    class="w-6 h-6"
                  />
                </button>

                <!-- 下一集 -->
                <button 
                  v-if="playlist.length > 1"
                  class="text-white transition-colors"
                  :class="hasNext ? 'hover:text-violet-400' : 'opacity-40 cursor-not-allowed'"
                  :disabled="!hasNext"
                  @click="playNext"
                  title="下一集"
                >
                  <UIcon name="i-heroicons-forward-solid" class="w-5 h-5" />
                </button>

                <!-- 快退/快进 -->
                <button 
                  class="text-white hover:text-violet-400 transition-colors"
                  @click="skip(-10)"
                  title="后退 10 秒"
                >
                  <UIcon name="i-heroicons-backward" class="w-5 h-5" />
                </button>
                <button 
                  class="text-white hover:text-violet-400 transition-colors"
                  @click="skip(10)"
                  title="前进 10 秒"
                >
                  <UIcon name="i-heroicons-forward" class="w-5 h-5" />
                </button>

                <!-- 音量 -->
                <div class="flex items-center gap-2 group/volume">
                  <button 
                    class="text-white hover:text-violet-400 transition-colors"
                    @click="toggleMute"
                  >
                    <UIcon 
                      :name="volumeIcon" 
                      class="w-5 h-5"
                    />
                  </button>
                  <div class="w-0 group-hover/volume:w-20 overflow-hidden transition-all duration-200">
                    <input 
                      type="range" 
                      min="0" 
                      max="1" 
                      step="0.05"
                      :value="volume"
                      @input="setVolume"
                      class="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer accent-violet-500"
                    />
                  </div>
                </div>

                <!-- 时间 -->
                <span class="text-white text-sm font-mono shrink-0">
                  {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
                </span>
              </div>

              <div class="flex items-center gap-2 shrink-0">
                <!-- 倍速 -->
                <div class="relative" ref="speedMenuRef">
                  <button 
                    class="text-white hover:text-violet-400 transition-colors px-2 py-1 rounded text-sm font-medium"
                    @click="showSpeedMenu = !showSpeedMenu"
                  >
                    {{ playbackRate }}x
                  </button>
                  <Transition name="fade">
                    <div 
                      v-if="showSpeedMenu"
                      class="absolute bottom-full right-0 mb-2 bg-black/90 rounded-lg overflow-hidden min-w-[80px]"
                    >
                      <button
                        v-for="rate in playbackRates"
                        :key="rate"
                        class="block w-full px-4 py-2 text-sm text-white hover:bg-violet-500/50 transition-colors text-center"
                        :class="{ 'bg-violet-500': playbackRate === rate }"
                        @click="setPlaybackRate(rate)"
                      >
                        {{ rate }}x
                      </button>
                    </div>
                  </Transition>
                </div>

                <!-- 下载 -->
                <button 
                  v-if="canDownload"
                  class="text-white hover:text-violet-400 transition-colors"
                  :class="{ 'opacity-50 cursor-not-allowed': isDownloading }"
                  :disabled="isDownloading"
                  @click="downloadVideo"
                  :title="isDownloading ? '下载中...' : '下载视频'"
                >
                  <UIcon 
                    :name="isDownloading ? 'i-heroicons-arrow-path' : 'i-heroicons-arrow-down-tray'" 
                    class="w-5 h-5"
                    :class="{ 'animate-spin': isDownloading }"
                  />
                </button>

                <!-- 画中画 -->
                <button 
                  v-if="supportsPiP"
                  class="text-white hover:text-violet-400 transition-colors"
                  @click="togglePiP"
                  title="画中画"
                >
                  <UIcon name="i-heroicons-rectangle-stack" class="w-5 h-5" />
                </button>

                <!-- 全屏 -->
                <button 
                  class="text-white hover:text-violet-400 transition-colors"
                  @click="toggleFullscreen"
                  title="全屏"
                >
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

    <!-- HLS 配置 -->
    <UCard v-if="isHls">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-cog-6-tooth" class="w-5 h-5 text-gray-500" />
          <span class="font-semibold">HLS 配置</span>
        </div>
      </template>

      <div class="space-y-4">
        <!-- 缓冲设置 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UFormGroup label="预加载时长" help="提前缓冲多少秒视频">
            <div class="flex items-center gap-2">
              <UInput 
                v-model.number="hlsConfig.maxBufferLength" 
                type="number" 
                :min="10" 
                :max="120"
                class="flex-1"
              />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
          <UFormGroup label="最大缓冲时长" help="缓冲区最大存储时长">
            <div class="flex items-center gap-2">
              <UInput 
                v-model.number="hlsConfig.maxMaxBufferLength" 
                type="number" 
                :min="30" 
                :max="300"
                class="flex-1"
              />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
          <UFormGroup label="缓冲内存" help="缓冲区占用的最大内存">
            <div class="flex items-center gap-2">
              <UInput 
                v-model.number="hlsConfig.maxBufferSizeMB" 
                type="number" 
                :min="30" 
                :max="500"
                class="flex-1"
              />
              <span class="text-sm text-gray-500">MB</span>
            </div>
          </UFormGroup>
        </div>

        <!-- 高级设置 -->
        <div class="flex flex-wrap gap-4">
          <UCheckbox v-model="hlsConfig.enableWorker" label="启用 Web Worker" />
          <UCheckbox v-model="hlsConfig.lowLatencyMode" label="低延迟模式（直播）" />
        </div>

        <!-- 实时状态 -->
        <div v-if="hlsStats" class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <span class="text-gray-500">已缓冲：</span>
              <span class="font-medium">{{ hlsStats.buffered.toFixed(1) }} 秒</span>
            </div>
            <div>
              <span class="text-gray-500">当前画质：</span>
              <span class="font-medium">{{ hlsStats.level }}</span>
            </div>
            <div>
              <span class="text-gray-500">缓冲进度：</span>
              <span class="font-medium">{{ bufferedPercent.toFixed(1) }}%</span>
            </div>
            <div>
              <span class="text-gray-500">播放进度：</span>
              <span class="font-medium">{{ progressPercent.toFixed(1) }}%</span>
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <UButton color="primary" variant="soft" @click="applyHlsConfig">
            <UIcon name="i-heroicons-check" class="w-4 h-4 mr-1" />
            应用配置
          </UButton>
          <UButton variant="ghost" @click="resetHlsConfig">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 mr-1" />
            重置默认
          </UButton>
        </div>
      </div>
    </UCard>
    
    <!-- MP4 预加载配置 -->
    <UCard v-if="isVideoLoaded && !isHls">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-cog-6-tooth" class="w-5 h-5 text-gray-500" />
          <span class="font-semibold">播放设置</span>
        </div>
      </template>
      
      <div class="flex items-center gap-4">
        <UFormGroup label="预加载策略">
          <USelectMenu 
            v-model="preloadStrategy" 
            :options="preloadOptions"
            @change="applyPreload"
          />
        </UFormGroup>
        <div class="text-xs text-gray-500 mt-6">
          <p>• <strong>none</strong>: 不预加载，节省流量</p>
          <p>• <strong>metadata</strong>: 只加载元数据</p>
          <p>• <strong>auto</strong>: 自动预加载整个视频</p>
        </div>
      </div>
    </UCard>

    <!-- 快捷键说明 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-command-line" class="w-5 h-5 text-amber-500" />
          <span class="font-semibold">快捷键</span>
        </div>
      </template>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">Space</kbd>
          <span class="text-gray-600 dark:text-gray-400">播放/暂停</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">←/→</kbd>
          <span class="text-gray-600 dark:text-gray-400">快退/快进 5秒</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">↑/↓</kbd>
          <span class="text-gray-600 dark:text-gray-400">音量调整</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">M</kbd>
          <span class="text-gray-600 dark:text-gray-400">静音</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">F</kbd>
          <span class="text-gray-600 dark:text-gray-400">全屏</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">Enter</kbd>
          <span class="text-gray-600 dark:text-gray-400">全屏/恢复</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">&lt;/&gt;</kbd>
          <span class="text-gray-600 dark:text-gray-400">倍速调整</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">P</kbd>
          <span class="text-gray-600 dark:text-gray-400">画中画</span>
        </div>
        <div class="flex items-center gap-2">
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">双击</kbd>
          <span class="text-gray-600 dark:text-gray-400">全屏切换</span>
        </div>
      </div>
    </UCard>

    <!-- 错误提示 -->
    <UAlert 
      v-if="errorMessage"
      color="red"
      variant="soft"
      icon="i-heroicons-exclamation-triangle"
      :title="errorMessage"
      :close-button="{ icon: 'i-heroicons-x-mark', color: 'red', variant: 'link' }"
      @close="errorMessage = ''"
    />
  </div>
</template>

<script setup lang="ts">
import type HlsType from 'hls.js'
import { onClickOutside } from '@vueuse/core'

// 动态导入 hls.js（避免 SSR 问题）
let Hls: typeof HlsType | null = null

// 路由
const route = useRoute()

// 本地存储 key
const STORAGE_KEY = 'video-player-state'

// 存储接口
interface SavedState {
  videoUrlInput: string
  playlist: string[]
  currentIndex: number
  progress: Record<string, number>  // URL -> 播放进度（秒）
  volume: number
  playbackRate: number
  useProxy: boolean
  autoFullscreen: boolean
  skipIntro: number  // 跳过片头时间（秒）
  skipOutro: number  // 跳过片尾时间（秒）
}

// 从本地存储加载状态
const loadSavedState = (): SavedState | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('加载保存状态失败:', e)
  }
  return null
}

// 保存状态到本地存储
const saveState = () => {
  try {
    const state: SavedState = {
      videoUrlInput: videoUrlInput.value,
      playlist: playlist.value,
      currentIndex: currentIndex.value,
      progress: savedProgress.value,
      volume: volume.value,
      playbackRate: playbackRate.value,
      useProxy: useProxy.value,
      autoFullscreen: autoFullscreen.value,
      skipIntro: skipIntro.value,
      skipOutro: skipOutro.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('保存状态失败:', e)
  }
}

// 保存当前视频进度
const saveCurrentProgress = () => {
  if (videoUrl.value && currentTime.value > 0 && !isLocalFile.value) {
    savedProgress.value[videoUrl.value] = currentTime.value
    saveState()
  }
}

// 获取保存的进度
const getSavedProgress = (url: string): number => {
  return savedProgress.value[url] || 0
}

// 视频源
const videoUrl = ref('')
const videoUrlInput = ref('')  // 多行输入
const isVideoLoaded = ref(false)
const isHls = ref(false)
const isLocalFile = ref(false)
const errorMessage = ref('')
const isLoading = ref(false)
const useProxy = ref(false)
const autoFullscreen = ref(true)  // 自动全屏
const savedProgress = ref<Record<string, number>>({})  // 保存的播放进度
const videoKey = ref(0)  // 用于强制重新创建 video 元素
const skipIntro = ref(0)  // 跳过片头时间（秒）
const skipOutro = ref(0)  // 跳过片尾时间（秒）
const hasSkippedIntro = ref(false)  // 是否已跳过片头（本次播放）

// 播放列表
const playlist = ref<string[]>([])
const currentIndex = ref(0)
const hasPrev = computed(() => currentIndex.value > 0)
const hasNext = computed(() => currentIndex.value < playlist.value.length - 1)

// CORS 代理列表
const corsProxies = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
]

// 播放器状态
const videoEl = ref<HTMLVideoElement>()
const playerContainer = ref<HTMLDivElement>()
const progressBar = ref<HTMLDivElement>()
const isPlaying = ref(false)
const isBuffering = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const isMuted = ref(false)
const playbackRate = ref(1)
const isFullscreen = ref(false)
const showControls = ref(true)
const showPlayIcon = ref(false)
const showSpeedMenu = ref(false)
const isDownloading = ref(false)

// 进度条
const progressPercent = computed(() => duration.value ? (currentTime.value / duration.value) * 100 : 0)
const bufferedPercent = ref(0)
const seekPreviewTime = ref<number | null>(null)
const seekPreviewPercent = ref(0)
const isSeeking = ref(false)
const hoverTime = ref<number | null>(null)  // 悬停时间预览
const hoverPercent = ref(0)

// HLS
let hls: HlsType | null = null
const hlsStats = ref<{ buffered: number; level: string } | null>(null)
const hlsConfig = ref({
  // 缓冲时间设置（精简配置）
  maxBufferLength: 30,        // 预加载时长（秒）
  maxMaxBufferLength: 60,     // 最大缓冲时长（秒）
  backBufferLength: 30,       // 后台缓冲（秒）
  // 内存设置
  maxBufferSizeMB: 60,        // 缓冲大小（MB）
  // 下载速度设置
  fragLoadingTimeOut: 30000,  // 分片下载超时（ms）
  fragLoadingMaxRetry: 3,     // 最大重试次数
  // 高级设置
  enableWorker: true,         // 启用 Web Worker
  lowLatencyMode: false,      // 低延迟模式
})

// MP4 预加载策略
const preloadStrategy = ref('auto')
const preloadOptions = [
  { label: '不预加载 (none)', value: 'none' },
  { label: '仅元数据 (metadata)', value: 'metadata' },
  { label: '自动预加载 (auto)', value: 'auto' }
]

// 倍速选项
const playbackRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]

// 示例视频
const exampleUrls = [
  { name: 'Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Sintel (HLS)', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { name: 'Tears of Steel (MP4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' }
]

// 控制栏隐藏定时器
let controlsTimer: ReturnType<typeof setTimeout> | null = null
let playIconTimer: ReturnType<typeof setTimeout> | null = null

// 速度菜单点击外部关闭
const speedMenuRef = ref<HTMLElement>()
onClickOutside(speedMenuRef, () => {
  showSpeedMenu.value = false
})

// 画中画支持检测
const supportsPiP = computed(() => {
  return document.pictureInPictureEnabled
})

// 音量图标
const volumeIcon = computed(() => {
  if (isMuted.value || volume.value === 0) return 'i-heroicons-speaker-x-mark'
  if (volume.value < 0.5) return 'i-heroicons-speaker-wave'
  return 'i-heroicons-speaker-wave'
})

// 格式化时间
const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || isNaN(seconds)) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// 检测是否为 HLS
const isHlsUrl = (url: string): boolean => {
  return url.includes('.m3u8') || url.includes('m3u8')
}

// 获取代理 URL
const getProxyUrl = (url: string): string => {
  if (!useProxy.value) return url
  return corsProxies[0] + encodeURIComponent(url)
}

// 从 URL 获取视频名称
const getVideoName = (url: string, index: number): string => {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop() || ''
    // 解码 URL 编码的文件名
    const decoded = decodeURIComponent(filename)
    if (decoded && decoded.length > 0) {
      return decoded
    }
  } catch {}
  return `视频 ${index + 1}`
}

// 是否可下载（仅网络视频，本地文件无需下载）
const canDownload = computed(() => 
  isVideoLoaded.value && !isLocalFile.value && videoUrl.value && (videoUrl.value.startsWith('http') || videoUrl.value.startsWith('//'))
)

// 解析 URL（相对路径转绝对路径）
const resolveUrl = (base: string, relative: string): string => {
  if (relative.startsWith('http://') || relative.startsWith('https://')) return relative
  try {
    return new URL(relative, base).href
  } catch {
    return relative
  }
}

// 解析 M3U8 获取分片列表（支持主列表、媒体列表、fMP4）
const parseM3u8Segments = (content: string, baseUrl: string): string[] => {
  const lines = content.split(/\r?\n/).map(l => l.trim())
  const segments: string[] = []
  const variants: { bandwidth: number; url: string }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/)
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0
      if (lines[i + 1]) {
        variants.push({ bandwidth, url: resolveUrl(baseUrl, lines[i + 1].trim()) })
      }
    }
    // #EXT-X-MAP:URI="init.mp4" (fMP4 初始化分片)
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/)
      if (uriMatch) segments.push(resolveUrl(baseUrl, uriMatch[1]))
    }
    if (line.startsWith('#EXTINF') && lines[i + 1]) {
      const uri = lines[i + 1].trim()
      if (!uri.startsWith('#')) {
        segments.push(resolveUrl(baseUrl, uri))
      }
    }
  }

  if (variants.length > 0) {
    const best = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0]
    return [best.url]
  }
  return segments
}

// 获取 M3U8 媒体列表的所有分片 URL（递归处理主列表）
const getM3u8SegmentUrls = async (m3u8Url: string): Promise<string[]> => {
  const url = getProxyUrl(m3u8Url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`获取 M3U8 失败: ${res.status}`)
  const text = await res.text()
  const baseUrl = m3u8Url.replace(/\/[^/]*$/, '/')

  const parsed = parseM3u8Segments(text, baseUrl)
  if (parsed.length === 0) throw new Error('M3U8 解析失败，未找到分片')

  // 若是子列表 URL，递归获取
  if (parsed.length === 1 && parsed[0].endsWith('.m3u8')) {
    return getM3u8SegmentUrls(parsed[0])
  }
  return parsed
}

// 触发浏览器下载
const triggerDownload = (blob: Blob, filename: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// 下载视频（可选指定 URL，否则用当前播放的）
const downloadVideo = async (targetUrl?: string) => {
  const url = (targetUrl || videoUrl.value)?.trim()
  if (!url || (!url.startsWith('http') && !url.startsWith('//'))) {
    errorMessage.value = '无可下载的视频地址'
    return
  }

  const normalizedUrl = url.startsWith('//') ? 'https:' + url : url
  isDownloading.value = true
  errorMessage.value = ''

  try {
    const idx = playlist.value.indexOf(url)
    const filename = getVideoName(normalizedUrl, idx >= 0 ? idx : currentIndex.value) || `video_${Date.now()}`
    const isHlsVideo = isHlsUrl(normalizedUrl)

    if (isHlsVideo) {
      // M3U8: 解析分片 → 逐个下载 → 合并为 .ts
      const segmentUrls = await getM3u8SegmentUrls(normalizedUrl)
      const chunks: ArrayBuffer[] = []
      const total = segmentUrls.length

      for (let i = 0; i < total; i++) {
        const segUrl = getProxyUrl(segmentUrls[i])
        const res = await fetch(segUrl)
        if (!res.ok) throw new Error(`分片 ${i + 1}/${total} 下载失败`)
        chunks.push(await res.arrayBuffer())
        // 简单进度反馈
        if (total > 5 && (i + 1) % Math.ceil(total / 10) === 0) {
          console.log(`M3U8 下载进度: ${Math.round(((i + 1) / total) * 100)}%`)
        }
      }

      const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0)
      const merged = new Uint8Array(totalSize)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset)
        offset += chunk.byteLength
      }

      const isFmp4 = segmentUrls.some(u => u.includes('.m4s') || u.includes('.mp4'))
      const mime = isFmp4 ? 'video/mp4' : 'video/mp2t'
      const ext = isFmp4 ? '.mp4' : '.ts'
      const outName = filename.includes('.m3u8') ? filename.replace('.m3u8', ext) : (filename.includes('.') ? filename : filename + ext)
      triggerDownload(new Blob([merged], { type: mime }), outName)
      useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
    } else {
      // MP4: 直接 fetch 下载
      const finalUrl = getProxyUrl(normalizedUrl)
      const res = await fetch(finalUrl)
      if (!res.ok) throw new Error(`下载失败: ${res.status}`)
      const blob = await res.blob()
      const ext = filename.includes('.') ? '' : '.mp4'
      const outName = filename.includes('.mp4') ? filename : filename + ext
      triggerDownload(blob, outName)
      useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
    }
  } catch (e) {
    console.error('下载失败:', e)
    let msg = e instanceof Error ? e.message : String(e)
    if (!useProxy.value && (msg.includes('fetch') || msg.includes('CORS') || msg.includes('403'))) {
      msg += '，可尝试开启「使用跨域代理」'
    }
    errorMessage.value = '下载失败: ' + msg
  } finally {
    isDownloading.value = false
  }
}

// 解析多行输入并加载
const parseAndLoad = async () => {
  const input = videoUrlInput.value.trim()
  if (!input) return
  
  // 按换行符分割，过滤空行
  const urls = input
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && (line.startsWith('http') || line.startsWith('//')))
  
  if (urls.length === 0) {
    errorMessage.value = '未找到有效的视频链接'
    return
  }
  
  // 设置播放列表
  playlist.value = urls
  currentIndex.value = 0
  
  // 保存状态
  saveState()
  
  // 播放第一个
  await playByIndex(0)
}

// 按索引播放
const playByIndex = async (index: number) => {
  if (index < 0 || index >= playlist.value.length) return
  
  // 保存当前视频进度
  saveCurrentProgress()
  
  currentIndex.value = index
  videoUrl.value = playlist.value[index]
  
  // 重置片头跳过标记
  hasSkippedIntro.value = false
  
  // 保存状态
  saveState()
  
  // 切换集数时标记需要自动播放（MP4 在 onCanPlay 中触发，HLS 在 MANIFEST_PARSED 中已有）
  isRestoringFromSaved.value = true
  
  await loadVideo()
}

// 上一集
const playPrev = async () => {
  if (hasPrev.value) {
    await playByIndex(currentIndex.value - 1)
  }
}

// 下一集
const playNext = async () => {
  if (hasNext.value) {
    await playByIndex(currentIndex.value + 1)
  }
}

// 清除所有进度
const clearAllProgress = () => {
  savedProgress.value = {}
  saveState()
}

// 清空播放列表
const clearPlaylist = () => {
  playlist.value = []
  currentIndex.value = 0
  videoUrlInput.value = ''
}

// 加载视频
const loadVideo = async () => {
  if (!videoUrl.value.trim()) return
  
  errorMessage.value = ''
  isLoading.value = true
  isBuffering.value = true
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
  bufferedPercent.value = 0
  
  // 强制重新创建 video 元素，彻底重置状态
  videoKey.value++
  
  isVideoLoaded.value = true
  isLocalFile.value = false  // URL 加载不是本地文件
  destroyHls()
  
  const url = videoUrl.value.trim()
  isHls.value = isHlsUrl(url)
  
  console.log('开始加载视频:', url, '是否HLS:', isHls.value, '使用代理:', useProxy.value)
  
  try {
    if (isHls.value) {
      await loadHlsVideo(url)
    } else {
      await loadNativeVideo(url)
    }
  } catch (e) {
    console.error('加载视频失败:', e)
    errorMessage.value = '加载视频失败: ' + (e instanceof Error ? e.message : String(e))
    isLoading.value = false
  }
}

// 加载 HLS 视频
const loadHlsVideo = async (url: string) => {
  // 动态导入 hls.js
  if (!Hls) {
    const hlsModule = await import('hls.js')
    Hls = hlsModule.default
  }
  
  // 先显示播放器容器
  isVideoLoaded.value = true
  
  // 等待 DOM 更新
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 50))
  
  if (!Hls.isSupported()) {
    // 尝试原生支持（Safari）
    if (videoEl.value?.canPlayType('application/vnd.apple.mpegurl')) {
      await loadNativeVideo(url)
      return
    }
    errorMessage.value = '您的浏览器不支持 HLS 播放'
    isLoading.value = false
    return
  }
  
  if (!videoEl.value) {
    throw new Error('视频元素未初始化')
  }
  
  const finalUrl = getProxyUrl(url)
  console.log('加载 HLS 视频:', finalUrl)
  
  // 简化的 HLS 配置
  hls = new Hls({
    // 基础缓冲配置
    maxBufferLength: hlsConfig.value.maxBufferLength,
    maxMaxBufferLength: hlsConfig.value.maxMaxBufferLength,
    backBufferLength: hlsConfig.value.backBufferLength,
    maxBufferSize: hlsConfig.value.maxBufferSizeMB * 1024 * 1024,
    // 加载配置
    fragLoadingTimeOut: hlsConfig.value.fragLoadingTimeOut,
    fragLoadingMaxRetry: hlsConfig.value.fragLoadingMaxRetry,
    manifestLoadingTimeOut: 20000,
    manifestLoadingMaxRetry: 3,
    levelLoadingTimeOut: 20000,
    levelLoadingMaxRetry: 3,
    // 性能配置
    enableWorker: hlsConfig.value.enableWorker,
    lowLatencyMode: hlsConfig.value.lowLatencyMode,
    startLevel: -1,
    // 关键：允许跨域获取密钥（AES-128 加密视频需要）
    xhrSetup: (xhr: XMLHttpRequest, url: string) => {
      xhr.withCredentials = false
    }
  })
  
  hls.loadSource(finalUrl)
  hls.attachMedia(videoEl.value)
  
  // manifest 解析完成
  hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    console.log('HLS manifest 解析完成，画质数:', data.levels.length)
    isLoading.value = false
    
    // 应用播放设置
    if (videoEl.value) {
      videoEl.value.playbackRate = playbackRate.value
      videoEl.value.volume = volume.value
      videoEl.value.muted = isMuted.value
    }
    
    // 延迟 3 秒后自动播放
    scheduleAutoPlay()
  })
  
  // 错误处理
  hls.on(Hls.Events.ERROR, (_, data) => {
    console.warn('HLS 错误:', data.type, data.details, 'fatal:', data.fatal)
    
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          console.log('网络错误，尝试恢复...')
          errorMessage.value = '网络错误，正在重试...'
          setTimeout(() => {
            hls?.startLoad()
            errorMessage.value = ''
          }, 1000)
          break
        case Hls.ErrorTypes.MEDIA_ERROR:
          console.log('媒体错误，尝试恢复...')
          errorMessage.value = '媒体错误，正在恢复...'
          hls?.recoverMediaError()
          setTimeout(() => {
            errorMessage.value = ''
          }, 2000)
          break
        default:
          errorMessage.value = '播放失败: ' + data.details
          destroyHls()
      }
    }
  })
  
  // 分片加载完成
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    updateHlsStats()
    isBuffering.value = false
  })
  
  // 分片加载中
  hls.on(Hls.Events.FRAG_LOADING, () => {
    // 只在没有足够缓冲时显示加载
    if (videoEl.value && videoEl.value.buffered.length > 0) {
      const bufferedEnd = videoEl.value.buffered.end(videoEl.value.buffered.length - 1)
      if (bufferedEnd - videoEl.value.currentTime < 2) {
        isBuffering.value = true
      }
    }
  })
  
  hls.on(Hls.Events.LEVEL_SWITCHED, () => {
    updateHlsStats()
  })
}

// 更新 HLS 统计信息
const updateHlsStats = () => {
  if (!hls || !videoEl.value) return
  
  const video = videoEl.value
  let buffered = 0
  
  if (video.buffered.length > 0) {
    buffered = video.buffered.end(video.buffered.length - 1) - video.currentTime
  }
  
  const currentLevel = hls.currentLevel
  const levels = hls.levels
  let levelInfo = '自动'
  
  if (currentLevel >= 0 && levels[currentLevel]) {
    const level = levels[currentLevel]
    levelInfo = `${level.height}p`
    if (level.bitrate) {
      levelInfo += ` (${Math.round(level.bitrate / 1000)}kbps)`
    }
  }
  
  hlsStats.value = {
    buffered,
    level: levelInfo
  }
}

// 加载原生视频
const loadNativeVideo = async (url: string) => {
  const finalUrl = getProxyUrl(url)
  console.log('加载原生视频:', finalUrl)
  
  // 先显示播放器容器
  isVideoLoaded.value = true
  
  // 等待 DOM 更新（video 元素重新创建需要更多时间）
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 100))
  
  if (!videoEl.value) {
    throw new Error('视频元素未初始化，请刷新页面重试')
  }
  
  videoEl.value.src = finalUrl
  videoEl.value.load()
  
  console.log('视频源已设置，等待加载...')
}

// 销毁 HLS 实例
const destroyHls = () => {
  // 清除延迟播放定时器
  if (delayedPlayTimer) {
    clearTimeout(delayedPlayTimer)
    delayedPlayTimer = null
  }
  if (hls) {
    hls.destroy()
    hls = null
  }
  hlsStats.value = null
}

// 本地文件 URL 映射
const localFileUrls = new Map<string, string>()

// 处理本地文件（支持多选）
const handleLocalFiles = async (files: File[]) => {
  // 过滤掉 m3u8 文件
  const videoFiles = files.filter(f => !f.name.endsWith('.m3u8'))
  
  if (videoFiles.length === 0) {
    errorMessage.value = '本地 M3U8 文件需要通过 URL 加载，请使用视频地址输入'
    return
  }
  
  destroyHls()
  errorMessage.value = ''
  isLocalFile.value = true
  
  // 清理旧的 URL
  localFileUrls.forEach(url => URL.revokeObjectURL(url))
  localFileUrls.clear()
  
  // 创建播放列表
  const urls: string[] = []
  for (const file of videoFiles) {
    const url = URL.createObjectURL(file)
    localFileUrls.set(file.name, url)
    urls.push(url)
  }
  
  playlist.value = urls
  currentIndex.value = 0
  
  // 播放第一个
  isLoading.value = true
  videoUrl.value = videoFiles[0].name
  isHls.value = false
  isVideoLoaded.value = true
  
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 50))
  
  if (videoEl.value) {
    videoEl.value.src = urls[0]
    videoEl.value.preload = 'auto'
    videoEl.value.load()
    console.log('本地文件已加载:', videoFiles[0].name)
  }
  isLoading.value = false
}

// 加载示例
const loadExample = async (url: string) => {
  videoUrlInput.value = url
  await parseAndLoad()
}

// 播放控制
const togglePlay = () => {
  if (!videoEl.value) return
  
  if (isPlaying.value) {
    videoEl.value.pause()
  } else {
    videoEl.value.play()
  }
  
  // 显示播放图标
  showPlayIcon.value = true
  if (playIconTimer) clearTimeout(playIconTimer)
  playIconTimer = setTimeout(() => {
    showPlayIcon.value = false
  }, 500)
}

// 跳转
const skip = (seconds: number) => {
  if (!videoEl.value) return
  videoEl.value.currentTime = Math.max(0, Math.min(duration.value, videoEl.value.currentTime + seconds))
}

// 进度条点击
const seekTo = (e: MouseEvent) => {
  if (!progressBar.value || !videoEl.value) return
  
  const rect = progressBar.value.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const targetTime = percent * duration.value
  
  console.log('Seek to:', targetTime)
  isBuffering.value = true
  videoEl.value.currentTime = targetTime
}

// 拖动前的播放状态
let wasPlayingBeforeSeek = false

// 开始拖动进度条
const startSeek = (e: MouseEvent) => {
  isSeeking.value = true
  wasPlayingBeforeSeek = videoEl.value ? !videoEl.value.paused : false
  
  // 拖动时暂停播放（避免 HLS 缓冲冲突）
  if (wasPlayingBeforeSeek && videoEl.value) {
    videoEl.value.pause()
  }
  
  updateSeekPreview(e)
  
  const onMove = (e: MouseEvent) => {
    updateSeekPreview(e)
  }
  
  const onUp = (e: MouseEvent) => {
    isSeeking.value = false
    seekPreviewTime.value = null
    
    // 执行 seek
    if (progressBar.value && videoEl.value) {
      const rect = progressBar.value.getBoundingClientRect()
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      videoEl.value.currentTime = percent * duration.value
      
      // 恢复播放
      if (wasPlayingBeforeSeek) {
        setTimeout(() => {
          videoEl.value?.play().catch(() => {})
        }, 100)
      }
    }
    
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// 更新拖动预览
const updateSeekPreview = (e: MouseEvent) => {
  if (!progressBar.value) return
  
  const rect = progressBar.value.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  seekPreviewPercent.value = percent * 100
  seekPreviewTime.value = percent * duration.value
}

// 更新悬停时间预览
const updateHoverTime = (e: MouseEvent) => {
  if (!progressBar.value || isSeeking.value) return
  
  const rect = progressBar.value.getBoundingClientRect()
  const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  hoverPercent.value = percent * 100
  hoverTime.value = percent * duration.value
}

// 音量控制
const setVolume = (e: Event) => {
  const input = e.target as HTMLInputElement
  volume.value = parseFloat(input.value)
  if (videoEl.value) {
    videoEl.value.volume = volume.value
    videoEl.value.muted = false
    isMuted.value = false
  }
}

const toggleMute = () => {
  if (!videoEl.value) return
  isMuted.value = !isMuted.value
  videoEl.value.muted = isMuted.value
}

// 倍速控制
const setPlaybackRate = (rate: number) => {
  playbackRate.value = rate
  if (videoEl.value) {
    videoEl.value.playbackRate = rate
  }
  showSpeedMenu.value = false
}

// 全屏
const toggleFullscreen = () => {
  if (!playerContainer.value) return
  
  if (document.fullscreenElement) {
    document.exitFullscreen()
    isFullscreen.value = false
  } else {
    playerContainer.value.requestFullscreen()
    isFullscreen.value = true
  }
}

// 画中画
const togglePiP = async () => {
  if (!videoEl.value) return
  
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture()
    } else {
      await videoEl.value.requestPictureInPicture()
    }
  } catch (e) {
    console.error('PiP error:', e)
  }
}

// 控制栏显示/隐藏
const handleMouseMove = () => {
  showControls.value = true
  hideControlsDelayed()
}

const hideControlsDelayed = () => {
  if (controlsTimer) clearTimeout(controlsTimer)
  controlsTimer = setTimeout(() => {
    if (isPlaying.value) {
      showControls.value = false
    }
  }, 3000)
}

// 进度保存计时器
let progressSaveTimer: ReturnType<typeof setTimeout> | null = null

// 视频事件
const onTimeUpdate = () => {
  if (!videoEl.value) return
  currentTime.value = videoEl.value.currentTime
  
  // 更新缓冲进度
  if (videoEl.value.buffered.length > 0) {
    bufferedPercent.value = (videoEl.value.buffered.end(videoEl.value.buffered.length - 1) / duration.value) * 100
  }
  
  // 自动跳过片尾
  if (skipOutro.value > 0 && duration.value > 0) {
    const timeRemaining = duration.value - currentTime.value
    if (timeRemaining > 0 && timeRemaining <= skipOutro.value && hasNext.value) {
      console.log('自动跳过片尾，播放下一集')
      playNext()
      return
    }
  }
  
  // 每 5 秒保存一次进度（防抖）
  if (!progressSaveTimer) {
    progressSaveTimer = setTimeout(() => {
      saveCurrentProgress()
      progressSaveTimer = null
    }, 5000)
  }
}

const onLoadedMetadata = () => {
  if (!videoEl.value) return
  duration.value = videoEl.value.duration
  
  // 恢复保存的播放进度
  const savedTime = getSavedProgress(videoUrl.value)
  if (savedTime > 0 && savedTime < duration.value - 5) {
    console.log('恢复播放进度:', savedTime)
    videoEl.value.currentTime = savedTime
    hasSkippedIntro.value = true  // 已恢复进度，标记为已跳过片头
  } else if (skipIntro.value > 0 && !hasSkippedIntro.value) {
    // 跳过片头
    console.log('跳过片头:', skipIntro.value)
    videoEl.value.currentTime = skipIntro.value
    hasSkippedIntro.value = true
  }
  
  // 切换/刷新后应用倍速和音量（video 换源时会重置）
  videoEl.value.playbackRate = playbackRate.value
  videoEl.value.volume = volume.value
  videoEl.value.muted = isMuted.value
}

const onVolumeChange = () => {
  if (!videoEl.value) return
  volume.value = videoEl.value.volume
  isMuted.value = videoEl.value.muted
}

const onVideoError = (e: Event) => {
  const video = e.target as HTMLVideoElement
  const error = video?.error
  let msg = '视频加载失败'
  
  if (error) {
    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        msg = '视频加载被中断'
        break
      case MediaError.MEDIA_ERR_NETWORK:
        if (useProxy.value) {
          msg = '网络错误（403/防盗链），请关闭代理直接播放，或使用本地文件'
        } else {
          msg = '网络错误，可能是跨域问题，请尝试开启"使用跨域代理"'
        }
        break
      case MediaError.MEDIA_ERR_DECODE:
        msg = '视频解码失败'
        break
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        if (useProxy.value) {
          msg = '视频源被拒绝（可能有防盗链），请关闭代理直接播放，或拖拽本地文件播放'
        } else {
          msg = '不支持的视频格式或地址无效，请检查链接是否正确'
        }
        break
    }
  }
  
  console.error('视频错误:', error)
  errorMessage.value = msg
  isLoading.value = false
}

// 首次加载标记
let isFirstLoad = true
// 从保存状态恢复后需要自动播放（MP4 等原生视频无 MANIFEST_PARSED，需在 canplay 时触发）
const isRestoringFromSaved = ref(false)
// 切换集数后延迟播放的定时器
let delayedPlayTimer: ReturnType<typeof setTimeout> | null = null
// 预缓冲时间（秒）
const PRELOAD_BUFFER_TIME = 1

const onCanPlay = () => {
  console.log('视频可以播放了')
  isLoading.value = false
  
  // 应用播放设置
  if (videoEl.value) {
    videoEl.value.playbackRate = playbackRate.value
    videoEl.value.volume = volume.value
    videoEl.value.muted = isMuted.value
  }
  
  // 非 HLS 视频：延迟自动播放
  if (!isHls.value) {
    scheduleAutoPlay()
  }
  
  // 首次加载且开启自动全屏
  if (isFirstLoad && autoFullscreen.value) {
    isFirstLoad = false
    setTimeout(() => {
      if (playerContainer.value && !document.fullscreenElement) {
        playerContainer.value.requestFullscreen().catch(() => {
          console.log('自动全屏被阻止')
        })
      }
    }, 100)
  }
}

// 统一的自动播放函数：延迟 3 秒后播放
const scheduleAutoPlay = () => {
  // 清除之前的定时器
  if (delayedPlayTimer) {
    clearTimeout(delayedPlayTimer)
    delayedPlayTimer = null
  }
  
  console.log('等待 3 秒缓冲后自动播放...')
  isBuffering.value = true
  
  delayedPlayTimer = setTimeout(() => {
    delayedPlayTimer = null
    if (videoEl.value) {
      console.log('开始自动播放')
      isBuffering.value = false
      videoEl.value.play().catch(e => {
        console.log('自动播放被阻止:', e.message)
        isBuffering.value = false
      })
    }
  }, 3000)
}

const onLoadedData = () => {
  console.log('视频数据已加载')
  isLoading.value = false
}

// 等待缓冲
const onWaiting = () => {
  console.log('视频等待缓冲...')
  isBuffering.value = true
}

// 可以流畅播放
const onCanPlayThrough = () => {
  console.log('视频可以流畅播放')
  isBuffering.value = false
}

// 开始 seek
const onSeeking = () => {
  console.log('开始跳转...')
  isBuffering.value = true
}

// seek 完成
const onSeeked = () => {
  console.log('跳转完成')
  // 简单处理：seek 完成后关闭缓冲状态
  setTimeout(() => {
    isBuffering.value = false
  }, 200)
}

// 开始播放
const onPlaying = () => {
  console.log('视频开始播放')
  isBuffering.value = false
  isPlaying.value = true
}


// 视频播放结束
const onVideoEnded = () => {
  isPlaying.value = false
  
  // 自动播放下一集
  if (hasNext.value) {
    console.log('自动播放下一集')
    playNext()
  }
}

// HLS 配置
const applyHlsConfig = async () => {
  if (isHls.value && videoUrl.value) {
    // 记住当前播放位置
    const savedTime = currentTime.value
    const wasPlaying = isPlaying.value
    
    await loadVideo()
    
    // 等待视频加载完成后恢复播放位置
    const restorePosition = () => {
      if (videoEl.value && savedTime > 0) {
        videoEl.value.currentTime = savedTime
        console.log('恢复播放位置:', savedTime)
        if (wasPlaying) {
          videoEl.value.play().catch(() => {})
        }
      }
    }
    
    // 监听 loadedmetadata 事件来恢复位置
    if (videoEl.value) {
      videoEl.value.addEventListener('loadedmetadata', restorePosition, { once: true })
    }
  }
}

const resetHlsConfig = () => {
  hlsConfig.value = {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    maxBufferSizeMB: 60,
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 3,
    enableWorker: true,
    lowLatencyMode: false,
  }
}

// MP4 预加载设置
const applyPreload = () => {
  if (videoEl.value) {
    videoEl.value.preload = preloadStrategy.value
  }
}

// 键盘快捷键
const handleKeydown = (e: KeyboardEvent) => {
  if (!isVideoLoaded.value) return
  
  // 忽略输入框、文本域中的按键
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  
  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      toggleFullscreen()
      break
    case ' ':
      e.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      skip(-5)
      break
    case 'ArrowRight':
      e.preventDefault()
      skip(5)
      break
    case 'ArrowUp':
      e.preventDefault()
      volume.value = Math.min(1, volume.value + 0.1)
      if (videoEl.value) videoEl.value.volume = volume.value
      break
    case 'ArrowDown':
      e.preventDefault()
      volume.value = Math.max(0, volume.value - 0.1)
      if (videoEl.value) videoEl.value.volume = volume.value
      break
    case 'm':
    case 'M':
      toggleMute()
      break
    case 'f':
    case 'F':
      toggleFullscreen()
      break
    case 'p':
    case 'P':
      togglePiP()
      break
    case '<':
    case ',':
      const prevIdx = playbackRates.indexOf(playbackRate.value)
      if (prevIdx > 0) setPlaybackRate(playbackRates[prevIdx - 1])
      break
    case '>':
    case '.':
      const nextIdx = playbackRates.indexOf(playbackRate.value)
      if (nextIdx < playbackRates.length - 1) setPlaybackRate(playbackRates[nextIdx + 1])
      break
  }
}

// 全屏变化监听
const handleFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  
  // 加载保存的状态
  const savedState = loadSavedState()
  if (savedState) {
    console.log('加载保存的状态:', savedState)
    savedProgress.value = savedState.progress || {}
    volume.value = savedState.volume ?? 1
    playbackRate.value = savedState.playbackRate ?? 1
    useProxy.value = savedState.useProxy ?? false
    autoFullscreen.value = savedState.autoFullscreen ?? true
    skipIntro.value = savedState.skipIntro ?? 0
    skipOutro.value = savedState.skipOutro ?? 0
    
    // 如果没有 URL 参数，恢复保存的视频地址
    const urlParam = route.query.url as string
    if (!urlParam && savedState.videoUrlInput) {
      videoUrlInput.value = savedState.videoUrlInput
      playlist.value = savedState.playlist || []
      currentIndex.value = savedState.currentIndex ?? 0
    }
  }
  
  // 检查 URL 参数，支持 ?url=xxx 直接播放
  const urlParam = route.query.url as string
  if (urlParam) {
    console.log('从 URL 参数加载视频:', urlParam)
    videoUrlInput.value = urlParam
    await nextTick()
    parseAndLoad()
  } else if (savedState?.playlist?.length) {
    // 刷新后恢复：有保存的播放列表且为 URL 链接（非本地 blob），自动加载并播放
    const idx = savedState.currentIndex ?? 0
    const url = savedState.playlist[idx]
    if (url?.startsWith('http')) {
      isRestoringFromSaved.value = true
      await nextTick()
      await playByIndex(idx)
    }
  } else if (savedState?.videoUrlInput?.trim()) {
    // 有视频地址但无播放列表（如粘贴后未解析），尝试解析并加载
    await nextTick()
    isRestoringFromSaved.value = true
    await parseAndLoad()
  }
  
  // 页面关闭前保存进度
  window.addEventListener('beforeunload', saveCurrentProgress)
})

onUnmounted(() => {
  // 保存当前进度
  saveCurrentProgress()
  
  destroyHls()
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('beforeunload', saveCurrentProgress)
  if (controlsTimer) clearTimeout(controlsTimer)
  if (playIconTimer) clearTimeout(playIconTimer)
  if (progressSaveTimer) clearTimeout(progressSaveTimer)
  if (delayedPlayTimer) clearTimeout(delayedPlayTimer)
  
  // 清理本地文件 URL
  localFileUrls.forEach(url => URL.revokeObjectURL(url))
  localFileUrls.clear()
})
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(20px);
}

/* 自定义滑块样式 */
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  cursor: pointer;
}

input[type="range"]::-moz-range-thumb {
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}
</style>
