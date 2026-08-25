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
  queue, queueIndex, repeat, shuffle, seekPreview, isSeeking,
  showQueue, showDownloads, showFavorites, showLyrics,
  togglePlay, seekTo, setVolume, toggleMuted, playNext, playPrev, cycleRepeat, dismissError,
  downloadTrack,
} = useMusicPlayerCtx()

// 收藏是页面级能力，不经播放器上下文。它内部是模块级单例，
// 所以这里和页面各调一次拿到的是同一份状态（否则点了心、面板不更新）
const { isFavorite, toggleFavorite } = useMusicFavorites()

const curFavorited = computed(() => !!current.value && isFavorite(current.value.key))

/*
 * 歌词由播放条**统一驱动一处**：它常驻，而歌词面板收起来时组件根本不存在
 * （`v-if="showLyrics"`），驱动放在面板里的话，面板一收播放条那行滚动歌词就再也不更新了。
 * 状态是模块级单例，面板拿到的是同一份，所以那边只读不取。
 *
 * 只认 `key` 变化——同一首回填元数据（音质、体积）时不该重查一遍。
 */
const { fetchFor: fetchLyrics } = useMusicLyrics()
watch(() => current.value?.key, () => {
  if (current.value) void fetchLyrics(current.value)
}, { immediate: true })

/**
 * 取址结束后，如果这一首**自己带了歌词**，再取一次让它顶掉在线查询的结果。
 *
 * ## 为什么少了这一下就会显示错的歌词
 *
 * `useMusicEngine.load()` 是先 `current.value = track`、**再**去取址的，而有的音乐源
 * （fangpi）的歌词是取址那一趟顺带带回来的。所以上面那个 watch 跑的时候 `track.lrc`
 * 还是空的 → `fetchFor` 落到第 ④ 步在线查询 → 拿回**另一首同名歌**的歌词就存下来了。
 * 实测搜「枫」播周杰伦那首，界面上显示的是夏蔓蔓那首的词，还标着「这份歌词没有时间轴」。
 * 而真歌词到位时 `key` 没变，上面那个 watch 不会再跑，那份错的就一直用下去（还进了缓存）。
 *
 * **判据用 `isResolving` 的下降沿，不用 `current.lrc`**：引擎回填元数据走的是
 * `Object.assign(track, …)`，改的是那个对象本身，watch 一个 `current.value?.lrc`
 * 的 getter **不一定会被触发**（播放条本来就因为 `currentTime` 每秒重渲染好几次，
 * 所以画面上看着是新值，但依赖没被收集）。`isResolving` 是引擎自己的 ref，一定可靠。
 *
 * 再加上 `current.lrc` 非空这个条件，就只有真带歌词的源会多跑这一次
 * （24bit 两个源的 `lrc` 恒空，一次都不会多跑），而多跑的这次是纯本地的
 * ——第 ② 步当场命中，不发请求，还顺带用 `seq` 把在线那轮作废掉
 * （它在写缓存**之前**判 seq，所以错的那份连缓存都进不去）。
 */
watch(isResolving, (now, was) => {
  if (was && !now && current.value?.lrc) void fetchLyrics(current.value)
})

/** 收藏/下载当前这首。直链播放的曲目没有 resolver，收藏了下次也取不回来，所以不给收藏 */
const canCollect = computed(() => !!current.value?.resolver)

const onToggleFav = () => { if (current.value) toggleFavorite(current.value) }
const onDownloadCurrent = () => {
  if (!current.value) return
  downloadTrack(current.value)
  showDownloads.value = true
}

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

// 副标题只放歌手和专辑；音质/格式/体积走下面的彩色标签
// （混在一行文字里全是「·」，扫一眼分不出哪个是音质哪个是体积）
const subtitle = computed(() => {
  const t = current.value
  if (!t) return ''
  return [t.artist, t.album].filter(Boolean).join(' · ')
})

/**
 * 音质 / 格式 / 体积三枚标签。**只有取址成功后才有值**——
 * 这三项都来自详情页，搜索结果里压根没有，所以起播前是空的，别给占位符。
 */
const tags = computed(() => {
  const t = current.value
  if (!t) return [] as { text: string; color: string }[]
  const out: { text: string; color: string }[] = []
  if (t.quality) out.push({ text: t.quality, color: 'primary' })
  if (t.format) out.push({ text: t.format.toUpperCase(), color: 'amber' })
  if (t.sizeText) out.push({ text: t.sizeText, color: 'gray' })
  return out
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
        <!-- 封面走公共组件：这些图床（如 img1.kuwo.cn）浏览器直连会超时，要能自动退到 /api/thumb -->
        <MusicCoverArt
          :src="current?.cover"
          :alt="current?.name"
          size-class="w-10 h-10 sm:w-12 sm:h-12"
        />
        <div class="min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class="truncate text-sm font-medium">
              {{ current?.name || '还没有在播放的曲目' }}
            </span>
            <!-- 音质/格式/体积。窄屏藏起来：那块地方要留给歌名，标签挤进去只会两边都看不清 -->
            <span class="hidden md:flex items-center gap-1 shrink-0">
              <UBadge
                v-for="t in tags"
                :key="t.text"
                :color="t.color"
                variant="soft"
                size="xs"
              >
                {{ t.text }}
              </UBadge>
            </span>
          </div>
          <div class="truncate text-xs text-gray-500">
            <template v-if="isResolving">{{ resolveStage || '正在获取播放地址…' }}</template>
            <template v-else-if="isBuffering">缓冲中…</template>
            <template v-else>{{ subtitle || '粘一条音频地址，或搜索一首歌' }}</template>
          </div>
        </div>
      </div>

      <!--
        中间：跟着进度滚的歌词（网易云那种）。**窄屏整块不渲染**——那点宽度要留给歌名和按钮，
        挤进来只会三样都看不清；手机上要看词点右边那枚歌词按钮展开面板。
      -->
      <div class="hidden lg:flex flex-1 min-w-0 justify-center">
        <MusicNowLyric class="w-full max-w-md" />
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
        <!-- 收藏/下载只对解析来的曲目有意义：直链是终态，收藏了也没有 resolver 能取回来 -->
        <UButton
          v-if="canCollect"
          :icon="curFavorited ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'"
          :color="curFavorited ? 'primary' : 'gray'"
          variant="ghost"
          size="sm"
          :title="curFavorited ? '取消收藏' : '收藏'"
          :aria-label="curFavorited ? '取消收藏' : '收藏'"
          @click="onToggleFav"
        />
        <UButton
          v-if="canCollect"
          icon="i-heroicons-arrow-down-tray"
          color="gray"
          variant="ghost"
          size="sm"
          class="hidden sm:inline-flex"
          title="下载这首"
          aria-label="下载这首"
          @click="onDownloadCurrent"
        />
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
          icon="i-heroicons-document-text"
          :color="showLyrics ? 'primary' : 'gray'"
          variant="ghost"
          size="sm"
          title="歌词"
          aria-label="歌词"
          @click="showLyrics = !showLyrics"
        />
        <!-- 收藏栏的开关。**窄屏也要有**：那边收藏栏是滑出去的抽屉，这是它唯一的入口，
             跟着「窄屏减项」一起藏掉就等于手机上再也打不开收藏 -->
        <UButton
          icon="i-heroicons-bars-3-bottom-left"
          :color="showFavorites ? 'primary' : 'gray'"
          variant="ghost"
          size="sm"
          :title="showFavorites ? '收起我的收藏' : '我的收藏'"
          aria-label="我的收藏"
          @click="showFavorites = !showFavorites"
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
