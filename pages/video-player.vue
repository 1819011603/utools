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

        <!-- 连接策略：全自动（直连→代理→防盗链自动升级），可展开手动覆盖 -->
        <div class="flex gap-2 flex-wrap items-center text-sm">
          <UBadge :color="manualStrategyOverride ? 'amber' : 'sky'" variant="soft" size="xs">
            连接策略：{{ strategyLabel }}
          </UBadge>
          <span class="text-xs text-gray-400">
            {{ manualStrategyOverride ? '你已手动调整，改任一项即生效；点“恢复自动”交回引擎' : '直连/代理/防盗链由播放器自动选择，改任一项即转手动' }}
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
            <option v-for="o in originHistory" :key="o" :value="o" />
          </datalist>
          <datalist id="vp-referer-history">
            <option v-for="r in refererHistory" :key="r" :value="r" />
          </datalist>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="manifestOnly"
              label="仅代理 Manifest"
              @change="onManualProxyChange"
            />
          </UFormGroup>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox
              v-model="disguiseAsDownloader"
              label="伪装下载器（不发送 Origin/Referer）"
              @change="onManualProxyChange"
            />
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

    <!-- 站点规则 -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-adjustments-horizontal" class="w-5 h-5 text-sky-500" />
            <span class="font-semibold">站点规则</span>
            <UBadge v-if="activeRule" color="green" variant="soft" size="xs">
              已套用：{{ activeRule.name }}
            </UBadge>
          </div>
          <div class="flex gap-2">
            <UButton size="xs" variant="soft" icon="i-heroicons-plus" @click="addSiteRule">添加规则</UButton>
            <UButton size="xs" color="primary" variant="soft" icon="i-heroicons-check" @click="applyRulesAndReload">保存并应用</UButton>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <p class="text-xs text-gray-500 dark:text-gray-400">
          按视频域名自动套用一套代理/防盗链/并发配置，解决部分站点播放慢或 403 的问题。
          匹配用 <code>host 子串</code> 或 <code>/正则/</code>；用户规则优先于内置规则。
        </p>

        <!-- 用户自定义规则 -->
        <div v-if="userSiteRules.length" class="space-y-3">
          <div
            v-for="rule in userSiteRules"
            :key="rule.id"
            class="p-3 rounded-lg border border-gray-200 dark:border-gray-700 space-y-2"
          >
            <div class="flex gap-2 items-end flex-wrap">
              <UFormGroup label="规则名" class="w-40">
                <UInput v-model="rule.name" size="xs" @change="applyRulesAndReload" />
              </UFormGroup>
              <UFormGroup label="匹配 (host 或 /正则/)" class="flex-1 min-w-48">
                <UInput v-model="rule.pattern" size="xs" placeholder="jisuzyv.com" @change="applyRulesAndReload" />
              </UFormGroup>
              <UButton size="xs" color="red" variant="ghost" icon="i-heroicons-trash" @click="removeSiteRule(rule.id)" />
            </div>
            <div class="flex gap-4 flex-wrap items-center text-xs">
              <UCheckbox v-model="rule.useProxy" label="跨域代理" @change="applyRulesAndReload" />
              <UCheckbox v-model="rule.manifestOnly" label="仅代理 Manifest" @change="applyRulesAndReload" />
              <UCheckbox v-model="rule.disguiseAsDownloader" label="伪装下载器" @change="applyRulesAndReload" />
              <div class="flex items-center gap-1">
                <span class="text-gray-500">预取并发</span>
                <UInput v-model.number="rule.playbackConcurrency" type="number" :min="1" :max="3" size="xs" class="w-16" @change="applyRulesAndReload" />
              </div>
              <div class="flex items-center gap-1">
                <span class="text-gray-500">下载并发</span>
                <UInput v-model.number="rule.downloadConcurrency" type="number" :min="1" :max="16" size="xs" class="w-16" @change="applyRulesAndReload" />
              </div>
            </div>
            <div class="flex gap-2 flex-wrap">
              <UInput v-model="rule.origin" size="xs" placeholder="Origin（可选）" class="flex-1 min-w-40" @change="applyRulesAndReload" />
              <UInput v-model="rule.referer" size="xs" placeholder="Referer（可选）" class="flex-1 min-w-40" @change="applyRulesAndReload" />
            </div>
          </div>
        </div>
        <p v-else class="text-sm text-gray-400">暂无自定义规则，点击「添加规则」新建。</p>

        <!-- 内置规则（只读参考） -->
        <div class="pt-2 border-t border-gray-200 dark:border-gray-700">
          <span class="text-xs text-gray-500">内置规则：</span>
          <div class="flex flex-wrap gap-2 mt-1">
            <UBadge v-for="r in builtinRules" :key="r.id" color="gray" variant="soft" size="xs">
              {{ r.name }} · {{ r.pattern }}
            </UBadge>
          </div>
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
import type { SiteRule } from '~/composables/videoSiteRules'

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
  autoBestRate: boolean  // 自动最佳倍速
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
// 代理 URL 生成（Origin/Referer 注入、manifestOnly、伪装下载器、CORS 代理）
const { isHlsUrl, effectiveReferer, refererHelp, getProxyUrl } = useVideoProxy({
  requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, useProxy,
})
// 站点规则：用户自定义规则 + 当前 URL 命中的规则（供代理/预取/下载并发读取）
const userSiteRules = ref<SiteRule[]>([])
const activeRule = ref<SiteRule | null>(null)

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
  hlsTickTimer = setInterval(() => {
    prefetchTick()
    updateHlsStats()
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
  maxBufferSizeMB: 600,        // 缓冲大小（MB）
  // 下载速度设置
  fragLoadingTimeOut: 30000,  // 分片下载超时（ms）
  fragLoadingMaxRetry: 3,     // 最大重试次数
  // 高级设置
  enableWorker: true,         // 启用 Web Worker
  lowLatencyMode: false,      // 低延迟模式
})

// 预取缓存 + 自适应预取（并发上限受站点规则约束）
const segmentCache = useSegmentCache({ getMaxBufferSizeMB: () => hlsConfig.value.maxBufferSizeMB })
const { segPrefetchCache, prefetchInfo, abortAllPrefetches, startPrefetchCleanup, stopPrefetchCleanup } = segmentCache
const { getAheadBuffered, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick: prefetchTick, primePrefetch } = useHlsPrefetch({
  getHls: () => hls,
  getVideoEl: () => videoEl.value,
  getProxyUrl,
  cache: segmentCache,
  // 站点规则 playbackConcurrency 作并发下限（默认 1）；引擎按实测+倍速动态往上算
  getConcurrencyCap: () => activeRule.value?.playbackConcurrency ?? 1,
  getPlaybackRate: () => playbackRate.value,
})

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
//  - 自动最佳倍速开启：在 [1, 用户选择倍速] 内，取 ≤ 带宽可流畅上限(×0.85 余量) 的最大档；撑不住则 1x。
//  - 关闭：完全用用户选择倍速（可 <1 手动慢放）。
const applyEffectiveRate = () => {
  let eff: number
  if (autoBestRate.value && isHls.value) {
    // maxFluentRate = 当前可持续倍速（已含安全余量）；生效 = min(所选, 可持续)，取档位内最大且 ≥1
    const max = strategy.value.maxFluentRate
    const ceil = max > 0 ? Math.min(desiredRate.value, max) : desiredRate.value  // 无数据时先按所选
    const usable = playbackRates.filter(r => r >= 1 && r <= ceil)
    eff = usable.length ? Math.max(...usable) : 1        // ≥1、≤所选、≤可持续
  } else {
    eff = desiredRate.value                              // 手动：完全听用户
  }
  if (eff !== playbackRate.value) {
    playbackRate.value = eff
    if (videoEl.value) videoEl.value.playbackRate = eff
  }
}
// 带宽实测变化 或 开关切换 时，重新评估生效倍速
watch([strategy, autoBestRate], () => applyEffectiveRate())

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

// ── 自动可达性策略阶梯（用户无需指定代理/防盗链，引擎自己试）──
// step 0 直连 → 1 代理+伪装(不发头) → 2 代理+注入 Origin/Referer(防盗链)
const autoStrategyStep = ref(0)
const MAX_STRATEGY_STEP = 2
let lastStrategyUrl = ''

// 规则是否显式接管可达性（任一代理相关字段有值）；有则用规则，跳过自动阶梯
const ruleControlsReachability = (r: SiteRule | null): boolean =>
  !!r && (r.useProxy !== undefined || r.manifestOnly !== undefined ||
    r.disguiseAsDownloader !== undefined || r.origin !== undefined || r.referer !== undefined)

// 应用阶梯第 step 级配置（写回 ref，getProxyUrl 随即生效）
const applyReachabilityStep = (step: number) => {
  let host = ''
  try { host = new URL(videoUrl.value.startsWith('//') ? 'https:' + videoUrl.value : videoUrl.value).origin } catch {}
  if (step <= 0) {                     // 直连：最快，CORS 开放站点直接用
    useProxy.value = false; disguiseAsDownloader.value = false
    requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = true
  } else if (step === 1) {             // 代理+伪装：服务端补 CORS、不发 Origin/Referer
    useProxy.value = false; disguiseAsDownloader.value = true
    requestOrigin.value = ''; requestReferer.value = ''
  } else {                             // 代理+注入 Origin/Referer：防盗链站点，全程代理
    useProxy.value = false; disguiseAsDownloader.value = false
    requestOrigin.value = host; requestReferer.value = host ? host + '/' : ''; manifestOnly.value = false
  }
}

// 决定本次加载策略：换新地址重置阶梯；规则接管则用规则，否则走自动阶梯
const applyStrategy = (url: string) => {
  const rule = matchSiteRule(url, userSiteRules.value)
  activeRule.value = rule
  if (url !== lastStrategyUrl) { autoStrategyStep.value = 0; lastStrategyUrl = url }
  if (manualStrategyOverride.value) return  // 手动模式：保留用户当前代理设置，不自动改
  if (ruleControlsReachability(rule)) {
    if (rule!.useProxy !== undefined) useProxy.value = rule!.useProxy
    if (rule!.manifestOnly !== undefined) manifestOnly.value = rule!.manifestOnly
    if (rule!.disguiseAsDownloader !== undefined) disguiseAsDownloader.value = rule!.disguiseAsDownloader
    if (rule!.origin !== undefined) requestOrigin.value = rule!.origin
    if (rule!.referer !== undefined) requestReferer.value = rule!.referer
  } else {
    applyReachabilityStep(autoStrategyStep.value)
  }
}

// 当前策略加载失败时，自动升级到下一级并重载（规则接管或已到顶则不再升级）
const escalateStrategyAndReload = (): boolean => {
  if (manualStrategyOverride.value) return false
  if (ruleControlsReachability(activeRule.value)) return false
  if (autoStrategyStep.value >= MAX_STRATEGY_STEP) return false
  autoStrategyStep.value++
  console.log('当前策略加载失败，自动升级可达性 → step', autoStrategyStep.value)
  errorMessage.value = `直连失败，正在自动尝试${autoStrategyStep.value === 1 ? '代理' : '代理+防盗链'}...`
  loadVideo()
  return true
}

// 当前连接策略的展示文案
const strategyLabel = computed(() => {
  if (manualStrategyOverride.value) return '手动'
  if (ruleControlsReachability(activeRule.value)) return `规则(${activeRule.value?.name})`
  return ['直连', '代理·伪装', '代理·防盗链'][autoStrategyStep.value] ?? '直连'
})

// 用户改动任一连接设置 → 转手动（引擎不再覆盖可达性；并发/预取仍全自动）
const onManualProxyChange = () => {
  manualStrategyOverride.value = true
  rememberHeaders()   // 记住本次 Origin/Referer 供下拉复用
  saveState()
}

// 交回引擎全自动
const resetToAuto = () => {
  manualStrategyOverride.value = false
  autoStrategyStep.value = 0
  saveState()
  if (videoUrl.value) loadVideo()
}

// 内置规则（只读展示用）
const builtinRules = BUILTIN_RULES

// 站点规则编辑
const addSiteRule = () => {
  userSiteRules.value.push({ id: `u-${Date.now()}`, name: '新规则', pattern: '', manifestOnly: false })
}
const removeSiteRule = (id: string) => {
  userSiteRules.value = userSiteRules.value.filter(r => r.id !== id)
  saveUserSiteRules(userSiteRules.value)
}
// 保存规则并对当前视频重新套用（若正在播放则重载）
const applyRulesAndReload = () => {
  saveUserSiteRules(userSiteRules.value)
  if (videoUrl.value) loadVideo()
  else useToast().add({ title: '站点规则已保存', color: 'green', timeout: 2000 })
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
  applyStrategy(url)  // 自动决定直连/代理/防盗链 + 站点规则并发
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
  // 清空预取缓存、取消正在跑的预取请求、停止清理定时器/心跳、重置策略实测（换流/换 CDN 重新测）
  stopHlsTick()
  stopPrefetchCleanup()
  abortAllPrefetches()
  segPrefetchCache.clear()
  prefetchInfo.value = { bufferSecs: 0, threads: 0, cached: 0, pending: 0 }
  resetStrategy()
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

// 倍速控制：用户选择的是「目标倍速」（上限），实际生效由 applyEffectiveRate 决定
const setPlaybackRate = (rate: number) => {
  desiredRate.value = rate
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

// 起播预缓冲：缓冲够 AUTOPLAY_BUFFER_TARGET 秒即起播（尽快进入），
// 剩下的缓冲交给多连接并行预取在播放中补齐；慢站最多等 AUTOPLAY_MAX_WAIT_MS 兜底。非 HLS 固定 3s。
const AUTOPLAY_BUFFER_TARGET = 4     // 起播只需少量缓冲，快速进入
const AUTOPLAY_MAX_WAIT_MS = 5000    // 兜底最多等 5s

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
    // 起播目标随倍速略放大（封顶 ×2），但保持小值以快速起播
    const target = AUTOPLAY_BUFFER_TARGET * Math.min(2, Math.max(1, desiredRate.value))
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
  // 终止旧位置的预取请求，腾出连接池给新位置的分片
  abortAllPrefetches()

  // 只有 seek 到缓冲区外才清空已完成的缓存；缓冲区内则保留（可能马上要复用）
  const inBuffer = videoEl.value ? getAheadBuffered(videoEl.value) > 0 : false
  if (!inBuffer) {
    segPrefetchCache.clear()
    prefetchInfo.value.cached = 0
  }
  prefetchInfo.value.pending = 0
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

  // 加载用户自定义站点规则 + Origin/Referer 历史
  userSiteRules.value = loadUserSiteRules()
  loadHeaderHistory()

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
