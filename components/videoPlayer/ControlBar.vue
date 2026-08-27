<template>
  <Transition name="slide-up">
    <div
      v-show="controlsVisible"
      data-no-gesture
      class="absolute z-10 bottom-0 left-0 right-0 pointer-events-none
             bg-gradient-to-t from-black/90 via-black/45 to-transparent
             px-2.5 pb-1.5 pt-8 sm:px-5 sm:pb-2 sm:pt-14"
      @click.stop
      @pointerdown="keepControlsAlive"
      @pointerup="keepControlsAlive"
    >
      <!-- `pointer-events-auto` 只给这一行：外层那圈渐变在小窗里有几十 px 高，
           让它吃事件的话画面中间的双击全被它接走（表现是「小窗点不动」） -->
      <!-- 换行时的行间距要单独压小（`gap-2` 是两轴都吃的，8px 的行距会把进度条顶高一截） -->
      <div class="pointer-events-auto flex items-center gap-1 flex-nowrap
                  sm:gap-x-2 sm:gap-y-0.5 sm:flex-wrap">
        <button
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all shrink-0"
          @click="togglePlay"
        >
          <UIcon :name="isPlaying ? 'i-heroicons-pause-solid' : 'i-heroicons-play-solid'" class="w-6 h-6 sm:w-7 sm:h-7" />
        </button>

        <!-- 窄屏也必须有「上一集」，且切集期间只换转圈图标、**绝不 `:disabled`**
             （两条都是为了不让那一下落到手势层上变成「点切集结果全屏了」） -->
        <button
          v-if="playlist.length > 1"
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
          :class="hasPrev ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
          title="上一集（P）"
          @click="playPrev"
        >
          <UIcon
            :name="isSwitching ? 'i-heroicons-arrow-path' : 'i-heroicons-backward-solid'"
            class="w-5 h-5 sm:w-6 sm:h-6" :class="{ 'animate-spin': isSwitching }"
          />
        </button>
        <!-- hover / 手指按下就开始备下一集：比任何时间窗口都准的意图信号 -->
        <button
          v-if="playlist.length > 1"
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
          :class="hasNext ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
          title="下一集（N）"
          @pointerenter="hasNext && prewarmNextNow()"
          @touchstart.passive="hasNext && prewarmNextNow()"
          @click="playNext()"
        >
          <UIcon
            :name="isSwitching ? 'i-heroicons-arrow-path' : 'i-heroicons-forward-solid'"
            class="w-5 h-5 sm:w-6 sm:h-6" :class="{ 'animate-spin': isSwitching }"
          />
        </button>

        <!-- 手机上没有 hover，滑条永远展不开；音量有硬件键、竖滑手势和设置抽屉，整组藏起来腾地方 -->
        <div class="order-1 hidden sm:flex items-center gap-2 group/volume shrink-0">
          <button class="p-1.5 rounded-lg text-white hover:bg-white/15 transition-all" @click="toggleMute">
            <UIcon :name="volumeIcon" class="w-6 h-6" />
          </button>
          <div class="w-0 group-hover/volume:w-20 overflow-hidden transition-all duration-200">
            <input
              type="range" min="0" max="1" step="0.05"
              :value="volume"
              class="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer accent-rose-500"
              @input="setVolume"
            >
          </div>
        </div>

        <!-- 进度那一组：时间 | 条 | 总时长。窄屏内联占中间空档，宽屏独占上面一行 -->
        <div
          class="order-3 flex-1 min-w-0 flex items-center gap-2 sm:gap-3
                 sm:order-first sm:w-full sm:flex-none"
        >
          <span class="shrink-0 text-white text-[11px] sm:text-[13px] font-mono tabular-nums">
            {{ formatTime(currentTime) }}
          </span>

          <div
            ref="progressBar"
            class="relative flex-1 min-w-[52px] h-[3px] sm:h-1 bg-white/25 rounded-full
                   cursor-pointer group/progress touch-none"
            @pointerdown="startSeek"
            @mousemove="updateHoverTime"
            @mouseleave="hoverTime = null"
          >
            <div class="absolute h-full bg-white/35 rounded-full" :style="{ width: bufferedPercent + '%' }" />
            <div
              class="absolute h-full rounded-full bg-gradient-to-r from-rose-500 to-fuchsia-400
                     shadow-[0_0_8px_rgba(244,63,94,.6)]"
              :style="{ width: progressPercent + '%' }"
            />
            <!-- 圆钮常显：触摸端没有 hover，藏起来就等于没有抓手 -->
            <div
              class="absolute top-1/2 -translate-y-1/2 w-3 h-3 sm:w-3.5 sm:h-3.5 bg-rose-500 rounded-full
                     shadow-lg ring-2 ring-white/70 transition-transform group-hover/progress:scale-125"
              :style="{ left: `calc(${progressPercent}% - 6px)` }"
            />
            <div
              v-if="hoverTime !== null"
              class="absolute bottom-full mb-2 px-1.5 py-0.5 bg-black/85 text-white text-[11px] rounded
                     font-mono tabular-nums -translate-x-1/2 pointer-events-none"
              :style="{ left: hoverPercent + '%' }"
            >{{ formatTime(hoverTime) }}</div>
            <div
              v-else-if="seekPreviewTime !== null"
              class="absolute bottom-full mb-2 px-1.5 py-0.5 bg-black/85 text-white text-[11px] rounded
                     font-mono tabular-nums -translate-x-1/2"
              :style="{ left: seekPreviewPercent + '%' }"
            >{{ formatTime(seekPreviewTime) }}</div>
          </div>

          <span class="shrink-0 text-white/55 text-[11px] sm:text-[13px] font-mono tabular-nums">
            {{ formatTime(duration) }}
          </span>
        </div>

        <!-- 右侧一组：宽屏靠 ml-auto 推到最右（进度条独占上一行后这行要自己撑开） -->
        <div class="order-4 flex items-center gap-0.5 sm:gap-2 shrink-0 sm:ml-auto">
          <!-- 换源：线路表来自解析，只有真的有第二条线路才出。全屏时页面上那些入口全看不见 -->
          <button
            v-if="playlistLines.length > 1"
            class="hidden sm:flex items-center gap-1 px-2 py-1.5 rounded-lg text-white text-sm
                   hover:bg-white/15 active:scale-95 transition-all whitespace-nowrap"
            :class="{ 'bg-white/15': showLines }"
            title="换线路（留在这一集、接着当前进度）"
            @click="openPanel('lines')"
          >
            <UIcon v-if="isSwitchingLine" name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" />
            换源
          </button>
          <!-- 当前线路：安卓端就是这么一枚「L4」，占地小、又一眼看得出在哪条线上 -->
          <span
            v-if="lineTag"
            class="px-1 text-xs font-medium text-white/60 tabular-nums whitespace-nowrap"
            :title="`当前线路：${lineName}`"
          >{{ lineTag }}</span>

          <span v-if="videoRes" class="hidden sm:inline px-1 text-xs font-medium text-white/60 whitespace-nowrap">
            {{ videoRes }}
          </span>

          <div ref="speedMenuRef" class="relative">
            <button
              class="px-1.5 sm:px-2 py-1.5 rounded-lg text-white hover:bg-white/15 transition-all
                     text-xs sm:text-sm font-semibold whitespace-nowrap"
              :title="autoBestRate
                ? `自动最佳倍速：上限 ${autoRateCap}x，当前带宽下实际 ${playbackRate}x` : `倍速 ${playbackRate}x`"
              @click="showSpeedMenu = !showSpeedMenu"
            >
              {{ playbackRate }}x<span v-if="autoBestRate" class="text-white/45">/{{ autoRateCap }}</span>
            </button>
            <Transition name="fade">
              <!--
                高度上限分两档：竖屏时播放器只有 200 多 px 高、容器又是 overflow-hidden，
                给 vh 的话菜单会被裁掉一半（`60vh` 在手机上远大于播放器本身）。
              -->
              <div
                v-if="showSpeedMenu"
                ref="speedMenuList"
                class="no-sb absolute z-30 bottom-full right-0 mb-2 rounded-lg overflow-y-auto
                       min-w-[64px] max-h-[104px] sm:max-h-[228px]
                       bg-black/80 backdrop-blur-xl ring-1 ring-white/10 shadow-xl"
              >
                <button
                  v-for="rate in rateOptions"
                  :key="rate"
                  :data-rate="rate"
                  class="block w-full px-3.5 py-1.5 text-xs text-white/85 text-center transition-colors hover:bg-white/10"
                  :class="{ 'bg-rose-500/85 text-white font-semibold': desiredRate === rate }"
                  @click="setPlaybackRate(rate)"
                >{{ rate }}x</button>
              </div>
            </Transition>
          </div>

          <!-- 选集：从顶栏挪到这儿（安卓端也在这一行）。全屏里换集是最高频的动作 -->
          <button
            v-if="playlist.length > 1"
            class="flex items-center gap-1 px-1.5 sm:px-2 py-1.5 rounded-lg text-white text-xs sm:text-sm
                   transition-all active:scale-95 whitespace-nowrap"
            :class="showEpisodes ? 'bg-rose-500/80' : 'hover:bg-white/15'"
            title="选集"
            @click="openPanel('episodes')"
          >
            <UIcon name="i-heroicons-queue-list" class="w-5 h-5 sm:hidden" />
            <span class="hidden sm:inline">选集</span>
          </button>

          <button
            class="p-1 sm:p-1.5 rounded-lg text-white hover:bg-white/15 transition-all"
            title="播放设置"
            @click="openPanel('settings')"
          >
            <UIcon
              name="i-heroicons-cog-6-tooth" class="w-5 h-5 sm:w-6 sm:h-6 transition-transform"
              :class="{ 'rotate-90': showSettings }"
            />
          </button>

          <button
            v-if="supportsPiP && !isNarrow"
            class="p-1.5 rounded-lg text-white hover:bg-white/15 transition-all"
            title="画中画（I）"
            @click="togglePiP"
          >
            <UIcon name="i-heroicons-rectangle-stack" class="w-6 h-6" />
          </button>

          <button
            class="p-1 sm:p-1.5 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all"
            title="全屏（F）"
            @click="toggleFullscreen"
          >
            <UIcon
              :name="isFullscreen ? 'i-heroicons-arrows-pointing-in' : 'i-heroicons-arrows-pointing-out'"
              class="w-6 h-6 sm:w-7 sm:h-7"
            />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 底部控制栏。**不传 props**，跟其它子组件一样各自 `useVideoPlayerCtx()`
 * ——所以各模块返回的键名不能重复（见 useVideoPlayerController）。
 *
 * 版式照安卓客户端：时间分列进度条两侧；窄屏整条内联在按钮行里，
 * 宽屏/全屏时进度那组 `order-first + w-full` 独占上面一行（同一个 progressBar ref，靠 order 换位）。
 */
import { onClickOutside } from '@vueuse/core'

const {
  progressBar, speedMenuRef, isPlaying, isFullscreen,
  currentTime, duration, volume, playbackRate, desiredRate, autoBestRate, autoRateCap,
  progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, hoverTime, hoverPercent,
  playlist, hasPrev, hasNext, isSwitching, prewarmNextNow,
  volumeIcon, supportsPiP, showSpeedMenu, controlsVisible,
  showEpisodes, showSettings, showLines,
  playlistLines, playlistSource, isSwitchingLine,
  togglePlay, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate, rateOptions,
  toggleFullscreen, togglePiP, keepControlsAlive, playPrev, playNext,
  videoRes,
} = useVideoPlayerCtx()

onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })

const lineName = computed(() =>
  playlistLines.value[playlistSource.value?.line ?? -1]?.name || playlistSource.value?.lineName || '')
// 「L4」= 第 4 条线路。名字往往是「超清2」这种长串，控制栏上放不下
const lineTag = computed(() => {
  const i = playlistSource.value?.line
  return typeof i === 'number' && i >= 0 && playlistLines.value.length > 1 ? `L${i + 1}` : ''
})

/** 三个浮层互斥：两块都摊在画面右侧，同时开就是叠在一起 */
const openPanel = (which: 'episodes' | 'settings' | 'lines') => {
  showEpisodes.value = which === 'episodes' && !showEpisodes.value
  showSettings.value = which === 'settings' && !showSettings.value
  showLines.value = which === 'lines' && !showLines.value
}

/**
 * 打开倍速菜单时把当前档位滚到视野中间。用 scrollTop 手算而不是
 * `scrollIntoView({ block: 'center' })`——后者会顺带滚动**外层**容器，表现是菜单一开画面自己往上跳。
 */
const speedMenuList = ref<HTMLElement | null>(null)
watch(showSpeedMenu, async (open) => {
  if (!open) return
  await nextTick()
  const box = speedMenuList.value
  const item = box?.querySelector<HTMLElement>(`[data-rate="${desiredRate.value}"]`)
  if (!box || !item) return
  box.scrollTop = item.offsetTop - (box.clientHeight - item.offsetHeight) / 2
})

// 窄屏（手机竖屏）：画中画这类低频项直接不渲染。断点收在 useNarrowScreen 里（Stage 也要用同一个）
const isNarrow = useNarrowScreen()
</script>

<style scoped>
/* scoped 样式必须跟着元素走——留在父组件里罩不到子组件内部，等于淡入淡出全是硬切 */
.slide-up-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-up-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-up-enter-from,
.slide-up-leave-to { opacity: 0; transform: translateY(24px); }

.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
}
</style>
