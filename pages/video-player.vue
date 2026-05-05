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

        <!-- Origin / Referer 防盗链设置 -->
        <div class="flex gap-4 flex-wrap items-end">
          <UFormGroup label="Origin" help="注入请求头 Origin，用于绕过防盗链">
            <UInput
              v-model="requestOrigin"
              placeholder="https://example.com"
              class="w-52"
              @change="saveState"
            />
          </UFormGroup>
          <UFormGroup label="Referer" :help="refererHelp">
            <UInput
              v-model="requestReferer"
              :placeholder="effectiveReferer || 'https://example.com/'"
              class="w-64"
              @change="saveState"
            />
          </UFormGroup>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="manifestOnly"
              label="仅代理 Manifest（推荐）"
              @change="saveState"
            />
            <p class="text-xs text-gray-400 mt-1">
              分片直连 CDN，速度与无代理相同<br>
              不勾选 = 全程代理，更兼容但较慢
            </p>
          </UFormGroup>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="disguiseAsDownloader"
              label="伪装下载器（不发送 Origin/Referer）"
              @change="saveState"
            />
            <p class="text-xs text-gray-400 mt-1">
              部分 CDN（如 xhscdn）对无 Origin/Referer 的请求放行，403 时可尝试
            </p>
          </UFormGroup>
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

        <!-- 全屏时固定显示的退出全屏按钮（控制栏隐藏时也可见） -->
        <Transition name="fade">
          <button
            v-if="isFullscreen && !showControls"
            class="absolute top-3 right-3 z-10 text-white/60 hover:text-white transition-colors bg-black/30 rounded-full p-1.5"
            @click.stop="toggleFullscreen"
            title="退出全屏"
          >
            <UIcon name="i-heroicons-arrows-pointing-in" class="w-5 h-5" />
          </button>
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
                <template v-if="canDownload">
                  <!-- 下载中：显示进度 + 取消按钮 -->
                  <template v-if="isDownloading">
                    <span class="text-white text-xs font-medium w-8 text-center">{{ downloadProgress }}%</span>
                    <button
                      class="text-amber-400 hover:text-red-400 transition-colors"
                      @click="cancelDownload"
                      title="取消下载"
                    >
                      <UIcon name="i-heroicons-x-circle" class="w-5 h-5" />
                    </button>
                  </template>
                  <!-- 未下载：显示下载按钮 -->
                  <button
                    v-else
                    class="text-white hover:text-violet-400 transition-colors"
                    @click="downloadVideo()"
                    title="下载视频"
                  >
                    <UIcon name="i-heroicons-arrow-down-tray" class="w-5 h-5" />
                  </button>
                </template>

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
        <div v-if="hlsStats" class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
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
          <!-- 自适应预取状态 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
            <div>
              <span class="text-gray-500">预取线程：</span>
              <span class="font-medium" :class="prefetchInfo.threads === 3 ? 'text-red-500' : prefetchInfo.threads === 2 ? 'text-amber-500' : 'text-green-500'">
                {{ prefetchInfo.threads }} 线程
              </span>
            </div>
            <div>
              <span class="text-gray-500">缓冲健康：</span>
              <span class="font-medium">{{ prefetchInfo.bufferSecs }} 秒</span>
            </div>
            <div>
              <span class="text-gray-500">预取完成：</span>
              <span class="font-medium">{{ prefetchInfo.cached }} 分片</span>
            </div>
            <div>
              <span class="text-gray-500">预取中：</span>
              <span class="font-medium">{{ prefetchInfo.pending }} 分片</span>
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
import { Parser as M3u8Parser } from 'm3u8-parser'

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
  requestOrigin: string
  requestReferer: string
  manifestOnly: boolean
  disguiseAsDownloader: boolean
  hlsConfig: typeof hlsConfig.value
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
      skipOutro: skipOutro.value,
      requestOrigin: requestOrigin.value,
      requestReferer: requestReferer.value,
      manifestOnly: manifestOnly.value,
      disguiseAsDownloader: disguiseAsDownloader.value,
      hlsConfig: { ...hlsConfig.value }
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
const requestOrigin = ref('')    // 自定义 Origin 请求头
const requestReferer = ref('')   // 自定义 Referer 请求头（空则自动为 origin + /）
const manifestOnly = ref(true)   // 仅代理 manifest，分片直连 CDN（更快）
const disguiseAsDownloader = ref(true)  // 不发送 Origin/Referer，模拟 N_m3u8DL-RE 等下载器
// 实际生效的 Referer：用户填了就用用户的，否则 origin 非空时自动补 /
const effectiveReferer = computed(() => {
  const r = requestReferer.value.trim()
  if (r) return r
  const o = requestOrigin.value.trim()
  return o ? o.replace(/\/$/, '') + '/' : ''
})
const refererHelp = computed(() => {
  const o = requestOrigin.value.trim()
  const defaultVal = o ? o.replace(/\/$/, '') + '/' : 'Origin + /'
  return '注入请求头 Referer，留空时自动填 ' + defaultVal
})
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
const downloadProgress = ref(0)   // 下载进度 0-100
let downloadAbortController: AbortController | null = null
let ffmpegInstance: any | null = null
let ffmpegUtil: {
  fetchFile: (input: Blob) => Promise<Uint8Array>
  toBlobURL: (url: string, mimeType: string) => Promise<string>
} | null = null
let ffmpegLoadTask: Promise<void> | null = null

// 进度条
const progressPercent = computed(() => duration.value ? (currentTime.value / duration.value) * 100 : 0)
const bufferedPercent = ref(0)
const seekPreviewTime = ref<number | null>(null)
const seekPreviewPercent = ref(0)
const isSeeking = ref(false)
const hoverTime = ref<number | null>(null)  // 悬停时间预览
const hoverPercent = ref(0)
const hlsRetryCount = ref(0)  // HLS 重试计数
const MAX_HLS_RETRY = 3  // 最大重试次数
// 加载超时时间：走服务端代理时需要更长，统一设 15s
// （代理需要先请求远端再返回，3s 往往不够，导致 destroyHls 取消所有请求）
const LOAD_TIMEOUT = 15000
let loadTimeoutTimer: ReturnType<typeof setTimeout> | null = null  // 加载超时定时器
let hasReceivedData = false  // 是否收到有效数据

// 自适应并行预取系统
const segPrefetchCache = new Map<string, ArrayBuffer>()        // 已预取完成的缓存
const segPrefetching = new Map<string, Promise<ArrayBuffer>>() // 正在预取中
const prefetchInfo = ref({ bufferSecs: 0, threads: 0, cached: 0, pending: 0 })

// HLS
let hls: HlsType | null = null
const hlsStats = ref<{ buffered: number; level: string } | null>(null)
const hlsConfig = ref({
  // 缓冲时间设置（精简配置）
  maxBufferLength: 3600,        // 预加载时长（秒）
  maxMaxBufferLength: 3600,     // 最大缓冲时长（秒）
  backBufferLength: 3600,       // 后台缓冲（秒）
  // 内存设置
  maxBufferSizeMB: 600,        // 缓冲大小（MB）
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
const playbackRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

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
// Origin/Referer 是浏览器禁止 JS 修改的 forbidden headers，
// 必须走服务端代理（/api/proxy）注入，fetch/XHR 直接设置会被浏览器忽略。
const getProxyUrl = (url: string): string => {
  if (url.includes('/api/proxy?')) return url

  // 伪装下载器：不发送 Origin/Referer，全程走代理（禁用 noseg）
  if (disguiseAsDownloader.value) {
    const params = new URLSearchParams({ url, noref: '1' })
    return '/api/proxy?' + params.toString()
  }

  const o = requestOrigin.value.trim()
  const r = effectiveReferer.value
  if (o || r) {
    if (manifestOnly.value && !isHlsUrl(url)) return url

    const params = new URLSearchParams({ url })
    if (o) params.set('origin', o)
    if (r) params.set('referer', r)
    if (manifestOnly.value) params.set('noseg', '1')
    return '/api/proxy?' + params.toString()
  }

  if (useProxy.value) return corsProxies[0] + encodeURIComponent(url)
  return url
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

const fetchM3u8Manifest = async (m3u8Url: string, signal?: AbortSignal): Promise<{ manifest: any; baseUrl: string }> => {
  const proxyUrl = m3u8Url.startsWith('/api/proxy') ? m3u8Url : getProxyUrl(m3u8Url)
  const res = await fetch(proxyUrl, { signal })
  if (!res.ok) throw new Error(`获取 M3U8 失败: ${res.status}`)
  const text = await res.text()

  const actualUrl = res.url || proxyUrl
  let baseUrl: string
  try {
    const u = new URL(actualUrl, window.location.href)
    baseUrl = u.origin + u.pathname.replace(/\/[^/]*$/, '/')
  } catch {
    baseUrl = actualUrl.replace(/\/[^/]*$/, '/')
  }

  const parser = new M3u8Parser()
  parser.push(text)
  parser.end()
  return { manifest: parser.manifest as any, baseUrl }
}

const pickBestVariant = (manifest: any): any | null => {
  if (!Array.isArray(manifest?.playlists) || manifest.playlists.length === 0) return null
  return [...manifest.playlists].sort((a: any, b: any) => {
    const ab = a?.attributes?.BANDWIDTH ?? 0
    const bb = b?.attributes?.BANDWIDTH ?? 0
    return bb - ab
  })[0]
}

const extractMediaSegmentUrls = (manifest: any, baseUrl: string): string[] => {
  const segments = manifest.segments as Array<any> | undefined
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('M3U8 解析失败，未找到分片')
  }

  const urls: string[] = []
  const addedMap = new Set<string>()
  for (const seg of segments) {
    const mapUri = seg?.map?.uri
    if (mapUri) {
      const mapUrl = resolveUrl(baseUrl, mapUri)
      if (!addedMap.has(mapUrl)) {
        urls.push(mapUrl)
        addedMap.add(mapUrl)
      }
    }
    if (seg?.uri) {
      urls.push(resolveUrl(baseUrl, seg.uri))
    }
  }
  return urls
}

const pickAudioPlaylistUrl = (manifest: any, baseUrl: string, preferredGroupId?: string): string | null => {
  const audioGroups = manifest?.mediaGroups?.AUDIO
  if (!audioGroups || typeof audioGroups !== 'object') return null

  const candidateGroupId = preferredGroupId && audioGroups[preferredGroupId]
    ? preferredGroupId
    : Object.keys(audioGroups)[0]
  if (!candidateGroupId) return null

  const group = audioGroups[candidateGroupId]
  if (!group || typeof group !== 'object') return null

  const renditions = Object.values(group) as any[]
  const picked = renditions.find(r => r?.default && r?.uri)
    || renditions.find(r => r?.autoselect && r?.uri)
    || renditions.find(r => r?.uri)
  if (!picked?.uri) return null
  return resolveUrl(baseUrl, picked.uri)
}

// 分片元数据（含加密信息）
interface HlsSegment {
  url: string
  sn: number             // 媒体序列号，用于推导 AES IV
  keyUri?: string        // 密钥地址（undefined = 未加密）
  keyIv?: Uint8Array | null  // 显式 IV（null = 用 sn 推导）
}

// 提取分片列表（含加密元数据）
const extractMediaSegmentsWithMeta = (manifest: any, baseUrl: string): HlsSegment[] => {
  const segments = manifest.segments as Array<any> | undefined
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('M3U8 解析失败，未找到分片')
  }
  const mediaSequence: number = manifest.mediaSequence ?? 0
  const result: HlsSegment[] = []
  const addedMap = new Set<string>()

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const sn = mediaSequence + i
    const mapUri = seg?.map?.uri
    if (mapUri) {
      const mapUrl = resolveUrl(baseUrl, mapUri)
      if (!addedMap.has(mapUrl)) {
        result.push({ url: mapUrl, sn: 0 })
        addedMap.add(mapUrl)
      }
    }
    if (!seg?.uri) continue

    const isEncrypted = seg.key?.method === 'AES-128'
    let keyIv: Uint8Array | null = null
    if (isEncrypted && seg.key?.iv) {
      // m3u8-parser 可能返回数组或十六进制字符串
      const ivSrc = seg.key.iv
      const ivHex = Array.isArray(ivSrc)
        ? (ivSrc as number[]).map(b => b.toString(16).padStart(2, '0')).join('')
        : String(ivSrc).replace(/^0x/i, '').padStart(32, '0')
      keyIv = new Uint8Array(ivHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
    }

    result.push({
      url: resolveUrl(baseUrl, seg.uri),
      sn,
      keyUri: isEncrypted && seg.key?.uri ? resolveUrl(baseUrl, seg.key.uri) : undefined,
      keyIv: isEncrypted ? keyIv : null,
    })
  }
  return result
}

// 递归解析到媒体播放列表，返回带加密信息的分片列表
const getM3u8SegmentsWithMeta = async (m3u8Url: string, signal?: AbortSignal): Promise<HlsSegment[]> => {
  const { manifest, baseUrl } = await fetchM3u8Manifest(m3u8Url, signal)
  const best = pickBestVariant(manifest)
  if (best?.uri) return getM3u8SegmentsWithMeta(resolveUrl(baseUrl, best.uri), signal)
  return extractMediaSegmentsWithMeta(manifest, baseUrl)
}

// 下载计划：同时解析视频轨和独立音频轨（若存在），携带加密元数据
const getM3u8DownloadPlan = async (
  m3u8Url: string,
  signal?: AbortSignal
): Promise<{ videoSegments: HlsSegment[]; audioSegments: HlsSegment[] }> => {
  const { manifest, baseUrl } = await fetchM3u8Manifest(m3u8Url, signal)
  const best = pickBestVariant(manifest)
  if (!best?.uri) {
    return { videoSegments: extractMediaSegmentsWithMeta(manifest, baseUrl), audioSegments: [] }
  }
  const videoPlaylistUrl = resolveUrl(baseUrl, best.uri)
  const audioPlaylistUrl = pickAudioPlaylistUrl(manifest, baseUrl, best?.attributes?.AUDIO)
  const [videoSegments, audioSegments] = await Promise.all([
    getM3u8SegmentsWithMeta(videoPlaylistUrl, signal),
    audioPlaylistUrl ? getM3u8SegmentsWithMeta(audioPlaylistUrl, signal) : Promise.resolve([])
  ])
  return { videoSegments, audioSegments }
}

// AES-128 密钥缓存（每次下载任务内复用）
const hlsKeyCache = new Map<string, CryptoKey>()

const fetchHlsKey = async (keyUri: string, signal?: AbortSignal): Promise<CryptoKey> => {
  if (hlsKeyCache.has(keyUri)) return hlsKeyCache.get(keyUri)!
  const res = await fetch(getProxyUrl(keyUri), { signal })
  if (!res.ok) throw new Error(`获取解密密钥失败: ${res.status}`)
  const raw = await res.arrayBuffer()
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])
  hlsKeyCache.set(keyUri, key)
  return key
}

// AES-128-CBC 解密单个分片（未加密直接返回原数据）
const decryptHlsSegment = async (data: ArrayBuffer, seg: HlsSegment, signal?: AbortSignal): Promise<ArrayBuffer> => {
  if (!seg.keyUri) return data
  const key = await fetchHlsKey(seg.keyUri, signal)
  let iv: ArrayBuffer
  if (seg.keyIv && seg.keyIv.byteLength === 16) {
    iv = seg.keyIv.buffer.slice(seg.keyIv.byteOffset, seg.keyIv.byteOffset + 16)
  } else {
    // 无显式 IV：用序列号填充 16 字节大端整数
    const ivBytes = new Uint8Array(16)
    const sn = seg.sn
    ivBytes[12] = (sn >>> 24) & 0xff
    ivBytes[13] = (sn >>> 16) & 0xff
    ivBytes[14] = (sn >>> 8) & 0xff
    ivBytes[15] = sn & 0xff
    iv = ivBytes.buffer
  }
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data)
}

// 触发浏览器下载
const triggerDownload = (blob: Blob, filename: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const ensureFfmpegReady = async () => {
  if (ffmpegInstance && ffmpegUtil) return
  if (!ffmpegLoadTask) {
    ffmpegLoadTask = (async () => {
      const [{ FFmpeg }, utilModule] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util')
      ])
      const ffmpeg = new FFmpeg()
      ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        // 下载阶段占 0-90，转码阶段占 90-100
        const transcodeProgress = 90 + Math.round(Math.max(0, Math.min(1, progress)) * 10)
        if (transcodeProgress > downloadProgress.value) {
          downloadProgress.value = transcodeProgress
        }
      })
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'
      const coreURL = await utilModule.toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
      const wasmURL = await utilModule.toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
      await ffmpeg.load({
        coreURL,
        wasmURL
      })
      ffmpegInstance = ffmpeg
      ffmpegUtil = { fetchFile: utilModule.fetchFile, toBlobURL: utilModule.toBlobURL }
    })()
  }
  try {
    await ffmpegLoadTask
  } catch (e) {
    ffmpegLoadTask = null
    ffmpegInstance = null
    ffmpegUtil = null
    throw e
  }
}

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const totalBytes = chunks.reduce((sum, seg) => sum + seg.byteLength, 0)
  const merged = new Uint8Array(totalBytes)
  let cursor = 0
  for (const seg of chunks) {
    merged.set(seg, cursor)
    cursor += seg.byteLength
  }
  return merged
}

const mergeSegmentsToMp4 = async (videoSegments: Uint8Array[], audioSegments: Uint8Array[] = []): Promise<Blob> => {
  await ensureFfmpegReady()
  if (!ffmpegInstance || !ffmpegUtil) throw new Error('FFmpeg 初始化失败')

  if (!videoSegments.length) {
    throw new Error('未获取到视频分片')
  }

  const videoMerged = concatChunks(videoSegments)
  await ffmpegInstance.writeFile('video.ts', await ffmpegUtil.fetchFile(new Blob([videoMerged], { type: 'video/mp2t' })))

  if (audioSegments.length > 0) {
    const audioMerged = concatChunks(audioSegments)
    await ffmpegInstance.writeFile('audio.ts', await ffmpegUtil.fetchFile(new Blob([audioMerged], { type: 'audio/mp2t' })))
    await ffmpegInstance.exec([
      '-y',
      '-i', 'video.ts',
      '-i', 'audio.ts',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      'output.mp4'
    ])
  } else {
    await ffmpegInstance.exec([
      '-y',
      '-i', 'video.ts',
      '-c', 'copy',
      '-movflags', '+faststart',
      'output.mp4'
    ])
  }

  const outData = await ffmpegInstance.readFile('output.mp4') as Uint8Array

  try { await ffmpegInstance.deleteFile('video.ts') } catch {}
  try { await ffmpegInstance.deleteFile('audio.ts') } catch {}
  try { await ffmpegInstance.deleteFile('output.mp4') } catch {}

  return new Blob([outData], { type: 'video/mp4' })
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
  downloadProgress.value = 0
  errorMessage.value = ''
  downloadAbortController = new AbortController()

  try {
    const idx = playlist.value.indexOf(url)
    const filename = getVideoName(normalizedUrl, idx >= 0 ? idx : currentIndex.value) || `video_${Date.now()}`
    const isHlsVideo = isHlsUrl(normalizedUrl)

    if (isHlsVideo) {
      const { videoSegments, audioSegments } = await getM3u8DownloadPlan(normalizedUrl, downloadAbortController.signal)
      const total = videoSegments.length + audioSegments.length
      if (total === 0) {
        throw new Error('M3U8 分片为空，无法下载')
      }
      const videoChunks: Uint8Array[] = new Array(videoSegments.length)
      const audioChunks: Uint8Array[] = new Array(audioSegments.length)
      const CONCURRENCY = 6
      let completed = 0
      let pointer = 0
      hlsKeyCache.clear()
      type DownloadTask = { kind: 'video' | 'audio'; idx: number } & HlsSegment
      const tasks: DownloadTask[] = [
        ...videoSegments.map((seg, idx) => ({ kind: 'video' as const, idx, ...seg })),
        ...audioSegments.map((seg, idx) => ({ kind: 'audio' as const, idx, ...seg }))
      ]

      const runWorker = async () => {
        while (pointer < total) {
          const current = pointer++
          const task = tasks[current]
          const res = await fetch(getProxyUrl(task.url), { signal: downloadAbortController?.signal })
          if (!res.ok) {
            throw new Error(`下载分片失败: ${res.status}`)
          }
          const raw = await res.arrayBuffer()
          const decrypted = await decryptHlsSegment(raw, task, downloadAbortController?.signal)
          const chunk = new Uint8Array(decrypted)
          if (task.kind === 'video') {
            videoChunks[task.idx] = chunk
          } else {
            audioChunks[task.idx] = chunk
          }
          completed++
          downloadProgress.value = Math.min(90, Math.round((completed / total) * 90))
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => runWorker())
      await Promise.all(workers)
      hlsKeyCache.clear()

      downloadProgress.value = 92
      const mp4Blob = await mergeSegmentsToMp4(videoChunks, audioChunks)
      const outName = filename.replace(/\.[^.]+$/, '') + '.mp4'
      triggerDownload(mp4Blob, outName)
      downloadProgress.value = 100
      useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
    } else {
      const res = await fetch(getProxyUrl(normalizedUrl), { signal: downloadAbortController.signal })
      if (!res.ok) throw new Error(`下载失败: ${res.status}`)
      const blob = await res.blob()
      downloadProgress.value = 100
      const outName = filename.includes('.mp4') ? filename : filename + '.mp4'
      triggerDownload(blob, outName)
      useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      useToast().add({ title: '下载已取消', color: 'amber', timeout: 2000 })
      return
    }
    console.error('下载失败:', e)
    let msg = e instanceof Error ? e.message : String(e)
    if (!useProxy.value && (msg.includes('fetch') || msg.includes('CORS') || msg.includes('403'))) {
      msg += '，可尝试开启「使用跨域代理」'
    }
    errorMessage.value = '下载失败: ' + msg
  } finally {
    isDownloading.value = false
    downloadProgress.value = 0
    downloadAbortController = null
  }
}

// 取消下载
const cancelDownload = () => {
  downloadAbortController?.abort()
  downloadAbortController = null
  isDownloading.value = false
  downloadProgress.value = 0
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

// ========== 自适应并行预取 ==========

// 根据缓冲健康度决定并发预取数：缓冲越少 → 线程越多
const getAdaptivePrefetchCount = (bufferSecs: number): number => {
  if (bufferSecs < 5)  return 6  // 紧张：全速预取
  if (bufferSecs < 20) return 5  // 偏低：加速预取
  if (bufferSecs < 60) return 4  // 充足：正常预取
  return 2                        // 富余：慢速预取，节省带宽
}

// 创建自定义 HLS 分片加载器（fLoader）
// 优先从预取缓存返回数据，cache miss 时走 fetch 正常加载
const createHlsFragLoader = () => {
  return class PrefetchFragLoader {
    context: any
    // hls.js 在创建 loader 实例后立刻执行 frag.stats = loader.stats，
    // 时机早于 load() 调用。若此处不提前初始化，frag.stats 会是 undefined，
    // AbrController 的 setInterval 轮询时读 frag.stats.loading 直接崩溃。
    stats: any = {
      aborted: false, loaded: 0, total: 0,
      retry: 0, chunkCount: 0, bwEstimate: 0,
      loading:   { start: 0, first: 0, end: 0 },
      parsing:   { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    }
    private ctrl: AbortController | null = null

    load(context: any, config: any, callbacks: any): void {
      this.context = context
      const url: string = context.url
      const t0 = performance.now()

      // 重置 stats 字段（必须原地修改，不能替换整个对象）
      // frag.stats 持有的是同一个对象引用，替换会导致 frag.stats 仍指向旧的 undefined
      this.stats.aborted = false
      this.stats.loaded = 0
      this.stats.total = 0
      this.stats.retry = 0
      this.stats.chunkCount = 0
      this.stats.bwEstimate = 0
      this.stats.loading.start = t0
      this.stats.loading.first = 0
      this.stats.loading.end   = 0
      this.stats.parsing.start = 0
      this.stats.parsing.end   = 0
      this.stats.buffering.start = 0
      this.stats.buffering.first = 0
      this.stats.buffering.end   = 0

      const succeed = (data: ArrayBuffer) => {
        const t1 = performance.now()
        this.stats.loaded = data.byteLength
        this.stats.total  = data.byteLength
        this.stats.chunkCount = 1
        if (!this.stats.loading.first) this.stats.loading.first = t0 + 1
        this.stats.loading.end = t1
        callbacks.onSuccess({ data, url }, this.stats, context)
      }

      const fail = (e: Error) => {
        this.stats.loading.end = performance.now()
        callbacks.onError({ code: 0, text: e.message }, context, null, this.stats)
      }

      // 1. 命中预取缓存 → 即时返回（保留缓存供回放复用，不立即删除）
      if (segPrefetchCache.has(url)) {
        const buf = segPrefetchCache.get(url)!
        // 重新插入使其成为 Map 中最新（LRU 刷新），下载时也可复用
        segPrefetchCache.delete(url)
        segPrefetchCache.set(url, buf)
        prefetchInfo.value.cached = segPrefetchCache.size
        succeed(buf)
        return
      }

      // 2. 正在预取中 → 等待 Promise，完成后也存入缓存
      if (segPrefetching.has(url)) {
        segPrefetching.get(url)!
          .then(buf => {
            if (buf.byteLength > 0) {
              // 预取完成的数据已在 segPrefetchCache，直接命中
              succeed(buf)
            } else {
              this.doFetch(url, config, succeed, fail)
            }
          })
          .catch(() => this.doFetch(url, config, succeed, fail))
        return
      }

      // 3. 普通加载
      this.doFetch(url, config, succeed, fail)
    }

    private doFetch(url: string, config: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void) {
      this.ctrl = new AbortController()
      const timeout = config?.timeout ?? 30000
      const timer = setTimeout(() => this.ctrl?.abort(), timeout)
      fetch(getProxyUrl(url), { signal: this.ctrl.signal })
        .then(r => {
          clearTimeout(timer)
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          // 标记首字节时间，供 AbrController 带宽估算使用
          this.stats.loading.first = performance.now()
          return r.arrayBuffer()
        })
        .then(succeed)
        .catch(e => { clearTimeout(timer); if (e?.name !== 'AbortError') fail(e instanceof Error ? e : new Error(String(e))) })
    }

    abort(): void {
      this.ctrl?.abort()
      if (this.stats) this.stats.aborted = true
    }
    destroy(): void { this.abort() }
  }
}

// 触发自适应预取（每次 FRAG_BUFFERED 后调用）
const triggerAdaptivePrefetch = (lastFragSn: number) => {
  if (!hls || !videoEl.value) return

  // 全程代理模式（!manifestOnly）时禁用预取：
  // 预取请求和 hls.js 分片请求会竞争同一个 Nitro 服务线程，反而拖慢实际播放。
  // manifestOnly=true 时分片直连 CDN，不经过服务端，无竞争，可正常预取。
  if (disguiseAsDownloader.value) return
  if ((requestOrigin.value.trim() || effectiveReferer.value) && !manifestOnly.value) return

  const video = videoEl.value
  const bufferSecs = video.buffered.length > 0
    ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime)
    : 0
  const count = getAdaptivePrefetchCount(bufferSecs)

  // 更新状态显示
  prefetchInfo.value = {
    bufferSecs: Math.round(bufferSecs * 10) / 10,
    threads: count,
    cached: segPrefetchCache.size,
    pending: segPrefetching.size,
  }

  if (count === 0) return

  // 取当前画质的分片列表
  const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
  const levelDetails = (hls as any).levels?.[level]?.details
  if (!levelDetails) return

  const frags: any[] = levelDetails.fragments
  const startIdx = frags.findIndex((f: any) => f.sn === lastFragSn) + 1
  if (startIdx <= 0) return

  // 计算还能发起几个新请求（不超过并发上限）
  const canStart = Math.max(0, count - segPrefetching.size)
  if (canStart === 0) return

  // 候选窗口：从 startIdx 往后扫描，最多看 count*3 个，足以跳过已缓存/下载中的
  const candidates = frags.slice(startIdx, startIdx + count * 3)

  let started = 0
  for (const frag of candidates) {
    if (started >= canStart) break
    const url: string = frag.url
    if (!url || segPrefetchCache.has(url) || segPrefetching.has(url)) continue

    const promise = fetch(getProxyUrl(url))
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(buf => {
        segPrefetchCache.set(url, buf)
        segPrefetching.delete(url)
        prefetchInfo.value.cached = segPrefetchCache.size
        prefetchInfo.value.pending = segPrefetching.size
        evictPrefetchCache()
        // 完成1个 → 补充1个，维持并发数（不递归全量触发，避免请求爆炸）
        startOnePrefetch()
        return buf
      })
      .catch(() => {
        segPrefetching.delete(url)
        prefetchInfo.value.pending = segPrefetching.size
        return new ArrayBuffer(0)
      })

    segPrefetching.set(url, promise)
    started++
  }

  prefetchInfo.value.pending = segPrefetching.size

  // 按内存上限 LRU 淘汰（在新分片加入后检查）
  evictPrefetchCache()
}

// ========== end 自适应并行预取 ==========

// LRU 淘汰：按 hlsConfig.maxBufferSizeMB 控制预取缓存总大小，超出则删除最旧的分片
const evictPrefetchCache = () => {
  const limitBytes = hlsConfig.value.maxBufferSizeMB * 1024 * 1024
  // 计算当前缓存总占用
  let totalBytes = 0
  for (const buf of segPrefetchCache.values()) totalBytes += buf.byteLength
  if (totalBytes <= limitBytes) return
  // 按插入顺序（Map 保证）删除最旧的，直到低于上限
  for (const [key, buf] of segPrefetchCache) {
    if (totalBytes <= limitBytes) break
    totalBytes -= buf.byteLength
    segPrefetchCache.delete(key)
  }
  prefetchInfo.value.cached = segPrefetchCache.size
}

// 完成1个分片后补充1个，基于当前播放进度定位下一个未下载分片
const startOnePrefetch = () => {
  if (!hls || !videoEl.value) return
  const video = videoEl.value
  const bufferSecs = video.buffered.length > 0
    ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime)
    : 0
  const count = getAdaptivePrefetchCount(bufferSecs)

  // 更新状态
  prefetchInfo.value.bufferSecs = Math.round(bufferSecs * 10) / 10
  prefetchInfo.value.threads = count
  prefetchInfo.value.cached = segPrefetchCache.size
  prefetchInfo.value.pending = segPrefetching.size

  if (count === 0 || segPrefetching.size >= count) return

  const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
  const frags: any[] = (hls as any).levels?.[level]?.details?.fragments ?? []
  if (!frags.length) return

  // 从当前播放时间往后找第一个未缓存、未下载中的分片
  const currentTime = video.currentTime
  for (const frag of frags) {
    if (frag.start < currentTime) continue
    const url: string = frag.url
    if (!url || segPrefetchCache.has(url) || segPrefetching.has(url)) continue

    const promise = fetch(getProxyUrl(url))
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(buf => {
        segPrefetchCache.set(url, buf)
        segPrefetching.delete(url)
        prefetchInfo.value.cached = segPrefetchCache.size
        prefetchInfo.value.pending = segPrefetching.size
        evictPrefetchCache()
        startOnePrefetch()
        return buf
      })
      .catch(() => {
        segPrefetching.delete(url)
        prefetchInfo.value.pending = segPrefetching.size
        return new ArrayBuffer(0)
      })

    segPrefetching.set(url, promise)
    prefetchInfo.value.pending = segPrefetching.size
    break  // 只补1个
  }
}

// 加载视频
// 清除加载超时定时器
const clearLoadTimeout = () => {
  if (loadTimeoutTimer) {
    clearTimeout(loadTimeoutTimer)
    loadTimeoutTimer = null
  }
}

// 启动加载超时检测
const startLoadTimeout = () => {
  clearLoadTimeout()
  hasReceivedData = false
  
  loadTimeoutTimer = setTimeout(() => {
    if (!hasReceivedData && isLoading.value) {
      console.log('加载超时，3秒内未收到有效数据')
      errorMessage.value = '加载超时，视频链接可能已过期或无法访问（403/404）'
      isLoading.value = false
      isBuffering.value = false
      isVideoLoaded.value = false
      destroyHls()
    }
  }, LOAD_TIMEOUT)
}

// 标记已收到有效数据
const markDataReceived = () => {
  hasReceivedData = true
  clearLoadTimeout()
}

const loadVideo = async () => {
  if (!videoUrl.value.trim()) return
  
  errorMessage.value = ''
  isLoading.value = true
  isBuffering.value = true
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
  bufferedPercent.value = 0
  hlsRetryCount.value = 0  // 重置重试计数
  
  // 强制重新创建 video 元素，彻底重置状态
  videoKey.value++
  
  isVideoLoaded.value = true
  isLocalFile.value = false  // URL 加载不是本地文件
  destroyHls()
  
  // 启动加载超时检测
  startLoadTimeout()
  
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
    isBuffering.value = false
    isVideoLoaded.value = false
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
    // 自定义分片加载器：接管分片请求，命中预取缓存直接返回
    fLoader: createHlsFragLoader() as any,
    // Origin/Referer 由 /api/proxy 服务端注入，XHR 层只需关闭 credentials
    xhrSetup: (xhr: XMLHttpRequest) => {
      xhr.withCredentials = false
    }
  })
  
  hls.loadSource(finalUrl)
  hls.attachMedia(videoEl.value)
  
  // manifest 解析完成
  hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    console.log('HLS manifest 解析完成，画质数:', data.levels.length)
    markDataReceived()  // 标记收到有效数据
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
          hlsRetryCount.value++
          if (hlsRetryCount.value <= MAX_HLS_RETRY) {
            console.log(`网络错误，尝试恢复... (${hlsRetryCount.value}/${MAX_HLS_RETRY})`)
            errorMessage.value = `网络错误，正在重试 (${hlsRetryCount.value}/${MAX_HLS_RETRY})...`
            setTimeout(() => {
              hls?.startLoad()
            }, 1000)
          } else {
            // 超过重试次数，停止加载
            const errMsg = data.details === 'manifestLoadError' 
              ? '视频链接无效或已过期，请检查链接是否正确'
              : `网络错误: ${data.details}，链接可能已过期`
            errorMessage.value = errMsg
            isLoading.value = false
            isBuffering.value = false
            isVideoLoaded.value = false
            destroyHls()
          }
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
          isLoading.value = false
          isBuffering.value = false
          isVideoLoaded.value = false
          destroyHls()
      }
    }
  })
  
  // 分片加载完成 → 更新统计 + 触发自适应预取
  hls.on(Hls.Events.FRAG_BUFFERED, (_, data) => {
    updateHlsStats()
    isBuffering.value = false
    if (data?.frag != null) {
      triggerAdaptivePrefetch(data.frag.sn)
    }
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

// 计算当前播放位置前方的缓冲秒数
const getAheadBuffered = (video: HTMLVideoElement): number => {
  const ct = video.currentTime
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= ct + 0.1 && ct <= video.buffered.end(i)) {
      return video.buffered.end(i) - ct
    }
  }
  return 0
}

// 更新 HLS 统计信息
const updateHlsStats = () => {
  if (!hls || !videoEl.value) return

  const video = videoEl.value
  const buffered = getAheadBuffered(video)
  
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
  // 清除加载超时定时器
  clearLoadTimeout()
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
  // 清空预取缓存
  segPrefetchCache.clear()
  segPrefetching.clear()
  prefetchInfo.value = { bufferSecs: 0, threads: 0, cached: 0, pending: 0 }
  cancelDownload()
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

// 开始拖动进度条（兼容单击和拖拽，避免双重 seek）
const startSeek = (e: MouseEvent) => {
  if (!progressBar.value || !videoEl.value || !duration.value) return

  isSeeking.value = true
  updateSeekPreview(e)

  const onMove = (e: MouseEvent) => {
    updateSeekPreview(e)
  }

  const onUp = (e: MouseEvent) => {
    isSeeking.value = false
    seekPreviewTime.value = null

    if (progressBar.value && videoEl.value) {
      const rect = progressBar.value.getBoundingClientRect()
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      videoEl.value.currentTime = percent * duration.value
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
  
  // 更新缓冲进度（取包含当前播放位置的区间末尾）
  if (videoEl.value.buffered.length > 0 && duration.value > 0) {
    const aheadEnd = videoEl.value.currentTime + getAheadBuffered(videoEl.value)
    bufferedPercent.value = (aheadEnd / duration.value) * 100
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
  markDataReceived()  // 标记收到有效数据
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
  clearLoadTimeout()  // 清除超时定时器
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
          msg = '网络错误，可能是跨域问题或链接已过期，请尝试开启"使用跨域代理"或检查链接'
        }
        break
      case MediaError.MEDIA_ERR_DECODE:
        msg = '视频解码失败'
        break
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        if (useProxy.value) {
          msg = '视频源被拒绝（可能有防盗链），请关闭代理直接播放，或拖拽本地文件播放'
        } else {
          msg = '不支持的视频格式或链接已过期，请检查链接是否正确'
        }
        break
    }
  }
  
  console.error('视频错误:', error)
  errorMessage.value = msg
  isLoading.value = false
  isBuffering.value = false
  isVideoLoaded.value = false
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

let seekBufferingTimer: ReturnType<typeof setTimeout> | null = null

// 开始 seek：延迟显示 loading，避免已缓冲区域的快速 seek 闪烁转圈
const onSeeking = () => {
  if (seekBufferingTimer) clearTimeout(seekBufferingTimer)
  seekBufferingTimer = setTimeout(() => {
    seekBufferingTimer = null
    isBuffering.value = true
  }, 150)
}

// seek 完成
const onSeeked = () => {
  // 取消还未触发的 buffering 显示（说明 seek 在缓冲区内完成，无需 loading）
  if (seekBufferingTimer) {
    clearTimeout(seekBufferingTimer)
    seekBufferingTimer = null
  }
  // 只有 seek 到缓冲区外才清空预取缓存；缓冲区内完成则保留
  const inBuffer = videoEl.value ? getAheadBuffered(videoEl.value) > 0 : false
  if (!inBuffer) {
    segPrefetchCache.clear()
    segPrefetching.clear()
    prefetchInfo.value.cached = 0
    prefetchInfo.value.pending = 0
  }
  isBuffering.value = false
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
  saveState()
}

const resetHlsConfig = () => {
  hlsConfig.value = {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    maxBufferSizeMB: 600,
    fragLoadingTimeOut: 30000,
    fragLoadingMaxRetry: 3,
    enableWorker: true,
    lowLatencyMode: false,
  }
  saveState()
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
    requestOrigin.value = savedState.requestOrigin ?? ''
    requestReferer.value = savedState.requestReferer ?? ''
    manifestOnly.value = savedState.manifestOnly ?? true
    disguiseAsDownloader.value = savedState.disguiseAsDownloader ?? false
    if (savedState.hlsConfig) {
      hlsConfig.value = { ...hlsConfig.value, ...savedState.hlsConfig }
    }

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
  clearLoadTimeout()  // 清除加载超时定时器
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('beforeunload', saveCurrentProgress)
  if (controlsTimer) clearTimeout(controlsTimer)
  if (playIconTimer) clearTimeout(playIconTimer)
  if (progressSaveTimer) clearTimeout(progressSaveTimer)
  if (delayedPlayTimer) clearTimeout(delayedPlayTimer)
  if (seekBufferingTimer) clearTimeout(seekBufferingTimer)
  
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
