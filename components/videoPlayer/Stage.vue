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
          <!--
            连接策略只在这里露一个徽标：整块设置已挪到页面下方的折叠区（平时是噪音，出问题才看）。
            点它就把那块展开——`showAdvancedProxy` 同时也是折叠区的开合状态，一个 ref 两处用。
          -->
          <UBadge
            :color="isProbing ? 'gray' : 'sky'" variant="soft" size="xs"
            class="cursor-pointer hover:ring-1 hover:ring-sky-400 transition-shadow"
            title="点击展开连接与防盗链设置（含可达性探测矩阵）"
            @click="showAdvancedProxy = !showAdvancedProxy"
          >
            {{ isProbing ? '探测中…' : strategyLabel }}
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
      @mousemove="onMouseMove"
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

      <!-- 顶部信息条：标题 + 第几集 + 选集，与底部控制栏同进同出 -->
      <VideoPlayerTopBar />

      <!--
        中央播放/暂停图标：切换时闪一下（外圈炸开光晕），**暂停期间则常驻**——
        暂停后画面是一张静止图，没有任何东西表明「是暂停了还是卡死了」。
        常驻的这枚可以直接点（自动播放被浏览器拦下时它就是唯一的入口）。
      -->
      <Transition name="pop">
        <div
          v-if="showPlayIcon || pausedIdle"
          class="absolute inset-0 flex items-center justify-center"
          :class="pausedIdle ? 'cursor-pointer' : 'pointer-events-none'"
          :data-no-gesture="pausedIdle ? '' : undefined"
          @click="pausedIdle && togglePlay()"
        >
          <!-- 整块可点而不只是那枚 80px 的圆：手机上要瞄准那个圈太难，「点了没反应」多半是没点中 -->
          <div class="relative">
            <span v-if="showPlayIcon" class="absolute inset-0 rounded-full bg-white/25 blast" />
            <div
              class="w-20 h-20 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center
                     ring-1 ring-white/20 transition-transform"
              :class="pausedIdle ? 'hover:scale-110 active:scale-95' : ''"
            >
              <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-10 h-10 text-white" />
            </div>
          </div>
        </div>
      </Transition>

      <!--
        双击 ±5s 的落点反馈：不给这一下反馈的话，跳了 5 秒和「没点到」看起来一模一样。
        半屏椭圆水波纹 + 三个依次亮起的箭头，读数在同侧连点时累加（5→10→15）。
      -->
      <Transition name="ripple">
        <div
          v-if="seekFlash"
          :key="seekFlash.side"
          class="absolute inset-y-0 w-[38%] overflow-hidden pointer-events-none"
          :class="seekFlash.side === 'left' ? 'left-0' : 'right-0'"
        >
          <span
            class="absolute top-1/2 -translate-y-1/2 w-[150%] aspect-square rounded-full bg-white/15 ripple-blob"
            :class="seekFlash.side === 'left' ? '-left-1/2' : '-right-1/2'"
          />
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white drop-shadow-lg">
            <div class="flex" :class="seekFlash.side === 'left' ? 'flex-row-reverse' : ''">
              <UIcon
                v-for="i in 3"
                :key="i"
                :name="seekFlash.side === 'left' ? 'i-heroicons-chevron-left' : 'i-heroicons-chevron-right'"
                class="w-6 h-6 -mx-1 chev"
                :style="{ animationDelay: (i - 1) * 0.12 + 's' }"
              />
            </div>
            <!-- key 带上秒数：连点时数字换掉要重放一次弹跳，否则看不出又加了 5 秒 -->
            <span :key="seekFlash.secs" class="text-sm font-semibold tabular-nums secs-pop">
              {{ seekFlash.secs }} 秒
            </span>
          </div>
        </div>
      </Transition>

      <!-- 长按加速中的常驻提示：不显示的话松手前用户不知道自己触发了什么 -->
      <Transition name="drop">
        <!-- 往下让开顶部信息条，两个都在时不叠 -->
        <div v-if="boostActive" class="absolute top-20 left-1/2 -translate-x-1/2 pointer-events-none">
          <div class="flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-semibold
                      bg-gradient-to-r from-violet-600/90 to-fuchsia-500/90 backdrop-blur-sm
                      ring-1 ring-white/25 shadow-lg shadow-violet-900/40 boost-glow">
            <span class="flex">
              <UIcon
                v-for="i in 3"
                :key="i"
                name="i-heroicons-play-solid"
                class="w-3.5 h-3.5 -mx-0.5 chev"
                :style="{ animationDelay: (i - 1) * 0.15 + 's' }"
              />
            </span>
            {{ boostRate }}x 快进中
          </div>
        </div>
      </Transition>

      <!-- 滑动手势的中央读数（进度/音量/亮度共用一张） -->
      <Transition name="pop">
        <div v-if="gestureHud" class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="px-5 py-3.5 rounded-2xl bg-black/60 backdrop-blur-md text-white min-w-[160px]
                      flex flex-col items-center gap-2.5 ring-1 ring-white/15 shadow-2xl">
            <div class="flex items-center gap-2">
              <UIcon
                :name="gestureHud.kind === 'seek' ? 'i-heroicons-arrows-right-left'
                  : gestureHud.kind === 'volume' ? volumeIcon : 'i-heroicons-sun'"
                class="w-5 h-5 text-violet-300"
              />
              <span class="font-mono text-sm">{{ gestureHud.text }}</span>
              <span
                v-if="gestureHud.delta"
                :key="gestureHud.delta"
                class="text-sm font-mono font-semibold secs-pop"
                :class="gestureHud.delta.startsWith('+') ? 'text-emerald-300' : 'text-amber-300'"
              >{{ gestureHud.delta }}</span>
            </div>
            <div class="w-36 h-1.5 bg-white/20 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 shadow-[0_0_8px_rgba(167,139,250,.9)]"
                :style="{ width: (gestureHud.percent ?? 0) + '%' }"
              />
            </div>
          </div>
        </div>
      </Transition>

      <!--
        锁定按钮：锁上后它是唯一还能点的东西，所以点画面任意处都会让它露 3 秒。
        锁定态用半透明的紫→粉→蓝渐变，跟进度条/长按提示同一套色；
        原来那块实心琥珀在黑画面上跳得像个警告标（本意只是「状态不同」，不是「出事了」）。
      -->
      <Transition name="pop">
        <button
          v-if="isLocked ? showLockBtn : (showControls || pausedIdle)"
          data-no-gesture
          class="absolute left-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full text-white
                 flex items-center justify-center backdrop-blur-sm ring-1 transition-all duration-300
                 hover:scale-110 active:scale-95"
          :class="isLocked
            ? 'bg-gradient-to-br from-violet-400/60 via-fuchsia-400/45 to-sky-400/50 ring-white/25 shadow-lg shadow-violet-950/30'
            : 'bg-gradient-to-br from-white/15 to-white/5 ring-white/15 hover:from-white/25 hover:to-white/10'"
          :title="isLocked ? '解锁' : '锁定屏幕（屏蔽手势与控制栏）'"
          @click="toggleLock"
        >
          <!-- key 换掉 → 图标重新入场，锁上/解锁那一下能看见是「翻」过去的 -->
          <UIcon
            :key="String(isLocked)"
            :name="isLocked ? 'i-heroicons-lock-closed' : 'i-heroicons-lock-open'"
            class="w-6 h-6 lock-flip"
          />
        </button>
      </Transition>

      <Transition name="slide-up">
        <div
          v-show="controlsVisible"
          data-no-gesture
          class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-12"
          @click.stop
          @pointerdown="keepControlsAlive"
          @pointerup="keepControlsAlive"
        >
          <!-- 进度条 -->
          <div
            ref="progressBar"
            class="relative h-2 bg-white/30 rounded-full cursor-pointer group/progress mb-3 touch-none"
            @pointerdown="startSeek"
            @mousemove="updateHoverTime"
            @mouseleave="hoverTime = null"
          >
            <div class="absolute h-full bg-white/40 rounded-full" :style="{ width: bufferedPercent + '%' }" />
            <div
              class="absolute h-full rounded-full transition-all bg-gradient-to-r from-violet-500 to-fuchsia-400
                     shadow-[0_0_10px_rgba(167,139,250,.75)]"
              :style="{ width: progressPercent + '%' }"
            />
            <div
              class="absolute top-1/2 -translate-y-1/2 w-5 h-5 bg-white rounded-full shadow-lg
                     opacity-0 scale-50 group-hover/progress:opacity-100 group-hover/progress:scale-100
                     transition-all duration-200 ring-2 ring-violet-400/60"
              :style="{ left: `calc(${progressPercent}% - 10px)` }"
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

          <!-- 窄屏上不换行：一换行控制栏就摞成两排，把进度条顶到画面中间（实测手机上一团糟） -->
          <div class="flex items-center justify-between gap-1 min-w-0">
            <!--
              前进/后退 10 秒的两枚按钮已删：双击画面左右两侧就是 ±5s，手机上比瞄准小图标快得多，
              键盘还有 ←/→。留着只是把上下一集这两枚真正常用的挤小了。
            -->
            <div class="flex items-center gap-1 min-w-0 flex-1">
              <button
                v-if="playlist.length > 1"
                class="p-2 rounded-lg text-white transition-all"
                :class="hasPrev ? 'hover:bg-white/15 hover:text-violet-300 active:scale-90' : 'opacity-40 cursor-not-allowed'"
                :disabled="!hasPrev"
                title="上一集"
                @click="playPrev"
              >
                <UIcon name="i-heroicons-backward-solid" class="w-6 h-6 sm:w-7 sm:h-7" />
              </button>

              <button class="p-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 active:scale-90 transition-all" @click="togglePlay">
                <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-7 h-7 sm:w-8 sm:h-8" />
              </button>

              <button
                v-if="playlist.length > 1"
                class="p-2 rounded-lg text-white transition-all"
                :class="hasNext ? 'hover:bg-white/15 hover:text-violet-300 active:scale-90' : 'opacity-40 cursor-not-allowed'"
                :disabled="!hasNext"
                title="下一集"
                @click="playNext"
              >
                <UIcon name="i-heroicons-forward-solid" class="w-6 h-6 sm:w-7 sm:h-7" />
              </button>

              <!-- 手机上没有 hover，滑条永远展不开；音量有硬件键和竖滑手势，整组藏起来腾地方 -->
              <div class="hidden sm:flex items-center gap-2 group/volume ml-1">
                <button class="p-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 transition-all" @click="toggleMute">
                  <UIcon :name="volumeIcon" class="w-6 h-6" />
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

              <span class="text-white text-xs sm:text-sm font-mono shrink-0 tabular-nums">
                {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
              </span>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <!-- 自动全屏 / 自动倍速 / 跳过片头片尾：全是看片当下才改的，放这儿手不用离开画面 -->
              <VideoPlayerSettingsMenu />

              <div ref="speedMenuRef" class="relative">
                <button
                  class="px-2.5 py-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 transition-all text-base font-semibold"
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
                      class="block w-full px-5 py-2.5 text-sm text-white hover:bg-violet-500/50 transition-colors text-center"
                      :class="{ 'bg-violet-500': desiredRate === rate }"
                      @click="setPlaybackRate(rate)"
                    >
                      {{ rate }}x
                    </button>
                  </div>
                </Transition>
              </div>

              <template v-if="canDownload && !isNarrow">
                <template v-if="isDownloading">
                  <span class="text-white text-xs font-medium w-8 text-center">{{ downloadProgress }}%</span>
                  <button class="p-2 rounded-lg text-amber-400 hover:bg-white/15 hover:text-red-400 transition-all" title="取消下载" @click="cancelDownload">
                    <UIcon name="i-heroicons-x-circle" class="w-5 h-5" />
                  </button>
                </template>
                <button v-else class="p-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 transition-all" title="下载视频" @click="downloadVideo()">
                  <UIcon name="i-heroicons-arrow-down-tray" class="w-6 h-6" />
                </button>
              </template>

              <button v-if="supportsPiP && !isNarrow" class="p-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 transition-all" title="画中画" @click="togglePiP">
                <UIcon name="i-heroicons-rectangle-stack" class="w-6 h-6" />
              </button>

              <button class="p-2 rounded-lg text-white hover:bg-white/15 hover:text-violet-300 active:scale-90 transition-all" title="全屏" @click="toggleFullscreen">
                <UIcon
                  :name="isFullscreen ? 'i-heroicons-arrows-pointing-in' : 'i-heroicons-arrows-pointing-out'"
                  class="w-7 h-7"
                />
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <VideoPlayerEpisodeOverlay />
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'

const {
  videoEl, playerContainer, progressBar, speedMenuRef, videoKey, videoUrl,
  isHls, isPlaying, isBuffering, isResolvingUrl, isProbing, isFullscreen, isVideoLoaded,
  showControls, showPlayIcon, showSpeedMenu,
  currentTime, duration, volume, playbackRate, desiredRate, autoBestRate, autoRateCap,
  progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, hoverTime, hoverPercent,
  hlsStats, playlist, playlistTitle, hasPrev, hasNext, strategyLabel, showAdvancedProxy,
  // 选集按钮在顶部信息条里（VideoPlayerTopBar），这里只留抽屉本身要用的状态
  currentVideoName, volumeIcon, supportsPiP, canDownload,
  togglePlay, skip, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate,
  // 容器的 mousemove 走手势层的 onMouseMove（要滤掉触摸补发的兼容鼠标事件），不直接用 handleMouseMove
  toggleFullscreen, togglePiP, hideControlsDelayed, keepControlsAlive,
  // 手势层（useVideoGestures）
  isLocked, showLockBtn, toggleLock, brightness, gestureHud, seekFlash, touchAction, controlsVisible,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseMove, boostActive, boostRate,
  playPrev, playNext,
  isDownloading, downloadProgress, downloadVideo, cancelDownload,
  onTimeUpdate, onLoadedMetadata, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onVolumeChange, onVideoError,
} = useVideoPlayerCtx()

// 倍速菜单点击外部关闭
onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })

// 「停在那儿了」：暂停且不是在加载/取址中。加载中另有转圈遮罩，两个叠一起只会打架。
// 自动播放被浏览器拦下时也是这个状态——那正是最需要一枚大播放键的时候。
// 窄屏（手机竖屏）：控制栏塞不下十来个图标，下载/画中画这类低频项直接不渲染。
// 用 matchMedia 而不是 Tailwind 的 hidden：这两块是 <template>，没有能挂 class 的元素
const isNarrow = ref(false)
onMounted(() => {
  const mq = window.matchMedia('(max-width: 639px)')
  isNarrow.value = mq.matches
  mq.addEventListener('change', e => { isNarrow.value = e.matches })
})

const pausedIdle = computed(() =>
  isVideoLoaded.value && !isPlaying.value && !isBuffering.value && !isResolvingUrl.value)
</script>

<!--
  这些过渡类名以前只写在 pages/video-player.vue 的 scoped 样式里，
  而元素在本组件内——父组件的 scoped 罩不到子组件内部，等于一直没生效（淡入淡出全是硬切）。
  一律就近放在用它的组件里。
-->
<style scoped>
/* 控制栏：起落带一点缓动过冲，比线性 ease 显得「托」得住 */
.slide-up-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-up-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-up-enter-from,
.slide-up-leave-to { opacity: 0; transform: translateY(24px); }

/* 通用弹入：中央图标、HUD、锁定键共用 */
.pop-enter-active { transition: opacity .16s ease, transform .28s cubic-bezier(.2, 1.5, .4, 1); }
.pop-leave-active { transition: opacity .35s ease, transform .35s ease-out; }
.pop-enter-from { opacity: 0; transform: scale(.7); }
.pop-leave-to { opacity: 0; transform: scale(1.25); }

/* 顶部提示条从上方掉下来 */
.drop-enter-active { transition: opacity .18s ease, transform .3s cubic-bezier(.2, 1.5, .4, 1); }
.drop-leave-active { transition: opacity .18s ease, transform .18s ease-in; }
.drop-enter-from,
.drop-leave-to { opacity: 0; transform: translateY(-14px) scale(.9); }

/* 双击区整体淡入淡出（水波纹自己另有动画） */
.ripple-enter-active { transition: opacity .12s ease; }
.ripple-leave-active { transition: opacity .45s ease; }
.ripple-enter-from,
.ripple-leave-to { opacity: 0; }

/* 播放/暂停图标外圈炸开的一圈光晕 */
.blast { animation: blast .5s ease-out forwards; }
@keyframes blast {
  from { transform: scale(1); opacity: .55; }
  to   { transform: scale(1.9); opacity: 0; }
}

/* 双击落点的水波纹：从屏幕外缘涌进来再退回去 */
.ripple-blob { animation: blob .7s ease-out; }
@keyframes blob {
  0%   { transform: translateY(-50%) scale(.55); opacity: 0; }
  35%  { opacity: 1; }
  100% { transform: translateY(-50%) scale(1); opacity: 0; }
}

/* 三个箭头依次亮起（delay 由内联 style 给），长按提示的三角也复用 */
.chev { animation: chev 1s ease-in-out infinite; }
@keyframes chev {
  0%, 100% { opacity: .3; }
  45%      { opacity: 1; }
}

/* 秒数变化时弹一下：连点累加要看得出来又加了 5 秒 */
.secs-pop { animation: secs .3s cubic-bezier(.2, 1.6, .4, 1); }
@keyframes secs {
  from { transform: scale(1.5); }
  to   { transform: scale(1); }
}

/* 长按提示条的呼吸光晕 */
.boost-glow { animation: glow 1.4s ease-in-out infinite; }
@keyframes glow {
  0%, 100% { box-shadow: 0 0 14px rgba(167, 139, 250, .45); }
  50%      { box-shadow: 0 0 26px rgba(217, 70, 239, .75); }
}

/* 锁定图标翻面 */
.lock-flip { animation: flip .35s ease-out; }
@keyframes flip {
  from { transform: rotateY(90deg) scale(.6); }
  to   { transform: rotateY(0) scale(1); }
}

/* 音量滑块的白色圆钮（同样从页面挪过来的：写在父组件里对这里的 input 无效） */
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 6px rgba(167, 139, 250, .9);
}

/* 系统开了「减弱动效」就只留淡入淡出——这类循环动画对前庭敏感的人是实打实的不适 */
@media (prefers-reduced-motion: reduce) {
  .blast, .ripple-blob, .chev, .secs-pop, .boost-glow, .lock-flip { animation: none; }
  .slide-up-enter-active, .slide-up-leave-active,
  .pop-enter-active, .pop-leave-active,
  .drop-enter-active, .drop-leave-active { transition: opacity .15s ease; }
  .pop-enter-from, .pop-leave-to, .drop-enter-from, .drop-leave-to { transform: none; }
}
</style>
