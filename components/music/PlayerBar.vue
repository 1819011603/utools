<script setup lang="ts">
/**
 * 底部常驻播放条。
 *
 * 常驻而不是做成独立播放页：音乐是边听边干别的的事，搜下一首不该打断当前播放。
 * 不传 props，自己从 ctx 解构（同 videoPlayer 那套约定）。
 */
import { formatTrackTime, SEEK_STEP, VOLUME_STEP } from '~/composables/musicPlayer/display'

const {
  audioEl, current, isPlaying, currentTime, duration, volume, isMuted,
  isBuffering, isResolving, resolveStage, errorMessage, errorKind,
  queue, queueIndex, repeat, shuffle, seekPreview, isSeeking, progressPercent, showQueue,
  togglePlay, seekTo, setVolume, toggleMuted, playNext, playPrev, cycleRepeat, dismissError,
} = useMusicPlayerCtx()

const progressEl = ref<HTMLElement>()

/** 显示用的进度：拖动中显示预览位置，否则显示真实播放位置 */
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

/**
 * 拖动用 Pointer Events 而不是 mousedown 那套：触摸端不保证补发 move，
 * 只有「点一下能跳、拖不动」（同 useVideoGestures 里那条教训）。
 * 拖动过程中只更新预览，**松手才真 seek**——每动一下就 seek 会把解码器打断成一片卡顿。
 */
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

const repeatIcon = computed(() =>
  repeat.value === 'one' ? 'i-heroicons-arrow-path-rounded-square' : 'i-heroicons-arrow-path',
)
const repeatLabel = computed(() =>
  repeat.value === 'off' ? '不循环' : repeat.value === 'all' ? '列表循环' : '单曲循环',
)

const volumeIcon = computed(() => {
  if (isMuted.value || volume.value === 0) return 'i-heroicons-speaker-x-mark'
  return volume.value < 0.5 ? 'i-heroicons-speaker-wave' : 'i-heroicons-speaker-wave'
})

const hasQueue = computed(() => queue.value.length > 0)

// 副标题：歌手 · 音质 · 体积。没有的项直接不占位，别显示一串「—」
const subtitle = computed(() => {
  const t = current.value
  if (!t) return ''
  return [t.artist, t.quality, t.sizeText].filter(Boolean).join(' · ')
})

/** 空格播放/暂停、左右方向键快进退。输入框里不接管，否则打字就没法用了 */
const onKey = (e: KeyboardEvent) => {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
  if (!current.value) return
  if (e.code === 'Space') { e.preventDefault(); togglePlay() }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(currentTime.value + SEEK_STEP) }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(currentTime.value - SEEK_STEP) }
  else if (e.code === 'ArrowUp') { e.preventDefault(); setVolume(volume.value + VOLUME_STEP) }
  else if (e.code === 'ArrowDown') { e.preventDefault(); setVolume(volume.value - VOLUME_STEP) }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur">
    <!--
      不加 crossorigin：加了就把媒体请求变成 CORS 模式，凭空多一层约束。
      两个 CDN 虽然都给 ACAO:*，但这个属性对我们没有任何用处（不读像素、不做 AudioContext 分析）。
    -->
    <audio ref="audioEl" preload="metadata" class="hidden" />

    <!-- 错误条：紧贴播放条上方，不盖住控件 -->
    <div
      v-if="errorMessage"
      class="px-4 py-2 text-sm flex items-start gap-2"
      :class="errorKind === 'resolve'
        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
        : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'"
    >
      <UIcon name="i-heroicons-exclamation-triangle" class="w-4 h-4 mt-0.5 shrink-0" />
      <span class="flex-1">{{ errorMessage }}</span>
      <UButton
        icon="i-heroicons-x-mark"
        color="gray"
        variant="ghost"
        size="2xs"
        aria-label="关闭提示"
        @click="dismissError"
      />
    </div>

    <!-- 进度条：整条可点可拖，圆钮常显（触摸端没有 hover，藏起来等于没有抓手） -->
    <div
      ref="progressEl"
      class="group relative h-1.5 cursor-pointer touch-none"
      :class="duration ? 'bg-gray-200 dark:bg-gray-700' : 'bg-gray-100 dark:bg-gray-800'"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="absolute inset-y-0 left-0 bg-primary-500" :style="{ width: shownPercent + '%' }" />
      <div
        v-if="duration"
        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-primary-500 shadow"
        :style="{ left: shownPercent + '%' }"
      />
    </div>

    <div class="px-3 sm:px-4 py-2 flex items-center gap-3">
      <!-- 封面 + 标题 -->
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="w-10 h-10 sm:w-12 sm:h-12 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0 grid place-items-center">
          <img
            v-if="current?.cover"
            :src="current.cover"
            referrerpolicy="no-referrer"
            class="w-full h-full object-cover"
            alt=""
          >
          <UIcon v-else name="i-heroicons-musical-note" class="w-5 h-5 text-gray-400" />
        </div>
        <div class="min-w-0">
          <div class="truncate text-sm font-medium">
            {{ current?.name || '还没有在播放的曲目' }}
          </div>
          <div class="truncate text-xs text-gray-500">
            <template v-if="isResolving">{{ resolveStage || '正在获取播放地址…' }}</template>
            <template v-else-if="isBuffering">缓冲中…</template>
            <template v-else>{{ subtitle || '粘一条音频地址，或搜索一首歌' }}</template>
          </div>
        </div>
      </div>

      <!-- 传输控制 -->
      <div class="flex items-center gap-1 shrink-0">
        <UButton
          icon="i-heroicons-backward"
          color="gray"
          variant="ghost"
          size="sm"
          :disabled="!hasQueue"
          aria-label="上一首"
          @click="playPrev"
        />
        <UButton
          :icon="isResolving || isBuffering
            ? 'i-heroicons-arrow-path'
            : isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'"
          :class="(isResolving || isBuffering) && 'animate-spin'"
          color="primary"
          variant="solid"
          size="sm"
          :disabled="!current"
          :aria-label="isPlaying ? '暂停' : '播放'"
          @click="togglePlay"
        />
        <UButton
          icon="i-heroicons-forward"
          color="gray"
          variant="ghost"
          size="sm"
          :disabled="!hasQueue"
          aria-label="下一首"
          @click="playNext"
        />
      </div>

      <!-- 时间。窄屏只留当前时间，总时长挪走（不然和右侧按钮挤成一坨） -->
      <div class="text-xs tabular-nums text-gray-500 shrink-0">
        {{ formatTrackTime(shownTime) }}<span class="hidden sm:inline"> / {{ formatTrackTime(duration) }}</span>
      </div>

      <!-- 右侧：音量（窄屏不渲染，触摸端没有 hover，滑条展不开）+ 循环 + 队列 -->
      <div class="flex items-center gap-1 shrink-0">
        <div class="hidden sm:flex items-center gap-1">
          <UButton
            :icon="volumeIcon"
            color="gray"
            variant="ghost"
            size="sm"
            :aria-label="isMuted ? '取消静音' : '静音'"
            @click="toggleMuted"
          />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="isMuted ? 0 : volume"
            class="w-20 accent-primary-500"
            aria-label="音量"
            @input="setVolume(Number(($event.target as HTMLInputElement).value))"
          >
        </div>
        <UButton
          :icon="repeatIcon"
          :color="repeat === 'off' ? 'gray' : 'primary'"
          variant="ghost"
          size="sm"
          :title="repeatLabel"
          :aria-label="repeatLabel"
          @click="cycleRepeat"
        />
        <UButton
          icon="i-heroicons-arrows-right-left"
          :color="shuffle ? 'primary' : 'gray'"
          variant="ghost"
          size="sm"
          class="hidden sm:inline-flex"
          :title="shuffle ? '随机播放' : '顺序播放'"
          aria-label="随机播放"
          @click="shuffle = !shuffle"
        />
        <UButton
          icon="i-heroicons-queue-list"
          :color="showQueue ? 'primary' : 'gray'"
          variant="ghost"
          size="sm"
          :title="`播放队列（${queue.length}）`"
          aria-label="播放队列"
          @click="showQueue = !showQueue"
        >
          <span v-if="queue.length" class="text-xs tabular-nums">{{ queueIndex + 1 }}/{{ queue.length }}</span>
        </UButton>
      </div>
    </div>
  </div>
</template>
