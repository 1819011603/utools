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
          <UCheckbox v-model="autoBestRate" label="自动最佳倍速（≥1x，按带宽提速不卡）" @change="saveState" />
        </div>

        <!-- 连接策略：起播前实测探测「清单 / 分片」两轴各自能走哪条通道，可展开手动覆盖 -->
        <div class="flex gap-2 flex-wrap items-center text-sm">
          <UBadge :color="manualStrategyOverride ? 'amber' : (isProbing ? 'gray' : 'sky')" variant="soft" size="xs">
            连接策略：{{ strategyLabel }}
          </UBadge>
          <span class="text-xs text-gray-400">
            {{ manualStrategyOverride ? '你已手动调整，改任一项即生效；点“恢复自动”交回引擎' : '清单与分片各自实测直连/代理是否可达，改任一项即转手动' }}
          </span>
          <button v-if="manualStrategyOverride" class="text-xs text-violet-500 hover:text-violet-700" @click="resetToAuto">
            恢复自动
          </button>
          <button class="text-xs text-violet-500 hover:text-violet-700" @click="showAdvancedProxy = !showAdvancedProxy">
            {{ showAdvancedProxy ? '收起' : '展开设置…' }}
          </button>
        </div>

        <!-- 连接设置：自动时反映引擎当前选择；改任一项即转手动 -->
        <div v-if="showAdvancedProxy" class="flex gap-4 flex-wrap items-end p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
          <UFormGroup label="Origin" help="注入请求头 Origin，用于绕过防盗链（可下拉选历史）">
            <UInput
              v-model="requestOrigin"
              list="vp-origin-history"
              placeholder="https://example.com"
              class="w-52"
              @change="onManualProxyChange"
            />
          </UFormGroup>
          <UFormGroup label="Referer" :help="refererHelp">
            <UInput
              v-model="requestReferer"
              list="vp-referer-history"
              :placeholder="effectiveReferer || 'https://example.com/'"
              class="w-64"
              @change="onManualProxyChange"
            />
          </UFormGroup>
          <datalist id="vp-origin-history">
            <option v-for="o in originSuggestions" :key="o" :value="o" />
          </datalist>
          <datalist id="vp-referer-history">
            <option v-for="r in refererSuggestions" :key="r" :value="r" />
          </datalist>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="manifestOnly"
              label="仅代理 Manifest"
              :disabled="manifestOnlyDisabled"
              :title="manifestOnlyDisabled ? '需先启用代理（伪装下载器或注入 Origin/Referer），否则代理不介入，此项无效' : '代理 manifest 补 CORS/绕防盗链，分片仍直连 CDN（更快、省服务器流量）'"
              @change="onManualProxyChange"
            />
          </UFormGroup>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="dualChannel"
              label="直连+代理双通道"
              :disabled="dualChannelUnavailable"
              :title="dualChannelHint"
              @change="saveState"
            />
          </UFormGroup>

          <!-- 可达性探测矩阵：排查源站为什么走这条路（✓ 通 / ✗ 不通 / ? 超时未判定）-->
          <div v-if="probeRows.length" class="w-full pt-2 border-t border-gray-200 dark:border-gray-700">
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-xs font-medium text-gray-500 dark:text-gray-400">可达性探测</span>
              <button class="text-xs text-violet-500 hover:text-violet-700" :disabled="isProbing" @click="reprobeNow">
                {{ isProbing ? '探测中…' : '重新探测' }}
              </button>
            </div>
            <div class="space-y-1">
              <div v-for="row in probeRows" :key="row.name" class="flex items-center gap-2 text-xs">
                <span class="w-8 text-gray-500 dark:text-gray-400">{{ row.name }}</span>
                <span
                  v-for="cell in row.cells"
                  :key="cell.channel"
                  class="px-1.5 py-0.5 rounded font-mono"
                  :class="{
                    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300': cell.reach === 'ok',
                    'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300': cell.reach === 'fail',
                    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': cell.reach === 'unknown',
                    'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500': cell.reach === 'skip',
                  }"
                  :title="cell.reach === 'unknown' ? '超时，未判定' : (cell.reach === 'skip' ? '未探测：已有更优通道可用' : '')"
                >
                  {{ cell.reach === 'ok' ? '✓' : cell.reach === 'fail' ? '✗' : cell.reach === 'unknown' ? '?' : '–' }} {{ cell.label }}
                  <span v-if="cell.ms" class="opacity-60">{{ cell.ms }}ms</span>
                </span>
              </div>
            </div>
          </div>
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
          <div class="max-h-64 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
              <div
                v-for="(item, index) in playlist"
                :key="index"
                class="relative group/item rounded cursor-pointer transition-colors text-sm text-center px-2 py-2 truncate"
                :class="[
                  index === currentIndex
                    ? 'bg-violet-500 text-white font-medium'
                    : 'bg-white dark:bg-gray-700 hover:bg-violet-100 dark:hover:bg-gray-600',
                  // 看过的（有进度记录）标成琥珀色，跟没看过的区分开
                  index !== currentIndex && getSavedProgress(item) > 0
                    ? 'text-amber-600 dark:text-amber-400'
                    : '',
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
                <!-- 下载按钮压在右上角，hover 才出现，免得占掉格子宽度 -->
                <button
                  v-if="item.startsWith('http') && !isDownloading"
                  class="absolute -top-1 -right-1 opacity-0 group-hover/item:opacity-100 p-1 rounded-full bg-violet-500 text-white shadow transition-opacity"
                  title="下载这一集"
                  @click.stop="downloadVideo(item)"
                >
                  <UIcon name="i-heroicons-arrow-down-tray" class="w-3 h-3 block" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-end">
          <UButton size="xs" variant="soft" :color="deepLinkCopied ? 'green' : 'gray'" @click="copyDeepLink">
            <UIcon :name="deepLinkCopied ? 'i-heroicons-check' : 'i-heroicons-link'" class="w-4 h-4 mr-1" />
            {{ deepLinkCopied ? '已复制' : '复制当前直链' }}
          </UButton>
        </div>

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

        <!-- 加载中 -->
        <div 
          v-if="isBuffering" 
          class="absolute inset-0 flex items-center justify-center bg-black/30"
        >
          <div class="flex flex-col items-center gap-2">
            <UIcon name="i-heroicons-arrow-path" class="w-12 h-12 text-white animate-spin" />
            <span class="text-white text-sm">{{ isProbing ? '正在探测连接方式...' : '加载中...' }}</span>
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
                    :title="autoBestRate && playbackRate !== desiredRate ? `目标 ${desiredRate}x，带宽受限实际 ${playbackRate}x` : ''"
                  >
                    {{ playbackRate }}x<span v-if="autoBestRate && playbackRate !== desiredRate" class="text-white/50">/{{ desiredRate }}</span>
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
                        :class="{ 'bg-violet-500': desiredRate === rate }"
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
          <UFormGroup label="缓冲内存" help="预取缓存内存上限（JS 侧，非 MSE）">
            <div class="flex items-center gap-2">
              <UInput
                v-model.number="hlsConfig.maxBufferSizeMB"
                type="number"
                :min="30"
                :max="8000"
                class="flex-1"
              />
              <span class="text-sm text-gray-500">MB</span>
            </div>
          </UFormGroup>
        </div>

        <!-- 抗卡策略（服务器档位参数）：留空=用当前档位预设（灰字占位） -->
        <div class="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium">抗卡策略</span>
            <UBadge :color="tierBadgeColor" variant="subtle" size="xs">
              当前档位：{{ tierLabel }}{{ tierIsAuto ? '（自动）' : '（锁定）' }}
            </UBadge>
            <UButton v-if="hasTierOverride" size="2xs" variant="ghost" color="gray" @click="clearTierOverrides">
              清除覆盖 · 跟随档位
            </UButton>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            留空 = 用档位预设（灰字）；改动即覆盖当前档位。档位在「站点规则」里可手动锁定「好/中/差」或让引擎自动分档。
          </p>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <UFormGroup label="濒卡阈值(秒)" help="MSE 前向低于此=濒卡→降速/跳片">
              <UInput v-model.number="tierOverrides.panicSecs" type="number" :min="2" :max="30" size="xs" :placeholder="String(tierDefaults.panicSecs)" />
            </UFormGroup>
            <UFormGroup label="吃紧阈值(秒)" help="MSE 前向低于此=吃紧→并发爬坡">
              <UInput v-model.number="tierOverrides.lowSecs" type="number" :min="5" :max="90" size="xs" :placeholder="String(tierDefaults.lowSecs)" />
            </UFormGroup>
            <UFormGroup label="安全系数" help="供给带宽相对消耗的冗余倍数">
              <UInput v-model.number="tierOverrides.safety" type="number" :min="1" :max="3" :step="0.1" size="xs" :placeholder="String(tierDefaults.safety)" />
            </UFormGroup>
            <UFormGroup label="并发下限" help="起播即保证的最小并行连接数">
              <UInput v-model.number="tierOverrides.concurrencyFloor" type="number" :min="1" :max="6" size="xs" :placeholder="String(tierDefaults.concurrencyFloor)" />
            </UFormGroup>
            <UFormGroup label="对冲延迟(ms)" help="关键分片超此→追加竞速连接">
              <UInput v-model.number="tierOverrides.hedgeMs" type="number" :min="1000" :max="15000" :step="500" size="xs" :placeholder="String(tierDefaults.hedgeMs)" />
            </UFormGroup>
            <UFormGroup label="跳片超时(ms)" help="关键分片超此→跳过（先降速后才跳）">
              <UInput v-model.number="tierOverrides.skipMs" type="number" :min="5000" :max="60000" :step="1000" size="xs" :placeholder="String(tierDefaults.skipMs)" />
            </UFormGroup>
            <UFormGroup label="竞速上限" help="单个关键分片最多并行竞速连接数">
              <UInput v-model.number="tierOverrides.maxRacers" type="number" :min="1" :max="8" size="xs" :placeholder="String(tierDefaults.maxRacers)" />
            </UFormGroup>
          </div>
        </div>

        <!-- 高级设置 -->
        <div class="flex flex-wrap gap-x-8 gap-y-3">
          <div class="space-y-1">
            <UCheckbox v-model="hlsConfig.enableWorker" label="启用 Web Worker" />
            <p class="text-xs text-gray-500 dark:text-gray-400 pl-6">分片解析放到后台线程，播放更流畅、界面不卡顿（建议开启）</p>
          </div>
          <div class="space-y-1">
            <UCheckbox v-model="hlsConfig.lowLatencyMode" label="低延迟模式（直播）" />
            <p class="text-xs text-gray-500 dark:text-gray-400 pl-6">仅对 LL-HLS 直播源有效，压低直播延迟；点播请保持关闭</p>
          </div>
        </div>

        <!-- 实时状态 -->
        <div v-if="hlsStats" class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
          <!-- 服务器档位 + 缓冲健康区 + 真实卡顿 -->
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <UBadge :color="tierBadgeColor" variant="subtle" size="xs">
              服务器：{{ tierLabel }}{{ tierIsAuto ? '（自动）' : '（锁定）' }}
            </UBadge>
            <UBadge
              :color="strategy.healthZone === 'panic' ? 'red' : strategy.healthZone === 'low' ? 'amber' : 'green'"
              variant="subtle" size="xs"
            >
              {{ strategy.healthZone === 'panic' ? '濒卡' : strategy.healthZone === 'low' ? '吃紧' : '健康' }}
            </UBadge>
            <UBadge v-if="guardRateCeiling < 99" color="amber" variant="subtle" size="xs">抗卡降速中</UBadge>
            <UBadge :color="stall.stallCount.value > 0 ? 'red' : 'green'" variant="subtle" size="xs">
              卡顿 {{ stall.stallCount.value }} 次 / {{ (stall.stallMsTotal.value / 1000).toFixed(1) }}s
            </UBadge>
            <UBadge color="gray" variant="subtle" size="xs">连续流畅 {{ stall.getSmoothSecs().toFixed(0) }}s</UBadge>
            <UBadge :color="strategy.aggregateScales ? 'green' : 'red'" variant="subtle" size="xs">
              {{ strategy.aggregateScales ? '可并行' : '带宽硬顶' }}
            </UBadge>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
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
              <span class="font-medium" :class="prefetchInfo.threads >= 5 ? 'text-red-500' : prefetchInfo.threads >= 3 ? 'text-amber-500' : 'text-green-500'">
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
          <!-- 实测策略引擎 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
            <div>
              <span class="text-gray-500">单连接速度：</span>
              <span class="font-medium">{{ strategy.perConnKBps }} KB/s</span>
            </div>
            <div>
              <span class="text-gray-500">聚合速度：</span>
              <span class="font-medium" :class="dualChannel && !dualChannelUnavailable ? 'text-green-500' : ''">
                {{ aggregateKBps }} KB/s
                <span class="text-xs text-gray-400">({{ aggregateMbps }} Mbps)</span>
              </span>
            </div>
            <div>
              <span class="text-gray-500">视频码率：</span>
              <span class="font-medium">{{ strategy.segMbps }} Mbps</span>
            </div>
            <div>
              <span class="text-gray-500">目标并发：</span>
              <span class="font-medium">{{ strategy.targetConn }}</span>
            </div>
            <div>
              <span class="text-gray-500">最高流畅倍速：</span>
              <span class="font-medium" :class="strategy.maxFluentRate < playbackRate ? 'text-red-500' : 'text-green-500'">
                {{ strategy.maxFluentRate }}x
              </span>
            </div>
          </div>
          <!-- 播放卡点诊断：已缓冲一直加却不播时看这里 -->
          <div class="text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
            <span class="text-gray-500">播放状态：</span>
            <span class="font-medium">{{ playbackDiag }}</span>
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
import type { SiteRule, ServerTier, TierParams } from '~/composables/videoSiteRules'
import type { ProbeResult, ConnConfig, AxisProbe } from '~/composables/useReachabilityProbe'

// 动态导入 hls.js（避免 SSR 问题）
let Hls: typeof HlsType | null = null

// ── URL 参数直链：/video-player?url=xxx 打开即播 ──
// 支持的本页参数：
//   url            视频地址，可重复传多个组成播放列表（?url=a&url=b）
//   urls           一次传多个，用 | 或换行分隔
//   index          起播第几个（0 基）
//   origin/referer 注入的防盗链头；proxy=1 全程代理；noref=1 伪装下载器；manifestOnly=0/1
// 关键坑：视频地址自带 query（?token=1&sign=2）时，未编码的 & 会被路由拆成独立参数，
// 直接读 route.query.url 只能拿到 sign 之前的部分。所以这里从原始 search 串手工解析：
// 凡「不是本页已知参数」的片段，一律原样回写进最近的那个视频地址。
const PAGE_QUERY_KEYS = new Set([
  'url', 'urls', 'index', 'origin', 'referer', 'proxy', 'noref', 'manifestOnly', 'handoff',
])

// ── 长播放列表交接槽 ───────────────────────────────────────────
// 几十集的列表拼进 query 会顶爆地址栏（部分浏览器 2000 字符上界，硬刷新还要过 CF 的请求头上限），
// 所以改走 localStorage 交接：调用方（如 /video-parse）写这个槽 + 跳 ?handoff=1，本页读出来。
// 槽由本页持有，任何页面都能当生产者。带时间戳，过期的不用——避免半个月前的残留列表被翻出来。
const HANDOFF_KEY = 'video-player-handoff'
const HANDOFF_TTL = 24 * 60 * 60 * 1000

interface HandoffPayload {
  urls: string[]
  names?: string[]   // 集名（「第 12 集」这类），与 urls 同下标；解析页知道，光看 URL 猜不出来
  title?: string     // 剧名，同理
  // 来源：解析页地址 + 线路序号。带签名的地址会过期，靠这个能就地重新解析换新链接
  source?: { pageUrl: string; line: number }
  index?: number
  at: number
}

// 剧名，来自交接槽。播放器和播放列表的标题位都用它顶掉泛称。
const playlistTitle = ref('')
// 播放列表的来源，有值才显示「刷新链接」
const playlistSource = ref<{ pageUrl: string; line: number } | null>(null)
const isRefreshingLinks = ref(false)
const lastRefreshAt = ref(0)

// 播放列表的显示名，来自交接槽；查不到时 getVideoName 退回从 URL 猜文件名。
// 长剧每一集的地址都叫 index.m3u8，光看文件名分不清第几集。
//
// 按 URL 存而不是按下标存：下标要跟播放列表严格对齐，任何一处重新赋值 playlist
// 都得记着同步清理，漏一处就会把上一部剧的集名套到新列表上（这里踩过：onMounted
// 走 parseAndLoad 加载 query 地址，而 parseAndLoad 里的清理正好把刚读出的集名冲掉）。
// 按 URL 存则天然对齐，残留条目也只是查不中，无害。
const playlistNames = ref<Record<string, string>>({})

const setPlaylistNames = (urls: string[], names?: string[]) => {
  if (!names || names.length !== urls.length) return
  const map: Record<string, string> = { ...playlistNames.value }
  urls.forEach((u, i) => { if (names[i]) map[u] = names[i] })
  playlistNames.value = map
}

const readHandoff = (): HandoffPayload | null => {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as HandoffPayload
    if (!Array.isArray(p?.urls) || !p.urls.length) return null
    if (!p.at || Date.now() - p.at > HANDOFF_TTL) return null
    return p
  } catch {
    return null
  }
}

const writeHandoff = (urls: string[], index: number) => {
  try {
    // 名字要一起写回去，否则本页每次同步地址栏都会把交接槽里的集名冲掉
    const picked = urls.map(u => playlistNames.value[u] ?? '')
    const names = picked.every(Boolean) ? picked : undefined
    const title = playlistTitle.value || undefined
    const source = playlistSource.value ?? undefined
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ urls, names, title, source, index, at: Date.now() } as HandoffPayload))
  } catch (e) {
    console.error('写入播放列表交接槽失败:', e)
  }
}

interface QueryVideoParams {
  urls: string[]
  index?: number
  origin?: string
  referer?: string
  proxy?: boolean
  noref?: boolean
  manifestOnly?: boolean
}

const parseQueryVideoParams = (): QueryVideoParams => {
  const result: QueryVideoParams = { urls: [] }
  const raw = (typeof window === 'undefined' ? '' : window.location.search).replace(/^\?/, '')
  if (!raw) return result

  // 只做 percent 解码，不把 + 当空格：视频签名里常有裸 + 号，转成空格会直接 403
  const dec = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }
  const isTrue = (v: string) => v === '' || v === '1' || v.toLowerCase() === 'true'
  // 把「视频地址自带的 query 片段」接回最后一个地址
  const appendToLastUrl = (part: string) => {
    const i = result.urls.length - 1
    if (i < 0) return
    result.urls[i] += (result.urls[i].includes('?') ? '&' : '?') + part
  }

  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const val = eq === -1 ? '' : part.slice(eq + 1)

    if (!PAGE_QUERY_KEYS.has(key)) {
      appendToLastUrl(part)
      continue
    }

    switch (key) {
      case 'url': {
        const u = dec(val).trim()
        if (u) result.urls.push(u)
        break
      }
      case 'urls':
        dec(val).split(/[\n\r|]+/).map(s => s.trim()).filter(Boolean)
          .forEach(u => result.urls.push(u))
        break
      case 'index': {
        const n = Number.parseInt(dec(val), 10)
        if (Number.isFinite(n)) result.index = n
        break
      }
      case 'origin': result.origin = dec(val).trim(); break
      case 'referer': result.referer = dec(val).trim(); break
      case 'proxy': result.proxy = isTrue(val); break
      case 'noref': result.noref = isTrue(val); break
      case 'manifestOnly': result.manifestOnly = isTrue(val); break
      case 'handoff': {
        // 列表放在 localStorage 交接槽里，query 里只留个标记
        if (!isTrue(val)) break
        const p = readHandoff()
        if (!p) break
        p.urls.forEach(u => result.urls.push(u))
        setPlaylistNames(p.urls, p.names)
        if (p.title) playlistTitle.value = p.title
        if (p.source) playlistSource.value = p.source
        // ?index= 若显式给了以它为准，所以只在没给时才用槽里的
        if (result.index === undefined && Number.isFinite(p.index)) result.index = p.index
        break
      }
    }
  }

  // 短列表是用 urls= 传的（那样的链接能直接分享），集名则始终放在交接槽里。
  // 两边内容完全一致时才采用，避免把别的列表的名字套上来。
  if (result.urls.length) {
    const p = readHandoff()
    if (p && p.urls.length === result.urls.length && p.urls.every((u, i) => u === result.urls[i])) {
      setPlaylistNames(p.urls, p.names)
      if (p.title) playlistTitle.value = p.title
      if (p.source) playlistSource.value = p.source
    }
  }

  return result
}

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
  autoBestRate: boolean  // 自动最佳倍速
  skipIntro: number  // 跳过片头时间（秒）
  skipOutro: number  // 跳过片尾时间（秒）
  requestOrigin: string
  requestReferer: string
  manifestOnly: boolean
  disguiseAsDownloader: boolean
  dualChannel?: boolean            // 直连+代理双通道
  manualStrategyOverride: boolean  // 手动连接策略（持久化，避免刷新后被自动策略覆盖）
  hlsConfig: typeof hlsConfig.value
  tierOverrides?: Partial<TierParams>  // 抗卡策略参数覆盖（页面可调，空=跟随档位）
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
      playbackRate: desiredRate.value,  // 存用户选择的目标倍速（非自动下调后的实际值）
      useProxy: useProxy.value,
      autoFullscreen: autoFullscreen.value,
      autoBestRate: autoBestRate.value,
      skipIntro: skipIntro.value,
      skipOutro: skipOutro.value,
      requestOrigin: requestOrigin.value,
      requestReferer: requestReferer.value,
      manifestOnly: manifestOnly.value,
      disguiseAsDownloader: disguiseAsDownloader.value,
      dualChannel: dualChannel.value,
      manualStrategyOverride: manualStrategyOverride.value,
      hlsConfig: { ...hlsConfig.value },
      tierOverrides: { ...tierOverrides.value }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('保存状态失败:', e)
  }
}

// 保存当前视频进度
const saveCurrentProgress = () => {
  if (videoUrl.value && currentTime.value > 0) {
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
const errorMessage = ref('')
const isLoading = ref(false)
const useProxy = ref(false)
const requestOrigin = ref('')    // 自定义 Origin 请求头
const requestReferer = ref('')   // 自定义 Referer 请求头（空则自动为 origin + /）
const manifestOnly = ref(true)   // 仅代理 manifest，分片直连 CDN（更快）
const disguiseAsDownloader = ref(false)  // 默认直连不注入；自动可达性阶梯或站点规则可置真
const dualChannel = ref(false)  // 直连+代理双通道：分片在「直连 CDN」和「/api/proxy」两个 origin 间分流，把并发从 6 提到 ~12
// 代理 URL 生成（Origin/Referer 注入、manifestOnly、伪装下载器、CORS 代理）
const { isHlsUrl, effectiveReferer, refererHelp, getProxyUrl, getProxyPassthroughUrl, isDirectMode } = useVideoProxy({
  requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, useProxy,
})
// 「仅代理 Manifest」需要代理确实介入才有意义：伪装模式下它表示「代理 manifest 补 CORS + 分片直连」，
// 注入头模式下表示「manifest 走防盗链 + 分片直连」。两者都没有时代理压根不会介入，勾了无效 → 禁用。
const manifestOnlyDisabled = computed(() =>
  !disguiseAsDownloader.value && !requestOrigin.value.trim() && !requestReferer.value.trim())
// 双通道需要分片「直连」和「经代理」两条路都通。有探测结果就用实测，否则按当前配置推断。
const dualChannelUnavailable = computed(() => {
  const r = probeResult.value
  if (r && !r.degraded) return !(r.segment.direct === 'ok' && r.segment.disguise === 'ok')
  // 无探测数据（手动/规则/兜底阶梯）：跟 getProxyUrl 对分片(.ts)的判定保持一致——
  // 分片走代理时直连 lane 必 403/CORS，没有分流可言。
  if (disguiseAsDownloader.value) return !manifestOnly.value
  const hasHeaders = !!requestOrigin.value.trim() || !!requestReferer.value.trim()
  if (hasHeaders) return !manifestOnly.value
  return useProxy.value
})
const dualChannelHint = computed(() => {
  if (!dualChannelUnavailable.value) {
    return '分片在直连 CDN 与本站代理两个 origin 间分流，把并发从 6 提到 ~12（代价：占用服务器出口流量）'
  }
  const r = probeResult.value
  if (r && !r.degraded) {
    if (r.segment.direct !== 'ok') return '实测分片无法直连（须走代理）→ 直连通道会失败'
    return '实测分片无法经代理获取（如源站端口非标被 CF 吞、服务器 IP 被封）→ 代理通道会失败'
  }
  return '需分片直连可达才有效：分片走代理时直连通道会 403'
})
// 聚合下载速度（估算）= 单连接实测速度 × 当前并发。perConnKBps 是当前并发下的实测值，
// 故乘积能反映「加并发到底换没换来更多总带宽」：双通道真生效则随 6→12 翻倍，被 per-IP 限死则基本不变。
const aggregateKBps = computed(() => Math.round(strategy.value.perConnKBps * strategy.value.targetConn))
const aggregateMbps = computed(() => Math.round((aggregateKBps.value * 8 / 1024) * 10) / 10)
// 当前 URL 命中的内置站点规则（供代理/预取/下载并发和档位读取）。
// 自定义规则的编辑界面已移除，这里只吃 videoSiteRules.ts 里的内置表。
const activeRule = ref<SiteRule | null>(null)

// ── 服务器档位（好/中/差）+ 抗卡自愈 ──
const serverTierOptions = [
  { label: '自动', value: 'auto' },
  { label: '好', value: 'good' },
  { label: '中', value: 'medium' },
  { label: '差', value: 'bad' },
]
const autoTier = ref<ServerTier>(DEFAULT_TIER)          // auto 模式下实测/学习得出的档位
const tierOverrides = ref<Partial<TierParams>>({})      // 页面可调的档位参数覆盖（空=用预设）
const guardRateCeiling = ref(Infinity)                  // 抗卡降速守卫上限：PANIC 置 1，恢复置 Infinity
const currentHost = ref('')                             // 当前视频 host（学习档案按 host 存取）

// 生效档位名：手动规则锁定优先，否则自动实测/学习档
const effectiveTierName = computed<ServerTier>(() => {
  const manual = activeRule.value?.serverTier
  if (manual && manual !== 'auto') return manual
  return autoTier.value
})
const tierIsAuto = computed(() => {
  const m = activeRule.value?.serverTier
  return !m || m === 'auto'
})
// 生效档位参数 = 预设 + 页面覆盖（过滤掉空/非法覆盖值，避免输入框清空污染数值逻辑）
const tierDefaults = computed(() => SERVER_TIERS[effectiveTierName.value])
const effectiveTierParams = computed<TierParams>(() => {
  const ov = tierOverrides.value
  const clean: Partial<TierParams> = {}
  for (const k in ov) {
    const v = (ov as any)[k]
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') (clean as any)[k] = v
  }
  return { ...tierDefaults.value, ...clean }
})
const tierLabel = computed(() => ({ good: '好', medium: '中', bad: '差' } as const)[effectiveTierName.value])
const tierBadgeColor = computed(() => ({ good: 'green', medium: 'amber', bad: 'red' } as const)[effectiveTierName.value])
const hasTierOverride = computed(() => Object.keys(tierOverrides.value).length > 0)
const clearTierOverrides = () => { tierOverrides.value = {} }
// 抗卡参数覆盖改动即持久化（实时生效，无需「应用配置」）
watch(tierOverrides, () => saveState(), { deep: true })

// Origin/Referer 历史（localStorage 永久保存，供输入框下拉选择）
const ORIGIN_HISTORY_KEY = 'video-player-origin-history'
const REFERER_HISTORY_KEY = 'video-player-referer-history'
const originHistory = ref<string[]>([])
const refererHistory = ref<string[]>([])
const loadHeaderHistory = () => {
  try { originHistory.value = JSON.parse(localStorage.getItem(ORIGIN_HISTORY_KEY) || '[]') } catch {}
  try { refererHistory.value = JSON.parse(localStorage.getItem(REFERER_HISTORY_KEY) || '[]') } catch {}
}
const rememberOne = (listRef: Ref<string[]>, key: string, value: string) => {
  const v = value.trim()
  if (!v) return
  listRef.value = [v, ...listRef.value.filter(x => x !== v)].slice(0, 30)  // 去重、置顶、上限 30
  try { localStorage.setItem(key, JSON.stringify(listRef.value)) } catch {}
}
const rememberHeaders = () => {
  rememberOne(originHistory, ORIGIN_HISTORY_KEY, requestOrigin.value)
  rememberOne(refererHistory, REFERER_HISTORY_KEY, requestReferer.value)
}
// 下拉建议：当前视频域名置顶 + 历史（自动策略下用户很少手填，历史常为空，故用当前域名兜底保证有可选项）
const currentVideoOrigin = computed(() => {
  const u = (videoUrl.value || videoUrlInput.value || '').trim()
  if (!u) return ''
  try { return new URL(u.startsWith('//') ? 'https:' + u : u).origin } catch { return '' }
})
const originSuggestions = computed(() => {
  const host = currentVideoOrigin.value
  return host ? [host, ...originHistory.value.filter(x => x !== host)] : originHistory.value
})
const refererSuggestions = computed(() => {
  const ref = currentVideoOrigin.value ? currentVideoOrigin.value + '/' : ''
  return ref ? [ref, ...refererHistory.value.filter(x => x !== ref)] : refererHistory.value
})
const autoFullscreen = ref(true)  // 自动全屏
const autoBestRate = ref(true)    // 自动最佳倍速（默认开）：在 [1, 所选倍速] 内按带宽自动取值
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
const playbackRate = ref(1)      // 实际生效倍速（自动最佳倍速时可能被下调）
const desiredRate = ref(1)       // 用户选择的目标倍速（上限），自动模式在 [1, desiredRate] 内取值
const isFullscreen = ref(false)
const showControls = ref(true)
const showPlayIcon = ref(false)
const showSpeedMenu = ref(false)
const showAdvancedProxy = ref(false)  // 手动覆盖连接策略（默认隐藏，全自动）
const manualStrategyOverride = ref(false)  // 开启后用手动代理设置，关闭自动阶梯

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

// 自适应并行预取系统（缓存与预取逻辑抽到 useSegmentCache / useHlsPrefetch，
// 因依赖 hlsConfig，实例化放在 hlsConfig 声明之后）

// HLS
let hls: HlsType | null = null
// 实时心跳定时器：每秒刷新缓冲读数 + 跑闭环预取控制（不依赖 FRAG_BUFFERED，卡顿时也持续工作）
let hlsTickTimer: ReturnType<typeof setInterval> | null = null
const startHlsTick = () => {
  if (hlsTickTimer) return
  stall.bind()   // 心跳启动时 video 已就绪，绑定卡顿监听（幂等）
  hlsTickTimer = setInterval(() => {
    prefetchTick()
    updateHlsStats()
    selfHeal()
  }, 1000)
}
const stopHlsTick = () => {
  if (hlsTickTimer) { clearInterval(hlsTickTimer); hlsTickTimer = null }
}
const hlsStats = ref<{ buffered: number; level: string } | null>(null)
const hlsConfig = ref({
  // 缓冲时间设置（精简配置）
  maxBufferLength: 3600,        // 预加载时长（秒）
  maxMaxBufferLength: 3600,     // 最大缓冲时长（秒）
  backBufferLength: 3600,       // 后台缓冲（秒）
  // 内存设置
  maxBufferSizeMB: 3600,       // 预取缓存内存上限（MB）——JS 侧缓存，非 MSE
  // 下载速度设置
  fragLoadingTimeOut: 300000,  // 单个分片下载超时上限（ms，5 分钟）
  fragLoadingMaxRetry: 3,     // 最大重试次数
  // 高级设置
  enableWorker: true,         // 启用 Web Worker
  lowLatencyMode: false,      // 低延迟模式
})

// 起播锚点：刷新/恢复进度起播时，播放头还停在 0、但要起播的位置在 pendingStartPos。
// 预取以此为起点（见 useHlsPrefetch 的 getStartPosition/anchorTime）——起播即在正确位置全力并行预取，
// 既不浪费带宽下开头，也不会退化成「只有 hls.js 串行下 1 片」。到位/用户跳转后清 0，改用真实播放头。
let pendingStartPos = 0            // >0=起播定位目标（秒）；0=用真实播放头
let startAnchorActive = false      // 起播锚点是否仍生效（播放头尚未到达 pendingStartPos）

// 预取缓存 + 自适应预取（并发上限受站点规则约束）
const segmentCache = useSegmentCache({ getMaxBufferSizeMB: () => hlsConfig.value.maxBufferSizeMB })
const { prefetchInfo, useCacheForVideo, abortAllPrefetches, startPrefetchCleanup, stopPrefetchCleanup } = segmentCache
const { getAheadBuffered, getCachedAhead, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick: prefetchTick, primePrefetch, getStuckSegment } = useHlsPrefetch({
  getHls: () => hls,
  getVideoEl: () => videoEl.value,
  getProxyUrl,
  cache: segmentCache,
  // 站点规则 playbackConcurrency 作并发下限（默认 1）；引擎按实测+倍速动态往上算
  getConcurrencyCap: () => activeRule.value?.playbackConcurrency ?? 1,
  getPlaybackRate: () => playbackRate.value,
  // 「预加载时长」= 往后预取多少秒就够了，到量即停（0/负数视为不限）
  getPrefetchTargetSecs: () => {
    const t = hlsConfig.value.maxBufferLength
    return t && t > 0 ? t : Infinity
  },
  // 起播锚点：定位未到位前，预取从 pendingStartPos 起（而非 currentTime=0）
  getStartPosition: () => (startAnchorActive ? pendingStartPos : 0),
  // 直连+代理双通道：仅在「开启 + 该分片直连可达」时加一条本站代理 lane（不同 origin → 各享 6 连接）。
  // 需注入头/走代理的源直连 lane 会 403，退回单 lane。
  getLaneUrls: (url: string) => {
    if (dualChannel.value && isDirectMode(url)) return [url, getProxyPassthroughUrl(url)]
    return [getProxyUrl(url)]
  },
  // 服务器档位参数（好/中/差预设 + 页面覆盖）：抗卡阈值/超时/安全系数/并发下限/预取深度全从这里读
  getTierParams: () => effectiveTierParams.value,
})

// 卡顿记录器：以 <video> 真实停顿为地面真值，喂给自愈调参环（selfHeal）
const stall = useStallTracker(() => videoEl.value)

// 清除起播锚点：播放头已到达起播/恢复位置，此后预取改用真实播放头（见 getStartPosition）。
const clearStartAnchor = () => { startAnchorActive = false; pendingStartPos = 0 }

// 倍速变化：立即顶格补取；若超出当前带宽可流畅倍速，提示（不拦截）
watch(playbackRate, (rate) => {
  if (isHls.value) startOnePrefetch()
  if (autoBestRate.value) return  // 自动模式下不弹提示（本就按带宽取值）
  const max = strategy.value.maxFluentRate
  if (max > 0 && rate > max + 0.05) {
    useToast().add({ title: `当前带宽最高流畅约 ${max}x，${rate}x 可能卡顿`, color: 'amber', timeout: 3000 })
  }
})

// 计算并应用「实际生效倍速」：
//  - 自动最佳倍速开启：在 [1, 用户选择倍速] 内朝「带宽可持续上限」逼近，但每次最多迈一个
//    0.25x 台阶（升/降都是），且两次调整间隔必须 ≥10s，避免频繁抖动来回调。
//  - 关闭：完全用用户选择倍速（可 <1 手动慢放），立即生效。
const RATE_STEP = 0.25            // 自动调速每步最大幅度
const RATE_COOLDOWN_MS = 10000    // 两次自动调速的最小间隔
let lastAutoRateAt = 0            // 上次自动调速时刻（performance.now）
const applyEffectiveRate = () => {
  const guard = guardRateCeiling.value   // 抗卡守卫上限（PANIC=1，否则 Infinity）
  // 抗卡阶梯第一步「先降速」：生效倍速高于守卫上限时立即压下（绕过冷却/步进，保命优先）。
  if (isHls.value && guard < playbackRate.value - 1e-6) {
    const g = Math.max(1, guard)
    playbackRate.value = g
    if (videoEl.value) videoEl.value.playbackRate = g
    return
  }
  if (autoBestRate.value && isHls.value) {
    // 目标倍速 = min(所选, 可持续, 守卫上限)，≥1，对齐到 0.25 台阶
    const max = strategy.value.maxFluentRate
    const rawCeil = Math.min(desiredRate.value, max > 0 ? max : desiredRate.value, guard)
    const target = Math.max(1, Math.round(rawCeil / RATE_STEP) * RATE_STEP)
    const cur = playbackRate.value
    if (Math.abs(target - cur) < 1e-6) return           // 已到位
    const now = performance.now()
    if (now - lastAutoRateAt < RATE_COOLDOWN_MS) return // 冷却中：本次不动
    // 朝目标迈一个 0.25 台阶（升降对称）
    const next = target > cur
      ? Math.min(target, cur + RATE_STEP)
      : Math.max(target, cur - RATE_STEP)
    lastAutoRateAt = now
    playbackRate.value = next
    if (videoEl.value) videoEl.value.playbackRate = next
  } else {
    const eff = Math.min(desiredRate.value, guard)      // 手动：听用户，但仍受抗卡守卫钳制
    if (eff !== playbackRate.value) {
      playbackRate.value = eff
      if (videoEl.value) videoEl.value.playbackRate = eff
    }
  }
}
// 带宽实测变化 / 开关切换 / 抗卡守卫变化 时，重新评估生效倍速
watch([strategy, autoBestRate, guardRateCeiling], () => applyEffectiveRate())

// ── 自愈调参环：以真实卡顿 + 健康区反馈，自动分档 + 抗卡阶梯 + 按 host 记忆 ──
const SMOOTH_RELAX_SECS = 30    // 连续流畅超此秒数 → 放松（解除降速守卫、可回收资源）
let lastLearnSaveAt = 0
const selfHeal = () => {
  if (!isHls.value) return
  const s = strategy.value
  // 1) 自动分档（仅 auto 模式）：实测 + 聚合可并行 → classifyTier；真实卡顿则强制降档
  if (tierIsAuto.value) {
    const perBps = s.perConnKBps * 8 * 1024
    const segBps = s.segMbps * 1e6
    let t = classifyTier(perBps, segBps, s.aggregateScales, playbackRate.value, effectiveTierParams.value.maxConn)
    const recentStalls = stall.stallCountInWindow(60000)   // 近 1 分钟真实卡顿次数
    if (recentStalls >= 2) t = 'bad'
    else if (recentStalls >= 1 && t === 'good') t = 'medium'
    autoTier.value = t
  }
  // 2) 抗卡阶梯
  // 2a) 差档濒卡 → 自动开双通道换出口（属连接策略，与倍速无关，手动/自动模式都可）
  if (s.healthZone === 'panic' && effectiveTierParams.value.dualChannelAuto && !dualChannel.value && !dualChannelUnavailable.value) {
    dualChannel.value = true
  }
  // 2b) 先降速：仅「自动最佳倍速」开启时生效——用户手动锁定倍速则尊重其选择，绝不强制降速
  //     （手动模式下应急完全交给跳片，见 skipSegment：倍速>1 时仅在几乎冻结才跳）。
  //     迟滞防抖：濒卡(panic)才压到 1x，恢复到健康(healthy)才放回，中间(low)保持不动。
  if (autoBestRate.value) {
    if (s.healthZone === 'panic') guardRateCeiling.value = 1
    else if (s.healthZone === 'healthy' && guardRateCeiling.value !== Infinity) guardRateCeiling.value = Infinity
  } else if (guardRateCeiling.value !== Infinity) {
    guardRateCeiling.value = Infinity   // 手动模式：确保降速守卫不残留，倍速立即听用户
  }
  // 3) 按 host 记忆：连续流畅够久，把当前档位/双通道效果学到 host（下次同站直接从最优起步）
  const now = performance.now()
  if (currentHost.value && stall.getSmoothSecs() > SMOOTH_RELAX_SECS && now - lastLearnSaveAt > 30000) {
    lastLearnSaveAt = now
    saveLearnedProfile(currentHost.value, {
      learnedTier: effectiveTierName.value,
      bestConcurrency: s.targetConn,
      dualChannelHelped: dualChannel.value,
    })
  }
}

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


// 复制当前直链：地址栏已被 syncUrlToQuery 同步成直链，直接取 location.href
const deepLinkCopied = ref(false)
const copyDeepLink = async () => {
  try {
    await navigator.clipboard.writeText(window.location.href)
    deepLinkCopied.value = true
    setTimeout(() => { deepLinkCopied.value = false }, 1500)
  } catch {
    errorMessage.value = '复制失败，请手动复制地址栏'
  }
}

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
// 时钟格式（HH:MM），用于「已于 xx:xx 刷新」这类时间点提示
const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

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

// 从 URL 获取视频名称
const getVideoName = (url: string, index: number): string => {
  // 交接槽带来的集名优先：长剧每一集的地址都叫 index.m3u8，从 URL 根本认不出第几集
  const named = playlistNames.value[url]
  if (named) return named
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

// 是否可下载（仅网络视频）
const canDownload = computed(() => 
  isVideoLoaded.value && videoUrl.value && (videoUrl.value.startsWith('http') || videoUrl.value.startsWith('//'))
)

// 视频下载（HLS 分片并发+AES解密+ffmpeg合并 / MP4 直下），逻辑抽到 useVideoDownload
const { isDownloading, downloadProgress, downloadVideo, cancelDownload } = useVideoDownload({
  getProxyUrl,
  isHlsUrl,
  getVideoName,
  videoUrl,
  playlist,
  currentIndex,
  errorMessage,
  useProxy,
  getDownloadConcurrency: () => activeRule.value?.downloadConcurrency ?? 6,
})

// ── 反向同步：把当前播放列表/策略写回地址栏，地址栏本身就是可分享的直链 ──
// 用原生 history.replaceState 而非 router.replace：本页只从 window.location.search 读参数，
// 不经 vue-router，避免 query 变化触发路由重解析；replace 也不会污染后退栈。
const syncUrlToQuery = () => {
  if (typeof window === 'undefined') return

  const urls = playlist.value
  // 本地文件是 blob: 地址，换个浏览器/刷新就失效，没法用链接表达 → 清空 query 而不是写进去
  // 放行 //host/path（parseAndLoad 也接受这种协议相对写法）
  const shareable = urls.length > 0 && urls.every(u => /^(https?:)?\/\//i.test(u))
  const parts: string[] = []

  if (shareable) {
    // 多个地址用 urls=a|b 而不是重复 url=，省地址栏长度
    parts.push(urls.length === 1
      ? 'url=' + encodeURIComponent(urls[0])
      : 'urls=' + urls.map(u => encodeURIComponent(u)).join('|'))
    if (currentIndex.value > 0) parts.push('index=' + currentIndex.value)
    // 只写手动策略：自动阶梯是引擎实时试探的，写进地址栏会把中间态固化，下次进来反而绕远
    if (manualStrategyOverride.value) {
      if (requestOrigin.value.trim()) parts.push('origin=' + encodeURIComponent(requestOrigin.value.trim()))
      if (requestReferer.value.trim()) parts.push('referer=' + encodeURIComponent(requestReferer.value.trim()))
      if (useProxy.value) parts.push('proxy=1')
      if (disguiseAsDownloader.value) parts.push('noref=1')
      parts.push('manifestOnly=' + (manifestOnly.value ? '1' : '0'))
    }
  }

  let search = parts.length ? '?' + parts.join('&') : ''
  // 长播放列表会把地址栏顶爆（部分浏览器 2000 字符上界）→ 转存交接槽，query 里只留标记。
  // 早先这里是退化成只带当前一集，代价是刷新后整个列表就没了（query 优先级高于 savedState）；
  // 走交接槽则刷新也能把几十集完整读回来。
  if (search.length > 2000 && shareable) {
    const idx = Math.min(Math.max(currentIndex.value, 0), urls.length - 1)
    writeHandoff(urls, idx)
    search = '?handoff=1'
  }

  if (window.location.search === search) return
  window.history.replaceState(window.history.state, '', window.location.pathname + search + window.location.hash)
}

// 解析多行输入并加载
// startIndex 只由代码调用时传（?index=N）；模板里当事件回调用，首参是 Event，故做类型判断
const parseAndLoad = async (startIndex?: number | Event) => {
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
  const from = typeof startIndex === 'number' && startIndex >= 0 && startIndex < urls.length
    ? startIndex
    : 0
  currentIndex.value = from

  // 保存状态
  saveState()

  // 播放指定集（默认第一个）
  await playByIndex(from)
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
  syncUrlToQuery()   // 地址栏跟着当前集数走，随时可复制分享

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
/**
 * 就地重新解析当前播放列表，换成新链接。
 *
 * 动机：部分线路给的是带签名的地址（`?sign=…&timestamp=…`），过一阵会失效，
 * 表现为好好播着突然 403。此时不必回解析页重来一遍，用交接槽里带过来的
 * 「源页面地址 + 线路」原地重解析即可。
 *
 * 三个要点：
 *   · 按集名认当前集，不按下标——重解析后可能多出或少掉几集，下标会错位
 *   · 播放进度是按 URL 存的，地址一换就查不到了，所以要手动搬到新地址上
 *   · 只有当前这一集需要重载；其余集的新地址进列表即可，切过去时自然生效
 */
const refreshPlaylistLinks = async () => {
  const src = playlistSource.value
  if (!src || isRefreshingLinks.value) return

  isRefreshingLinks.value = true
  const toast = useToast()
  try {
    const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line })
    const { urls, names } = toPlaylist(result)
    if (!urls.length) throw new Error('没有解析出可播放的地址')

    // 刷新前后按「集名 → 地址」对照，才能说清到底变了什么。
    // 只报「已刷新 N 集」等于没说：用户要知道的是地址换没换、集数多没多
    const before = new Map<string, string>()
    playlist.value.forEach((u, i) => before.set(playlistNames.value[u] ?? `#${i}`, u))
    let changed = 0
    let added = 0
    names.forEach((n, i) => {
      const old = before.get(n)
      if (old === undefined) added++
      else if (old !== urls[i]) changed++
    })
    const removed = [...before.keys()].filter(n => !names.includes(n)).length

    // 认名字而不是下标：集数可能变了
    const curUrl = playlist.value[currentIndex.value] ?? ''
    const curName = playlistNames.value[curUrl] ?? ''
    const hit = curName ? names.indexOf(curName) : -1
    const nextIndex = hit >= 0 ? hit : Math.min(currentIndex.value, urls.length - 1)
    const curChanged = urls[nextIndex] !== curUrl

    // 进度按 URL 存，换地址等于丢进度 → 先把当前时间搬到新地址上，
    // 后面 loadVideo 里的 getSavedProgress 就能原位续播
    const pos = videoEl.value?.currentTime ?? currentTime.value
    if (curChanged && pos > 0) savedProgress.value[urls[nextIndex]] = pos

    playlist.value = urls
    setPlaylistNames(urls, names)
    if (result.title) playlistTitle.value = result.title
    currentIndex.value = nextIndex
    lastRefreshAt.value = Date.now()
    saveState()
    syncUrlToQuery()

    // 当前这集地址没变就别重载：正播着呢，重载纯属打断
    if (curChanged) {
      videoUrl.value = urls[nextIndex]
      isRestoringFromSaved.value = true
      await loadVideo()
    }

    if (!changed && !added && !removed) {
      toast.add({
        title: '链接没有变化',
        description: `共 ${urls.length} 集，源站给的还是原来的地址`,
        color: 'blue',
        timeout: 3000,
      })
    } else {
      const parts: string[] = []
      if (changed) parts.push(`${changed} 集换了新地址`)
      if (added) parts.push(`新增 ${added} 集`)
      if (removed) parts.push(`少了 ${removed} 集`)
      toast.add({
        title: '刷新完成：' + parts.join('，'),
        description: `共 ${urls.length} 集` + (curChanged ? '；当前这集已用新地址重新载入' : '；当前这集地址未变，未打断播放'),
        color: 'green',
        timeout: 4000,
      })
    }
  } catch (e: any) {
    const msg = e?.statusMessage || e?.data?.statusMessage || e?.message || '刷新失败'
    toast.add({ title: '刷新链接失败', description: msg, color: 'red', timeout: 6000 })
  } finally {
    isRefreshingLinks.value = false
  }
}

const clearPlaylist = () => {
  playlist.value = []
  playlistNames.value = {}
  playlistTitle.value = ''
  playlistSource.value = null
  currentIndex.value = 0
  videoUrlInput.value = ''
  syncUrlToQuery()
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

// ── 自动可达性：起播前实测探测两轴（manifest / 分片），见 useReachabilityProbe ──
// 过去是「直连 → 失败重载 → 代理 → 失败重载 → 代理+防盗链」的线性盲试，两个毛病：
// 一是把 manifest 和分片当成一个维度（它们常在不同 host，CORS/防盗链/端口各自独立），
// 二是靠失败反应式升级，最多黑屏重载 3 次。现在改成起播前几个小请求把矩阵测出来，一次到位。
const probeResult = ref<ProbeResult | null>(null)
const isProbing = ref(false)
let probeSeq = 0              // 竞态守卫：连点/切集时只认最后一次探测
let reprobedFor = ''          // 该地址是否已因加载失败重探过（避免无限重探）

// 线性阶梯只保留为「探测拿不到结论」（断网/全超时）时的兜底
const autoStrategyStep = ref(0)
const MAX_STRATEGY_STEP = 3
const ladderMode = ref(false)
let lastStrategyUrl = ''

// 规则是否显式接管可达性（任一代理相关字段有值）；有则用规则，跳过自动阶梯
const ruleControlsReachability = (r: SiteRule | null): boolean =>
  !!r && (r.useProxy !== undefined || r.manifestOnly !== undefined ||
    r.disguiseAsDownloader !== undefined || r.origin !== undefined || r.referer !== undefined)

// 应用阶梯第 step 级配置（写回 ref，getProxyUrl 随即生效）。
// 每一级都必须把四个 ref 全写一遍——漏写任何一个都会让上一级的残留值改变本级语义
// （典型：忘了关 manifestOnly，「全程代理」就悄悄变成「分片直连」）。
const STRATEGY_STEP_LABELS = ['直连', '代理清单·分片直连', '代理·伪装', '代理·防盗链']
const applyReachabilityStep = (step: number) => {
  let host = ''
  try { host = new URL(videoUrl.value.startsWith('//') ? 'https:' + videoUrl.value : videoUrl.value).origin } catch {}
  useProxy.value = false
  if (step <= 0) {                     // 直连：最快，CORS 开放站点直接用
    disguiseAsDownloader.value = false
    requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = false
  } else if (step === 1) {             // 代理 manifest 补 CORS，分片仍直连 CDN（比全代理快得多）
    disguiseAsDownloader.value = true
    requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = true
  } else if (step === 2) {             // 代理+伪装全程：服务端补 CORS、不发 Origin/Referer
    disguiseAsDownloader.value = true
    requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = false
  } else {                             // 代理+注入 Origin/Referer：防盗链站点，全程代理
    disguiseAsDownloader.value = false
    requestOrigin.value = host; requestReferer.value = host ? host + '/' : ''; manifestOnly.value = false
  }
}

// 探测结论 → 写回连接 ref（getProxyUrl 随即生效）
const applyConnConfig = (cfg: ConnConfig) => {
  useProxy.value = false
  disguiseAsDownloader.value = cfg.disguiseAsDownloader
  requestOrigin.value = cfg.requestOrigin
  requestReferer.value = cfg.requestReferer
  manifestOnly.value = cfg.manifestOnly
  dualChannel.value = cfg.dualChannel
}
// 连接配置指纹：后台复验时用来判断「结论有没有变」，没变就绝不动 ref（连接策略只在加载时生效，
// 播放中改它只会让 UI 和实际请求对不上）
const connSignature = (c: ConnConfig) =>
  [c.disguiseAsDownloader, c.requestOrigin, c.requestReferer, c.manifestOnly, c.dualChannel].join('|')
const currentConnSignature = () =>
  [disguiseAsDownloader.value, requestOrigin.value, requestReferer.value, manifestOnly.value, dualChannel.value].join('|')

const selfOriginOf = (url: string): string => {
  try { return new URL(url.startsWith('//') ? 'https:' + url : url).origin } catch { return '' }
}
// blob:/file: 是本地资源，没有可达性可言，一律跳过探测
const isProbeable = (url: string): boolean => /^https?:\/\//i.test(url) || url.startsWith('//')

// 跑一次探测并套用结论。返回结果；没结论（degraded）时落回线性阶梯兜底。
const runProbe = async (url: string, blocking: boolean): Promise<ProbeResult | null> => {
  const seq = ++probeSeq
  if (blocking) isProbing.value = true
  try {
    const r = await probeReachability(url)
    if (seq !== probeSeq) return null            // 已被更新的一次探测取代，丢弃
    probeResult.value = r
    saveLearnedProfile(hostOf(url), { reach: r as any })
    const cfg = resolveConnConfig(r, selfOriginOf(url))
    if (cfg) {
      ladderMode.value = false
      applyConnConfig(cfg)
      console.log('可达性探测:', describeProbe(r), r)
    } else {
      ladderMode.value = true                     // 三条路都没测通 → 交回阶梯继续盲试
      applyReachabilityStep(autoStrategyStep.value)
      console.warn('可达性探测无结论，退回线性阶梯', r)
    }
    return r
  } catch (e) {
    console.error('可达性探测异常:', e)
    ladderMode.value = true
    applyReachabilityStep(autoStrategyStep.value)
    return null
  } finally {
    if (seq === probeSeq) isProbing.value = false
  }
}

// 命中缓存时的后台静默复验：结论一致就什么都不做，变了才提示 + 重载一次。
// 每个 host 一轮会话只复验一次——否则「复验 → 重载 → 又命中刚写的缓存 → 又复验」会白跑一圈。
const revalidatedHosts = new Set<string>()
const revalidateInBackground = (url: string) => {
  const host = hostOf(url)
  if (revalidatedHosts.has(host)) return
  revalidatedHosts.add(host)
  probeReachability(url).then(r => {
    if (videoUrl.value.trim() !== url) return     // 用户已切走
    probeResult.value = r
    saveLearnedProfile(hostOf(url), { reach: r as any })
    const cfg = resolveConnConfig(r, selfOriginOf(url))
    if (!cfg || connSignature(cfg) === currentConnSignature()) return
    console.log('连接方式已变化，重新套用:', describeProbe(r))
    applyConnConfig(cfg)
    useToast().add({ title: '连接方式已更新', description: describeProbe(r), color: 'blue', timeout: 2500 })
    loadVideo()
  }).catch(() => {})
}

// 决定本次加载策略。同步部分（规则/档位记忆）总是跑；可达性部分可能 await 探测。
// 优先级不变：手动 > 站点规则 > 自动探测。
const applyStrategy = async (url: string) => {
  const rule = matchSiteRule(url)
  activeRule.value = rule
  // 按 host 记忆：auto 模式下用学到的档位起步（第二遍即最优，不再从冷启动乐观值试探）
  currentHost.value = hostOf(url)
  const learned = loadLearnedProfile(currentHost.value)
  autoTier.value = learned?.learnedTier ?? DEFAULT_TIER
  guardRateCeiling.value = Infinity   // 新流解除上一流的降速守卫
  // 双通道：规则可指定；手动模式保留用户当前设置（dualChannel 与可达性无关，单独套用）
  if (!manualStrategyOverride.value && rule?.dualChannel !== undefined) dualChannel.value = rule.dualChannel
  if (url !== lastStrategyUrl) {
    autoStrategyStep.value = 0
    ladderMode.value = false
    reprobedFor = ''
    probeResult.value = null
    lastStrategyUrl = url
  }
  if (manualStrategyOverride.value) return  // 手动模式：保留用户当前代理设置，不自动改
  if (ruleControlsReachability(rule)) {
    if (rule!.useProxy !== undefined) useProxy.value = rule!.useProxy
    if (rule!.manifestOnly !== undefined) manifestOnly.value = rule!.manifestOnly
    if (rule!.disguiseAsDownloader !== undefined) disguiseAsDownloader.value = rule!.disguiseAsDownloader
    if (rule!.origin !== undefined) requestOrigin.value = rule!.origin
    if (rule!.referer !== undefined) requestReferer.value = rule!.referer
    return
  }
  if (ladderMode.value || !isProbeable(url)) {
    applyReachabilityStep(autoStrategyStep.value)
    return
  }
  // 缓存新鲜（同 host 30 分钟内探过）→ 直接套用秒起播，后台静默复验；
  // 否则阻塞探一次，一步到位，不做「先播再重载」的抖动。
  const cached = isReachFresh(learned) ? (learned!.reach as unknown as ProbeResult) : null
  if (cached) {
    probeResult.value = cached
    const cfg = resolveConnConfig(cached, selfOriginOf(url))
    if (cfg) {
      applyConnConfig(cfg)
      revalidateInBackground(url)
      return
    }
  }
  await runProbe(url, true)
}

// 加载失败时的恢复：先重探一次（结论可能过期，比如签名换了 / 源站改策略），
// 重探还救不回来才退回线性阶梯继续盲试。
const escalateStrategyAndReload = (): boolean => {
  if (manualStrategyOverride.value) return false
  if (ruleControlsReachability(activeRule.value)) return false
  const url = videoUrl.value.trim()
  if (url && isProbeable(url) && !ladderMode.value && reprobedFor !== url) {
    reprobedFor = url
    console.log('加载失败，重新探测连接方式')
    errorMessage.value = '加载失败，正在重新探测连接方式...'
    runProbe(url, true).then(() => loadVideo())
    return true
  }
  if (autoStrategyStep.value >= MAX_STRATEGY_STEP) return false
  ladderMode.value = true
  autoStrategyStep.value++
  console.log('探测未能救回，退回线性阶梯 → step', autoStrategyStep.value)
  errorMessage.value = `正在自动尝试「${STRATEGY_STEP_LABELS[autoStrategyStep.value]}」...`
  loadVideo()
  return true
}

// 当前连接策略的展示文案
const strategyLabel = computed(() => {
  if (manualStrategyOverride.value) return '手动'
  if (ruleControlsReachability(activeRule.value)) return `规则(${activeRule.value?.name})`
  if (isProbing.value) return '探测中…'
  if (probeResult.value && !probeResult.value.degraded) return describeProbe(probeResult.value)
  return STRATEGY_STEP_LABELS[autoStrategyStep.value] ?? '直连'
})

// 探测矩阵读数（展开设置里展示，排查源站用）
const probeRows = computed(() => {
  const r = probeResult.value
  if (!r) return []
  const axes: Array<{ name: string; axis: AxisProbe }> = r.isHls
    ? [{ name: '清单', axis: r.manifest }, { name: '分片', axis: r.segment }]
    : [{ name: '视频', axis: r.segment }]
  return axes.map(({ name, axis }) => ({
    name,
    cells: CHANNEL_ORDER.map(c => ({
      channel: c,
      label: CHANNEL_LABEL[c],
      reach: axis[c],
      ms: axis.ms[c],
    })),
  }))
})

// 用户改动任一连接设置 → 转手动（引擎不再覆盖可达性；并发/预取仍全自动）
// 必须重载视频：连接策略只在加载时生效（manifest 是否带 noseg 决定分片直连/代理），
// 不重载则 hls.js 仍在用上次策略解析出的分片 URL（改「仅代理 Manifest」看似不生效）。
const onManualProxyChange = () => {
  manualStrategyOverride.value = true
  rememberHeaders()   // 记住本次 Origin/Referer 供下拉复用
  saveState()
  syncUrlToQuery()    // 手动策略要能随链接带走
  if (videoUrl.value) loadVideo()
}

// 交回引擎全自动：顺带作废该 host 的可达性缓存，强制重探一次
// （用户点这个按钮多半就是因为觉得当前选择不对）
const resetToAuto = () => {
  manualStrategyOverride.value = false
  autoStrategyStep.value = 0
  ladderMode.value = false
  reprobedFor = ''
  probeResult.value = null
  lastStrategyUrl = ''
  if (currentHost.value) {
    saveLearnedProfile(currentHost.value, { reach: undefined })
    revalidatedHosts.delete(currentHost.value)
  }
  saveState()
  syncUrlToQuery()    // 策略参数从地址栏摘掉
  if (videoUrl.value) loadVideo()
}

// 手动重探（作废缓存，重新实测一遍并按结论重载）
const reprobeNow = async () => {
  const url = videoUrl.value.trim()
  if (!url || !isProbeable(url) || isProbing.value) return
  ladderMode.value = false
  reprobedFor = ''
  const before = currentConnSignature()
  await runProbe(url, true)
  if (currentConnSignature() !== before) loadVideo()
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
  destroyHls()

  const url = videoUrl.value.trim()
  // 按视频切换缓存：同一视频（重播/点回去）保留内存缓存，换了视频才清空旧的
  useCacheForVideo(url)
  // 可达性探测可能阻塞（首访该 host 时约 0.5-3s）——必须在 startLoadTimeout 之前 await，
  // 否则探测耗时会被算进加载超时，慢源直接被误判成「加载超时」。
  await applyStrategy(url)
  if (videoUrl.value.trim() !== url) return   // 探测期间用户切了地址 → 放弃本次加载

  // 启动加载超时检测
  startLoadTimeout()

  isHls.value = isHlsUrl(url)

  console.log('开始加载视频:', url, '是否HLS:', isHls.value, '使用代理:', useProxy.value, '站点规则:', activeRule.value?.name ?? '无')
  
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

  // 恢复播放进度：直接告诉 hls.js 从目标位置起播，避免它先从头猛下一堆用不上的分片、
  // 等 onLoadedMetadata 里再 seek 过去（那样等于白下了一遍开头）。
  const resumeTime = getSavedProgress(url)
  const startPosition = resumeTime > 0 ? resumeTime : -1

  // 起播锚点：有恢复位 → 预取直接锚定到该位置（起播即在正确位置全力预取，不下开头、不串行）；
  // 播放头到位（onSeeked）后清锚点改用真实播放头。无恢复位 → 锚点=0，等价于从头。
  pendingStartPos = resumeTime > 0 ? resumeTime : 0
  startAnchorActive = resumeTime > 0

  // HLS 配置
  // 关键：MSE 缓冲要"小而健康"——append 太多（几百 MB）会触发浏览器 MSE 配额/驱逐，
  // 产生缓冲空洞导致明明缓冲很多却卡在原地。真正的大量预读放在 JS 预取缓存里
  // （segPrefetchCache，容量 = maxBufferSizeMB），hls.js 只在 MSE 里留 ~30s，随播随取。
  hls = new Hls({
    // MSE 缓冲：控制在小范围（Math.min 兼容并迁移旧的超大配置）
    maxBufferLength: Math.min(30, hlsConfig.value.maxBufferLength),
    maxMaxBufferLength: Math.min(60, hlsConfig.value.maxMaxBufferLength),
    backBufferLength: Math.min(30, hlsConfig.value.backBufferLength),
    maxBufferSize: 60 * 1000 * 1000,   // MSE 最多 ~60MB，其余交给 JS 预取缓存
    // 缓冲空洞 / 卡顿自动跳跃恢复
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 1,
    nudgeOffset: 0.2,
    nudgeMaxRetry: 8,
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
    startPosition,
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
    startPrefetchCleanup()  // 启动周期清理过期缓存
    
    // 应用播放设置
    if (videoEl.value) {
      videoEl.value.playbackRate = playbackRate.value
      videoEl.value.volume = volume.value
      videoEl.value.muted = isMuted.value
    }
    
    // 延迟 3 秒后自动播放
    scheduleAutoPlay()
  })

  // playlist（分片列表）就绪 → 立刻并行预热前若干分片 + 启动实时心跳
  hls.on(Hls.Events.LEVEL_LOADED, () => {
    primePrefetch()
    startHlsTick()
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
            // 超过重试次数：先自动升级可达性策略（直连→代理→防盗链）再重载
            if (escalateStrategyAndReload()) break
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

// 播放卡点诊断：「已缓冲一直加却不播」时，一眼看出卡在哪。
// 关键区分：「已缓冲」是 JS 预取缓存（getCachedAhead），能一直涨；能不能播只看 video 元素的 MSE 缓冲。
// readyState 是「整体就绪等级」，不是帧序号：2=有当前帧但不够续播 → 会停下等。
const READY_STATE_TXT = ['无数据(0)', '仅元数据(1)', '有当前帧·不够续播(2)', '够续播(3)', '缓冲充足(4)']
const playbackDiag = ref('—')
const updatePlaybackDiag = (video: HTMLVideoElement) => {
  const ct = video.currentTime
  const rs = READY_STATE_TXT[video.readyState] ?? String(video.readyState)
  if (video.error) {
    playbackDiag.value = `❌ 媒体错误(code ${video.error.code})：${video.error.message || '解码/格式失败'}`
    return
  }
  const n = video.buffered.length
  if (n === 0) {
    playbackDiag.value = `⏳ MSE 为空：播放器尚未 append 任何分片（hls.js 正在下载/解码首片，readyState=${rs}）`
    return
  }
  const ranges: string[] = []
  let curEnd = -1, nextStart = -1   // 播放头所在区间的末尾；其后最近一个区间的起点（用于判空洞）
  for (let i = 0; i < n; i++) {
    const s = video.buffered.start(i), e = video.buffered.end(i)
    ranges.push(`${s.toFixed(1)}~${e.toFixed(1)}`)
    if (s <= ct + 0.1 && ct <= e + 0.1) curEnd = e
    else if (s > ct && (nextStart < 0 || s < nextStart)) nextStart = s
  }
  if (curEnd < 0) {
    // 播放头不在任何区间内：定位错位/落在洞里
    const after = nextStart >= 0 ? `，最近的下一段从 ${nextStart.toFixed(1)}s 开始` : ''
    const stuck = getStuckSegment()
    const dl = stuck ? ` ｜ 最久在途：${stuck.name} 已下 ${(stuck.elapsedMs / 1000).toFixed(1)}s（共 ${stuck.count} 片）` : ''
    playbackDiag.value = `⚠️ 播放头 ${ct.toFixed(1)}s 不在任何缓冲区间内（定位错位）${after}；MSE 区间：${ranges.join(', ')}s${dl}`
    return
  }
  const mseAhead = curEnd - ct
  if (mseAhead < 0.5) {
    // 附上「哪个分片卡住、下了多久」
    const stuck = getStuckSegment()
    const dl = stuck
      ? ` ｜ 最久在途：${stuck.name} 已下 ${(stuck.elapsedMs / 1000).toFixed(1)}s（共 ${stuck.count} 片在下）`
      : ' ｜ 当前无分片在下载（卡在 append/解码，非下载）'
    if (nextStart > curEnd + 0.05) {
      // MSE 有空洞：播到 curEnd 就断，下一段从 nextStart 开始，中间没接上（不是某帧坏了）
      playbackDiag.value = `⚠️ 缓冲空洞：播到 ${curEnd.toFixed(1)}s 断开，下一段从 ${nextStart.toFixed(1)}s 起（缺 ${(nextStart - curEnd).toFixed(1)}s 没接上）→ 卡在洞前${dl}`
    } else {
      // 无洞、就是喂得慢：hls.js 还没把下一片 append 进来（下载/解码中）
      playbackDiag.value = `⏳ MSE 到头（前向仅 ${mseAhead.toFixed(1)}s）：在等下一片${dl}`
    }
    return
  }
  if (video.paused) {
    playbackDiag.value = `⏸ 已就绪(前向 ${mseAhead.toFixed(1)}s) 但处于暂停：等待/被拦截的自动播放`
    return
  }
  playbackDiag.value = `✅ 正常播放（前向 MSE ${mseAhead.toFixed(1)}s，readyState=${rs}）`
}

// 更新 HLS 统计信息
const updateHlsStats = () => {
  if (!hls || !videoEl.value) return

  const video = videoEl.value
  updatePlaybackDiag(video)
  const buffered = getCachedAhead(video)   // 含预取缓存的有效已缓冲，不只 MSE 的 ~60s
  
  const currentLevel = hls.currentLevel
  const levels = hls.levels
  let levelInfo = '自动'
  
  if (currentLevel >= 0 && levels[currentLevel]) {
    const level = levels[currentLevel]
    // 部分流不上报分辨率(height=0)：退回显示码率，避免出现无意义的「0p」
    if (level.height) {
      levelInfo = `${level.height}p`
      if (level.bitrate) levelInfo += ` (${Math.round(level.bitrate / 1000)}kbps)`
    } else if (level.bitrate) {
      levelInfo = `${Math.round(level.bitrate / 1000)}kbps`
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
  // 取消正在跑的预取请求、停止清理定时器/心跳、重置策略实测（换流/换 CDN 重新测）。
  // 注意：不清空 segPrefetchCache——它是模块级单例，需跨换流/导航存活，让「点回去」命中内存缓存；
  // 键按分片 URL 隔离，不同视频不冲突，内存交给 TTL+LRU 兜底。
  stopHlsTick()
  stopPrefetchCleanup()
  abortAllPrefetches()
  prefetchInfo.value = { bufferSecs: 0, threads: 0, cached: 0, pending: 0 }
  resetStrategy()
  stall.unbind()          // 解绑卡顿监听（换流重新计）
  stall.reset()
  guardRateCeiling.value = Infinity   // 解除抗卡降速守卫
  cancelDownload()
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

// 倍速控制：用户选择的是「目标倍速」（上限），实际生效由 applyEffectiveRate 决定
const setPlaybackRate = (rate: number) => {
  desiredRate.value = rate
  lastAutoRateAt = 0        // 用户主动改目标：允许立即迈一步（仍是 0.25 台阶，之后继续按 10s 节奏逼近）
  applyEffectiveRate()
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

  // 更新缓冲进度（含预取缓存的有效已缓冲，进度条反映真实可拖范围）
  if (duration.value > 0) {
    const aheadEnd = videoEl.value.currentTime + getCachedAhead(videoEl.value)
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
  
  // 恢复保存的播放进度：HLS 已经通过 hls.js 的 startPosition 直接从目标位置起播，
  // 这里不用再 seek 一次（避免多余的 seek 打断刚起播的加载）；非 HLS（原生 video）没有
  // startPosition 机制，仍需在这里手动 seek。
  const savedTime = getSavedProgress(videoUrl.value)
  if (isHls.value && savedTime > 0 && savedTime < duration.value - 5) {
    hasSkippedIntro.value = true
  } else if (savedTime > 0 && savedTime < duration.value - 5) {
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
  
  // 网络/源被拒：先自动升级可达性策略（直连→代理→防盗链）再重载
  if (error && (error.code === MediaError.MEDIA_ERR_NETWORK || error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
    if (escalateStrategyAndReload()) return
  }

  if (error) {
    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        msg = '视频加载被中断'
        break
      case MediaError.MEDIA_ERR_NETWORK:
        msg = '网络错误：已自动尝试直连/代理/防盗链均失败，链接可能已过期或无法访问'
        break
      case MediaError.MEDIA_ERR_DECODE:
        msg = '视频解码失败'
        break
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        msg = '视频源被拒绝或格式不支持：已自动尝试各策略仍失败，请检查链接或改用本地文件'
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

// 起播预缓冲：缓冲够 AUTOPLAY_BUFFER_TARGET 秒即起播，剩下的交给并行预取播放中补齐；
// 慢站最多等 AUTOPLAY_MAX_WAIT_MS 兜底避免卡死。非 HLS 固定等 2s。
const AUTOPLAY_BUFFER_TARGET = 6     // 起播缓冲阈值：够 6s 再播，避免刚起播就卡顿
const AUTOPLAY_MAX_WAIT_MS = 8000    // 兜底最多等 8s（慢网到不了 6s 也先播，避免一直等）

const scheduleAutoPlay = () => {
  // 清除之前的定时器
  if (delayedPlayTimer) {
    clearTimeout(delayedPlayTimer)
    delayedPlayTimer = null
  }

  isBuffering.value = true
  const startTs = performance.now()

  const tryPlay = () => {
    const video = videoEl.value
    if (!video) { delayedPlayTimer = null; return }
    const ahead = getAheadBuffered(video)
    const waited = performance.now() - startTs
    // 固定 6s 起播阈值（不再按倍速放大，用户要的是明确的"缓冲够 6s 就播"）
    const target = AUTOPLAY_BUFFER_TARGET
    const ready = !isHls.value
      ? waited >= 2000
      : ahead >= target || waited >= AUTOPLAY_MAX_WAIT_MS
    if (!ready) {
      delayedPlayTimer = setTimeout(tryPlay, 300)
      return
    }
    delayedPlayTimer = null
    console.log(`开始自动播放（预缓冲 ${ahead.toFixed(1)}s，等待 ${(waited / 1000).toFixed(1)}s）`)
    isBuffering.value = false
    video.play().catch(e => {
      console.log('自动播放被阻止:', e.message)
      isBuffering.value = false
    })
  }

  delayedPlayTimer = setTimeout(tryPlay, 500)
}

const onLoadedData = () => {
  console.log('视频数据已加载')
  isLoading.value = false
}

// 等待缓冲
const onWaiting = () => {
  console.log('视频等待缓冲...')
  isBuffering.value = true
  if (!isHls.value) return
  // 卡顿即刻反应：立即跑一次预取控制（不等下一个心跳/FRAG_BUFFERED）
  prefetchTick()
  // 缓冲空洞跳跃：播放头前方几乎没缓冲、但更后面存在缓冲段（洞），跳过小洞恢复播放
  const video = videoEl.value
  if (video && video.buffered.length > 1) {
    const ct = video.currentTime
    if (getAheadBuffered(video) < 0.3) {
      for (let i = 0; i < video.buffered.length; i++) {
        const s = video.buffered.start(i)
        if (s > ct && s - ct < 3) { video.currentTime = s + 0.01; break }  // 跳过 <3s 的洞
      }
    }
  }
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
  if (seekBufferingTimer) {
    clearTimeout(seekBufferingTimer)
    seekBufferingTimer = null
  }
  // 起播定位到位（currentTime 刚跳到 pendingStartPos）不是用户跳转：预取本就锚定在此、已在正确位置
  // 并行下载，别 abort 掉白费。只有真·用户跳转才终止旧位置预取、腾连接给新位置。
  const ct = videoEl.value?.currentTime ?? 0
  const arrivingAtStart = startAnchorActive && Math.abs(ct - pendingStartPos) < 3
  clearStartAnchor()   // 此后以真实播放头为准
  if (!arrivingAtStart) {
    // 终止旧位置的预取请求，腾出连接池给新位置的分片。
    // 不清空已完成缓存：seek 回跳/来回拖动时直接命中内存，不重新下载（TTL+LRU 兜底）。
    abortAllPrefetches()
    prefetchInfo.value.pending = 0
  }
  isBuffering.value = false
  // 立刻在当前位置并行预取（不等 1s 心跳），尽快把目标分片拉下来
  if (isHls.value) primePrefetch()
}

// 开始播放
const onPlaying = () => {
  console.log('视频开始播放')
  isBuffering.value = false
  isPlaying.value = true
  clearStartAnchor()   // 兜底：已在播放 = 起播位置已定，改用真实播放头（防 seeked 事件缺失时锚点残留）
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
    maxBufferSizeMB: 3600,
    fragLoadingTimeOut: 300000,
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
      const prevIdx = playbackRates.indexOf(desiredRate.value)
      if (prevIdx > 0) setPlaybackRate(playbackRates[prevIdx - 1])
      break
    case '>':
    case '.':
      const nextIdx = playbackRates.indexOf(desiredRate.value)
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

  loadHeaderHistory()

  // URL 参数优先于本地存储：外部直链打开时不该被上次的地址/播放列表覆盖
  const queryParams = parseQueryVideoParams()

  // 加载保存的状态
  const savedState = loadSavedState()
  if (savedState) {
    console.log('加载保存的状态:', savedState)
    savedProgress.value = savedState.progress || {}
    volume.value = savedState.volume ?? 1
    playbackRate.value = savedState.playbackRate ?? 1
    desiredRate.value = savedState.playbackRate ?? 1
    useProxy.value = savedState.useProxy ?? false
    autoFullscreen.value = savedState.autoFullscreen ?? true
    autoBestRate.value = savedState.autoBestRate ?? true
    skipIntro.value = savedState.skipIntro ?? 0
    skipOutro.value = savedState.skipOutro ?? 0
    requestOrigin.value = savedState.requestOrigin ?? ''
    requestReferer.value = savedState.requestReferer ?? ''
    manifestOnly.value = savedState.manifestOnly ?? true
    disguiseAsDownloader.value = savedState.disguiseAsDownloader ?? false
    dualChannel.value = savedState.dualChannel ?? false
    manualStrategyOverride.value = savedState.manualStrategyOverride ?? false
    if (manualStrategyOverride.value) showAdvancedProxy.value = true  // 手动过则展开显示当前设置
    if (savedState.hlsConfig) {
      hlsConfig.value = { ...hlsConfig.value, ...savedState.hlsConfig }
    }
    if (savedState.tierOverrides) tierOverrides.value = { ...savedState.tierOverrides }

    // 如果没有 URL 参数，恢复保存的视频地址
    if (!queryParams.urls.length && savedState.videoUrlInput) {
      videoUrlInput.value = savedState.videoUrlInput
      playlist.value = savedState.playlist || []
      currentIndex.value = savedState.currentIndex ?? 0
    }
  }

  // 检查 URL 参数，支持 ?url=xxx 直接播放
  if (queryParams.urls.length) {
    console.log('从 URL 参数加载视频:', queryParams)
    videoUrlInput.value = queryParams.urls.join('\n')
    // 连接策略随参数一起带过来时转手动，避免自动阶梯把注入的 Origin/Referer 冲掉
    const hasStrategyParam = queryParams.origin !== undefined || queryParams.referer !== undefined
      || queryParams.proxy !== undefined || queryParams.noref !== undefined
      || queryParams.manifestOnly !== undefined
    if (hasStrategyParam) {
      if (queryParams.origin !== undefined) requestOrigin.value = queryParams.origin
      if (queryParams.referer !== undefined) requestReferer.value = queryParams.referer
      if (queryParams.proxy !== undefined) useProxy.value = queryParams.proxy
      if (queryParams.noref !== undefined) disguiseAsDownloader.value = queryParams.noref
      if (queryParams.manifestOnly !== undefined) manifestOnly.value = queryParams.manifestOnly
      manualStrategyOverride.value = true
      showAdvancedProxy.value = true
    }
    await nextTick()
    // playByIndex 内部会置 isRestoringFromSaved，直链进来即自动起播
    await parseAndLoad(queryParams.index)
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
