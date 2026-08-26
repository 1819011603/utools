<script setup lang="ts">
/**
 * 全屏沉浸模式：仿桌面音乐播放器的大屏视图——黑底、封面转成旋转唱片、歌词左对齐大字，
 * 只亮当前这句。跟 `MusicLyrics.vue`（居中式跟唱卡片）是两种不同的呈现，各自独立开关。
 *
 * **故意不跟随站点的浅色 rose/zinc 主题**：这里黑底是必要的衬底（封面千人千色，
 * 浅底压不住），跟设置里的深浅色开关是两回事，所以颜色全部手写，不走 `dark:` 前缀。
 *
 * 播放控制是从 `PlayerBar.vue` 抄一份**精简版**（没有音量条/下载/随机——沉浸模式要的是
 * 沉浸，不是把控制栏搬过来），而不是复用同一个组件：这里的按钮全部要在黑底上重新配色，
 * 用 `UButton` 的亮色系配色在黑底上会糊成一片，索性用裸 `<button>` + `UIcon` 自己控制。
 */
import { activeLrcIndex } from '~/composables/musicPlayer/lrc'
import { formatTrackTime } from '~/composables/musicPlayer/display'

const {
  current, isPlaying, currentTime, duration, seekPreview, isSeeking, showImmersive,
  queue, repeat, togglePlay, seekTo, playNext, playPrev, cycleRepeat,
} = useMusicPlayerCtx()

const { isFavorite, toggleFavorite } = useMusicFavorites()
const curFavorited = computed(() => !!current.value && isFavorite(current.value.key))
const canCollect = computed(() => !!current.value?.resolver)
const onToggleFav = () => { if (current.value) toggleFavorite(current.value) }

// 歌词状态是模块级单例，跟播放条、歌词面板共用同一份——这里只读，取词仍由 PlayerBar 统一驱动
const { parsed, loading } = useMusicLyrics()
const hasLyrics = computed(() => parsed.value.lines.length > 0)
const activeIndex = computed(() =>
  parsed.value.synced ? activeLrcIndex(parsed.value.lines, currentTime.value) : -1,
)

const listEl = ref<HTMLElement>()

watch(activeIndex, async (i) => {
  if (i < 0 || !showImmersive.value) return
  await nextTick()
  listEl.value?.querySelector(`[data-lrc="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})

/** 每次打开都要把当前句顶到正中间——不然从上次收起时残留的滚动位置开始，看着像没生效 */
watch(showImmersive, async (open) => {
  if (!open) return
  await nextTick()
  const i = activeIndex.value
  if (i >= 0) listEl.value?.querySelector(`[data-lrc="${i}"]`)?.scrollIntoView({ block: 'center' })
})

// ── 进度条：同 PlayerBar 那份（拖动中只更新预览，松手才真 seek） ──
const progressEl = ref<HTMLElement>()
const shownTime = computed(() => seekPreview.value ?? currentTime.value)
const shownPercent = computed(() =>
  duration.value ? Math.min(100, (shownTime.value / duration.value) * 100) : 0,
)

const posToTime = (clientX: number) => {
  const el = progressEl.value
  if (!el || !duration.value) return 0
  const r = el.getBoundingClientRect()
  return ((clientX - r.left) / r.width) * duration.value
}

const onPointerDown = (e: PointerEvent) => {
  if (!duration.value) return
  isSeeking.value = true
  seekPreview.value = posToTime(e.clientX)
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
const onPointerMove = (e: PointerEvent) => {
  if (!isSeeking.value) return
  seekPreview.value = Math.max(0, Math.min(posToTime(e.clientX), duration.value))
}
const onPointerUp = () => {
  if (!isSeeking.value) return
  if (seekPreview.value != null) seekTo(seekPreview.value)
  isSeeking.value = false
  seekPreview.value = null
}

const hasQueue = computed(() => queue.value.length > 0)
const repeatIcon = computed(() =>
  repeat.value === 'one' ? 'i-heroicons-arrow-path-rounded-square' : 'i-heroicons-arrow-path',
)
const repeatLabel = computed(() =>
  repeat.value === 'off' ? '不循环' : repeat.value === 'all' ? '列表循环' : '单曲循环',
)

/** Esc 退出，同任何全屏浮层的惯例 */
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') showImmersive.value = false }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showImmersive && current"
      class="fixed inset-0 z-[60] flex flex-col overflow-hidden text-zinc-100"
      style="background: radial-gradient(120% 100% at 20% 0%, #2a1f2a 0%, #1a1418 45%, #0a0708 100%)"
    >
      <!-- 退出 -->
      <div class="flex items-center justify-between px-4 sm:px-6 py-4 shrink-0">
        <button
          class="w-9 h-9 rounded-full grid place-items-center text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          title="收起沉浸模式"
          aria-label="收起沉浸模式"
          @click="showImmersive = false"
        >
          <UIcon name="i-heroicons-chevron-down" class="w-5 h-5" />
        </button>
      </div>

      <!-- 主体：左唱片 / 右歌词 -->
      <div class="flex-1 min-h-0 flex flex-col lg:flex-row items-center gap-6 lg:gap-16 px-6 sm:px-10 lg:px-20 pb-6 overflow-hidden">
        <div class="shrink-0 grid place-items-center">
          <div
            class="vinyl-spin relative w-48 h-48 sm:w-64 sm:h-64 lg:w-80 lg:h-80 rounded-full bg-black shadow-2xl ring-[10px] ring-black/50 grid place-items-center"
            :class="isPlaying && 'vinyl-playing'"
          >
            <div class="absolute inset-0 rounded-full vinyl-grooves" />
            <div class="w-[60%] h-[60%] rounded-full overflow-hidden ring-4 ring-black/70">
              <MusicCoverArt
                :src="current.cover"
                :alt="current.name"
                size-class="w-full h-full !rounded-full"
                icon-class="w-10 h-10"
              />
            </div>
            <div class="absolute w-3.5 h-3.5 rounded-full bg-zinc-700 ring-2 ring-zinc-500" />
          </div>
        </div>

        <div class="flex-1 min-w-0 w-full h-full flex flex-col min-h-0">
          <div class="shrink-0 text-center lg:text-left mb-2 lg:mb-4">
            <h2 class="text-lg sm:text-2xl font-semibold truncate">{{ current.name }}</h2>
            <p class="text-sm text-zinc-400 mt-1 truncate">
              <template v-if="current.artist">歌手：{{ current.artist }}</template>
              <template v-if="current.artist && current.album"> · </template>
              <template v-if="current.album">专辑：{{ current.album }}</template>
              <template v-if="!current.artist && !current.album">还没有更多信息</template>
            </p>
            <!--
              不是所有匹配到的词都带时间轴（纯文本 LRC、或站点原样给的没有 `[mm:ss]` 标签）——
              这种没法跟着高亮/滚动，整页看着就是静止的，容易被当成"没生效"。说清楚是缺时间轴，
              不是沉浸模式坏了（同 `NowLyric.vue` 那句提示，这里只是全屏下把它摆出来）。
            -->
            <p v-if="hasLyrics && !parsed.synced" class="text-xs text-amber-400/80 mt-2">
              这份歌词没有时间轴，没法跟着播放高亮，完整内容看右边
            </p>
          </div>

          <div class="flex-1 min-h-0 relative">
            <div v-if="loading" class="h-full flex items-center justify-center text-sm text-zinc-500">
              正在找歌词…
            </div>
            <div v-else-if="!hasLyrics" class="h-full flex items-center justify-center text-sm text-zinc-500">
              没有找到这首歌的歌词
            </div>
            <!--
              上下各垫大半屏空白，好让第一句/最后一句也能被 `scrollIntoView({block:'center'})` 顶到正中间。
              **必须用 `vh` 不能用 `%`**：CSS 规范里 padding-top/bottom 的百分比是相对**容器宽度**算的，
              不是高度——这栏歌词是页面右半边的窄列，`%` 算出来的垫高跟这一列的实际高度对不上，
              轻则居中偏得离谱、重则把整块撑得比视口还高，顶飞上面的标题（实测过一次）。
            -->
            <div
              v-else
              ref="listEl"
              class="immersive-lyrics h-full overflow-y-auto overscroll-contain py-[40vh] text-center lg:text-left"
            >
              <p
                v-for="(l, i) in parsed.lines"
                :key="i"
                :data-lrc="i"
                class="leading-loose transition-all duration-300 ease-out py-2"
                :class="[
                  parsed.synced && l.time >= 0 && 'cursor-pointer',
                  i === activeIndex
                    ? 'text-lg sm:text-2xl font-semibold text-white'
                    : 'text-base sm:text-lg text-zinc-500 hover:text-zinc-300',
                ]"
                @click="parsed.synced && l.time >= 0 && seekTo(l.time)"
              >
                {{ l.text }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 播放控制 -->
      <div class="shrink-0 px-6 sm:px-10 lg:px-20 pb-6 sm:pb-8 space-y-3">
        <div
          ref="progressEl"
          class="relative h-1.5 rounded-full bg-white/10 cursor-pointer touch-none"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <div class="absolute inset-y-0 left-0 rounded-full bg-primary-400" :style="{ width: shownPercent + '%' }" />
          <div
            v-if="duration"
            class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-primary-400 shadow"
            :style="{ left: shownPercent + '%' }"
          />
        </div>
        <div class="flex items-center justify-between text-xs text-zinc-400 tabular-nums">
          <span>{{ formatTrackTime(shownTime) }}</span>
          <span>{{ formatTrackTime(duration) }}</span>
        </div>

        <div class="flex items-center justify-center gap-3 sm:gap-6">
          <button
            v-if="canCollect"
            class="w-10 h-10 rounded-full grid place-items-center transition-colors hover:bg-white/10"
            :class="curFavorited ? 'text-primary-400' : 'text-zinc-400 hover:text-white'"
            :title="curFavorited ? '取消收藏' : '收藏'"
            :aria-label="curFavorited ? '取消收藏' : '收藏'"
            @click="onToggleFav"
          >
            <UIcon :name="curFavorited ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'" class="w-5 h-5" />
          </button>

          <button
            class="w-10 h-10 rounded-full grid place-items-center text-zinc-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            :disabled="!hasQueue"
            aria-label="上一首"
            @click="playPrev"
          >
            <UIcon name="i-heroicons-backward-solid" class="w-6 h-6" />
          </button>

          <button
            class="w-16 h-16 rounded-full grid place-items-center bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label="播放/暂停"
            @click="togglePlay"
          >
            <UIcon :name="isPlaying ? 'i-heroicons-pause-solid' : 'i-heroicons-play-solid'" class="w-8 h-8" />
          </button>

          <button
            class="w-10 h-10 rounded-full grid place-items-center text-zinc-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            :disabled="!hasQueue"
            aria-label="下一首"
            @click="playNext"
          >
            <UIcon name="i-heroicons-forward-solid" class="w-6 h-6" />
          </button>

          <button
            class="w-10 h-10 rounded-full grid place-items-center transition-colors hover:bg-white/10"
            :class="repeat === 'off' ? 'text-zinc-400 hover:text-white' : 'text-primary-400'"
            :title="repeatLabel"
            :aria-label="repeatLabel"
            @click="cycleRepeat"
          >
            <UIcon :name="repeatIcon" class="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.immersive-lyrics {
  mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent);
  scrollbar-width: none;
}
.immersive-lyrics::-webkit-scrollbar {
  display: none;
}

.vinyl-grooves {
  background: repeating-radial-gradient(
    circle,
    rgba(255, 255, 255, 0.05) 0px,
    rgba(255, 255, 255, 0.05) 1px,
    transparent 2px,
    transparent 6px
  );
}

/* 唱片旋转：暂停时定格在原位，不用每次都从 0 度重新起转 */
.vinyl-spin {
  animation: vinyl-rotate 16s linear infinite;
  animation-play-state: paused;
}
.vinyl-playing {
  animation-play-state: running;
}
@keyframes vinyl-rotate {
  to { transform: rotate(360deg); }
}
</style>
