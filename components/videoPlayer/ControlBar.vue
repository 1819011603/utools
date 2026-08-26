<template>
  <Transition name="slide-up">
    <div
      v-show="controlsVisible"
      data-no-gesture
      class="absolute z-10 bottom-0 left-0 right-0 pointer-events-none
             bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2.5 pb-2.5 pt-8 sm:px-4 sm:pb-4 sm:pt-12"
      @click.stop
      @pointerdown="keepControlsAlive"
      @pointerup="keepControlsAlive"
    >
      <!--
        腾讯视频移动端那套排布：竖屏时进度条**内联在按钮行里**（播放 | 时间 | 进度 | 倍速 | 全屏），
        宽屏才让它独占上面一行。原来固定「进度条一行 + 按钮一行」，
        窄屏上十来个控件挤成一坨还互相压字（实测截图里时间和齿轮叠在一起）。
        一行流式布局 + order 换位，两种屏幕共用同一个 progressBar ref。
      -->
      <!--
        `pointer-events-auto` 只给这一行：外层那圈渐变+上留白在小窗里有几十 px 高，
        让它吃事件的话，画面中间的双击（播放/暂停）全被它接走了——表现就是「小窗点不动」。
        `flex-nowrap`：窄屏一换行就摞成两排糊在画面中间（实测截图），宁可各项收小。
      -->
      <div class="pointer-events-auto flex items-center gap-1 flex-nowrap sm:gap-1.5 sm:flex-wrap">
        <button
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all shrink-0"
          @click="togglePlay"
        >
          <UIcon :name="isPlaying ? 'i-heroicons-pause-solid' : 'i-heroicons-play-solid'" class="w-6 h-6 sm:w-7 sm:h-7" />
        </button>

        <!--
          **窄屏也要有「上一集」**。原来是 `hidden sm:block`（竖屏一行放不下就砍它），
          代价是手机上根本没法往回切集，而且更坑的是：用户会去点「本该有这枚按钮的位置」，
          那儿是画面本身 → 连点两下正好被手势层判成双击 → 整个进了全屏
          （用户报「小屏点上下集就全屏了，没法切集」，根因就是这枚按钮不在）。
          一行放得下：窄屏本来就把音量整组、下载、画中画都收了。

          两个按钮在切集期间换成转圈图标：切集要等取址/探测/建流，画面中央那个转圈
          离手指很远，按钮自己不给反馈的话看着就像「点了没用」（于是用户又点一下）。
          **但绝不能 `:disabled`**：Chrome 不给 disabled 控件派发鼠标事件，那一下会落到
          容器上被手势层接走 → 又是「点切集结果全屏了」。切集中照样可点，
          交给 playByIndex 的 latest-wins 排队处理（连点两下就是跳两集，本来就该这样）。
        -->
        <button
          v-if="playlist.length > 1"
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
          :class="hasPrev ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
          :disabled="!hasPrev"
          title="上一集（P）"
          @click="playPrev"
        >
          <UIcon
            :name="isSwitching ? 'i-heroicons-arrow-path' : 'i-heroicons-backward-solid'"
            class="w-5 h-5 sm:w-6 sm:h-6" :class="{ 'animate-spin': isSwitching }"
          />
        </button>
        <!--
          hover / 手指按下就开始备下一集（见 useVideoPrewarm.prewarmNextNow）：
          比任何时间窗口都准的意图信号，能把「中途手动点下一集」从全冷路径救回来。
          pointerenter 覆盖鼠标与触摸笔，touchstart 补上手指（触摸端没有真正的 hover）。
        -->
        <button
          v-if="playlist.length > 1"
          class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
          :class="hasNext ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
          :disabled="!hasNext"
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

        <!-- 手机上没有 hover，滑条永远展不开；音量有硬件键和竖滑手势，整组藏起来腾地方 -->
        <div class="order-1 hidden sm:flex items-center gap-2 group/volume ml-1 shrink-0">
          <button class="p-1.5 rounded-lg text-white hover:bg-white/15 transition-all" @click="toggleMute">
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

        <span class="order-2 text-white text-[11px] sm:text-sm font-mono tabular-nums whitespace-nowrap shrink-0">
          {{ formatTime(currentTime) }}<span class="text-white/50"> / {{ formatTime(duration) }}</span>
        </span>

        <!-- 进度条：窄屏内联占据中间空档，宽屏 order-first + w-full 自己占一行 -->
        <div
          ref="progressBar"
          class="order-3 flex-1 min-w-[64px] sm:order-first sm:w-full sm:flex-none sm:mb-1.5
                 relative h-1 sm:h-1.5 bg-white/25 rounded-full cursor-pointer group/progress touch-none"
          @pointerdown="startSeek"
          @mousemove="updateHoverTime"
          @mouseleave="hoverTime = null"
        >
          <div class="absolute h-full bg-white/35 rounded-full" :style="{ width: bufferedPercent + '%' }" />
          <div
            class="absolute h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400
                   shadow-[0_0_8px_rgba(167,139,250,.7)]"
            :style="{ width: progressPercent + '%' }"
          />
          <!-- 圆钮常显（腾讯也是常显）：触摸端没有 hover，藏起来就等于没有抓手 -->
          <div
            class="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 bg-white rounded-full shadow-lg
                   ring-2 ring-violet-400/50 transition-transform group-hover/progress:scale-125"
            :style="{ left: `calc(${progressPercent}% - 7px)` }"
          />
          <!--
            悬浮预览：缩略图 + 时间。**贴边要夹住**（`clamp`）——不夹的话在进度条两端
            这块 240px 宽的卡片有一半在画面外，而那两端恰恰是最常悬浮的地方。
            整块 `pointer-events-none`：它盖在进度条上方，吃了事件就等于把 hover 自己掐断。
            `thumbEnabled` 为假（整片 MP4 / 浏览器不支持 MSE）时退回原来那个纯时间小气泡。
          -->
          <div
            v-if="hoverTime !== null"
            class="absolute bottom-full mb-2.5 -translate-x-1/2 pointer-events-none"
            :style="{ left: `clamp(${thumbHalfW}, ${hoverPercent}%, calc(100% - ${thumbHalfW}))` }"
          >
            <div
              v-if="thumbEnabled"
              class="rounded-lg overflow-hidden bg-black/85 ring-1 ring-white/20 shadow-2xl"
              :style="{ width: THUMB_BOX_W + 'px' }"
            >
              <!-- 图位恒占高：有图无图之间不能改变卡片高度，否则沿进度条扫过去整块在上下跳 -->
              <div class="relative bg-black/60 flex items-center justify-center" :style="{ height: thumbBoxH + 'px' }">
                <img v-if="thumbImage" :src="thumbImage" class="w-full h-full object-cover" alt="">
                <UIcon
                  v-else
                  :name="thumbPending ? 'i-heroicons-arrow-path' : 'i-heroicons-photo'"
                  class="w-5 h-5 text-white/30"
                  :class="{ 'animate-spin': thumbPending }"
                />
              </div>
              <div class="py-1 text-center text-white text-xs font-mono tabular-nums">{{ formatTime(hoverTime) }}</div>
            </div>
            <div v-else class="px-2 py-1 bg-black/80 text-white text-xs rounded font-mono tabular-nums">
              {{ formatTime(hoverTime) }}
            </div>
          </div>
          <div
            v-else-if="seekPreviewTime !== null"
            class="absolute bottom-full mb-2.5 px-2 py-1 bg-black/80 text-white text-xs rounded
                   font-mono tabular-nums transform -translate-x-1/2"
            :style="{ left: seekPreviewPercent + '%' }"
          >
            {{ formatTime(seekPreviewTime) }}
          </div>
        </div>

        <!--
          右侧一组：宽屏时靠 ml-auto 推到最右（进度条独占上一行后这行需要自己撑开）。
          **间距和触靶都比左侧一组松**：这几个是最常点的（倍速/设置/全屏），
          原来 `gap-0.5` + `p-1.5` 在宽屏上挤成一坨、几个图标边缘几乎贴着（用户反馈）。
          窄屏仍收紧——那一行本来就快放不下（`flex-nowrap`，一换行就摞成两排糊在画面中间）。
        -->
        <div class="order-4 flex items-center gap-1 sm:gap-2 shrink-0 sm:ml-auto">
          <!-- 清晰度：优先显示解码实测的真实像素，清单声明的值不总是准（见 useVideoEvents.videoRes）。
               窄屏藏起来——这一行本来就挤，清晰度不如倍速/设置/全屏要紧 -->
          <span v-if="videoRes" class="hidden sm:inline px-1 text-xs font-medium text-white/70 whitespace-nowrap">{{ videoRes }}</span>
          <div ref="speedMenuRef" class="relative">
            <button
              class="px-1.5 sm:px-2.5 py-1.5 sm:py-2 rounded-lg text-white hover:bg-white/15 transition-all text-xs sm:text-sm font-semibold whitespace-nowrap"
              :title="autoBestRate
                ? `自动最佳倍速：上限 ${autoRateCap}x，当前带宽下实际 ${playbackRate}x` : `倍速 ${playbackRate}x`"
              @click="showSpeedMenu = !showSpeedMenu"
            >
              <!-- 「/上限」只要开着自动就常显：早先加了 playbackRate !== autoRateCap 的条件，
                   生效倍速一爬到上限后缀就消失，控制栏上反而看不出自动还开着、上限是几 -->
              {{ playbackRate }}x<span v-if="autoBestRate" class="text-white/50">/{{ autoRateCap }}</span>
            </button>
            <Transition name="fade">
              <!--
                   z-30：菜单要盖过顶部信息条（z-[5]）和控制栏自己。原来没设 z，
                   菜单往上展开时最上面那几档（3.0x）正好落在顶部信息条底下，点不着。
                   再加高度上限 + 自身滚动：画面只有 200 多 px 高时，八个档位一屏放不下。
              -->
              <div
                v-if="showSpeedMenu"
                ref="speedMenuList"
                class="no-sb absolute z-30 bottom-full right-0 mb-2 rounded-xl overflow-y-auto
                       min-w-[88px] max-h-[min(60vh,240px)]
                       bg-gradient-to-br from-white/10 via-rose-200/10 to-violet-300/15
                       backdrop-blur-md ring-1 ring-white/20 shadow-xl shadow-violet-950/20"
              >
                <!-- 档位表来自 controls.rateOptions：开了「超快倍速」才多出 3.5~5x 那几档 -->
                <button
                  v-for="rate in rateOptions"
                  :key="rate"
                  :data-rate="rate"
                  class="block w-full px-5 py-2.5 text-sm text-white text-center transition-colors
                         hover:bg-white/15 drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]"
                  :class="{ 'bg-gradient-to-r from-rose-400/45 to-violet-400/45 font-semibold': desiredRate === rate }"
                  @click="setPlaybackRate(rate)"
                >
                  {{ rate }}x
                </button>
              </div>
            </Transition>
          </div>

          <!-- 自动全屏 / 自动倍速 / 跳过片头片尾：全是看片当下才改的，放这儿手不用离开画面 -->
          <VideoPlayerSettingsMenu />

          <button v-if="supportsPiP && !isNarrow" class="p-1.5 sm:p-2 rounded-lg text-white hover:bg-white/15 transition-all" title="画中画（I）" @click="togglePiP">
            <UIcon name="i-heroicons-rectangle-stack" class="w-6 h-6 sm:w-7 sm:h-7" />
          </button>

          <button class="p-1.5 sm:p-2 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all" title="全屏（F）" @click="toggleFullscreen">
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
 * 播放器底部控制栏：播放/上下集/音量/时间/进度条/倍速/设置/画中画/全屏。
 *
 * 从 Stage.vue 拆出来（那边超了 500 行）。**不传 props**，跟其它子组件一样各自
 * `useVideoPlayerCtx()` 解构——所以各模块返回的键名不能重复（见 useVideoPlayerController）。
 *
 * 版式参照腾讯视频移动端：窄屏时进度条**内联在按钮行里**，宽屏才 `order-first + w-full`
 * 让它独占上面一行（同一个 progressBar ref，靠 order 换位）。
 */
import { onClickOutside } from '@vueuse/core'

const {
  progressBar, speedMenuRef, isPlaying, isFullscreen,
  currentTime, duration, volume, playbackRate, desiredRate, autoBestRate, autoRateCap,
  progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, hoverTime, hoverPercent,
  playlist, hasPrev, hasNext, isSwitching, prewarmNextNow,
  volumeIcon, supportsPiP, showSpeedMenu, controlsVisible,
  togglePlay, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate, rateOptions,
  toggleFullscreen, togglePiP, keepControlsAlive, playPrev, playNext,
  // 清晰度：与页面信息条、全屏顶栏共用同一份计算（useVideoEvents.videoRes）
  videoRes,
  // 进度条悬浮缩略图（见 useVideoThumbnails）。videoEl 只用来读真实比例
  videoEl, thumbImage, thumbPending, thumbEnabled,
} = useVideoPlayerCtx()

/**
 * 预览卡片的展示宽度。**比抓帧宽度（240）小一圈**，多出来那些像素正好当高密度屏的 2x 用，
 * 不然 Retina 上看着发虚。高度按视频**真实比例**算——这个项目里 2.40:1 的片子很常见，
 * 写死 16:9 会让卡片上下各留一条黑边（拿不到尺寸时才退回 16:9）。
 */
const THUMB_BOX_W = 200
const thumbHalfW = `${THUMB_BOX_W / 2}px`
const thumbBoxH = computed(() => {
  const v = videoEl.value
  const ratio = v?.videoWidth && v?.videoHeight ? v.videoHeight / v.videoWidth : 9 / 16
  return Math.round(THUMB_BOX_W * ratio)
})

// 倍速菜单点击外部关闭
onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })

/**
 * 打开倍速菜单时把当前档位滚到视野中间。
 *
 * 八个档位一屏放不下（画面只有 200 多 px 高时更挤），而常用的高倍速正好在列表尾部——
 * 不定位的话每次打开都停在 0.5x，用户得先滑一段才看得见自己选的是哪个。
 *
 * 用 scrollTop 手算而不是 `scrollIntoView({ block: 'center' })`：后者会顺带滚动**外层**的
 * 滚动容器（页面/全屏层），表现是菜单一开画面自己往上跳一下。
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

// 窄屏（手机竖屏）：控制栏塞不下这么多图标，画中画这类低频项直接不渲染。
// 判定收在 useNarrowScreen 里（Stage 也要用同一个断点，各写一份必然漂移）
const isNarrow = useNarrowScreen()
</script>

<style scoped>
/* 控制栏：起落带一点缓动过冲，比线性 ease 显得「托」得住。
   scoped 样式必须跟着元素走——留在父组件里罩不到子组件内部，等于淡入淡出全是硬切 */
.slide-up-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-up-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-up-enter-from,
.slide-up-leave-to { opacity: 0; transform: translateY(24px); }

.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
