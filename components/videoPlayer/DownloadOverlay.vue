<template>
  <Transition name="sheet">
    <div
      v-if="showDownloads"
      data-no-gesture
      class="absolute inset-0 z-20 flex flex-col bg-black/60 backdrop-blur-[2px] text-white"
      @click="onBlankClick"
    >
      <!-- 顶部一行：标题 + 环境说明 + 关闭 -->
      <div class="flex items-center gap-2 px-4 pt-3 pb-1.5 shrink-0">
        <span class="font-semibold">下载</span>
        <span class="text-[11px] text-white/50 truncate">
          {{ dlIsMp4 ? '整片 MP4：交给浏览器下载' : (dlStreaming ? '边下边写盘，输出 .ts' : '内存下载，单集上限 3GB') }}
        </span>
        <button
          class="ml-auto p-2 rounded-lg hover:bg-white/10 active:scale-90 transition-all shrink-0"
          title="关闭" @click="showDownloads = false"
        >
          <UIcon name="i-heroicons-x-mark" class="w-6 h-6" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
        <!-- ① 任务队列。抽屉关掉下载也照跑，所以这块是「回来看进度」的地方 -->
        <div v-if="dlTasks.length" class="space-y-1.5">
          <div class="flex items-center gap-2 px-1">
            <span class="text-xs text-white/60">任务（{{ dlPending }} 个进行中）</span>
            <button
              v-if="dlTasks.some(t => t.state !== 'queued' && t.state !== 'running')"
              class="ml-auto text-[11px] text-white/50 hover:text-white/80 transition-colors"
              @click="clearFinishedDownloads"
            >清理已完成</button>
          </div>
          <div
            v-for="t in dlTasks" :key="t.id"
            class="rounded-lg bg-white/[0.07] px-2.5 py-2"
          >
            <div class="flex items-center gap-2 text-xs">
              <UIcon :name="stateIcon(t.state)" class="w-4 h-4 shrink-0" :class="stateColor(t.state)" />
              <span class="truncate font-medium">{{ t.epName }}</span>
              <span class="ml-auto shrink-0 tabular-nums text-white/60">{{ stateText(t) }}</span>
              <button
                v-if="t.state === 'queued' || t.state === 'running'"
                class="shrink-0 p-1 rounded hover:bg-white/10 active:scale-90 transition-all"
                title="取消" @click="cancelDownload(t.id)"
              >
                <UIcon name="i-heroicons-x-mark" class="w-3.5 h-3.5" />
              </button>
            </div>
            <!-- 进度条只在跑起来之后给：`segTotal` 为 0 时画一条空槽会看着像卡住了 -->
            <div v-if="t.state === 'running' && t.segTotal > 0" class="mt-1.5 h-1 rounded-full bg-white/15 overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-[width] duration-500"
                :style="{ width: (t.segDone / t.segTotal * 100).toFixed(1) + '%' }"
              />
            </div>
            <div v-if="t.error" class="mt-1 text-[11px] text-rose-300 leading-snug">{{ t.error }}</div>
            <div v-else-if="t.state === 'done'" class="mt-1 text-[11px] text-white/45 truncate">
              {{ t.fileName }}
              <span v-if="t.skipped" class="text-amber-300/80">（有 {{ t.skipped }} 片取不回来，那几秒会跳过去）</span>
            </div>
            <div v-else-if="t.state === 'running' && holdNote" class="mt-1 text-[11px] text-amber-300/80">{{ holdNote }}</div>
            <div
              v-else-if="t.state === 'running' && !dlStreaming && t.bytes > WARN_BYTES"
              class="mt-1 text-[11px] text-amber-300/80"
            >已超过 1GB，这个浏览器只能先攒在内存里，手机上有可能失败</div>
          </div>
        </div>

        <!-- ② 整片 MP4：一集一颗，直接交给浏览器（a[download] 必须在点击的同步调用栈里） -->
        <template v-if="dlIsMp4">
          <div class="px-1 text-xs text-white/60">
            这个源是整片 MP4 —— 交给浏览器原生下载器，支持断点续传、关掉这一页也继续
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
            <a
              v-for="(item, index) in playlist" :key="index"
              :href="mp4DownloadHref(index)" download
              class="flex items-center gap-1.5 px-2 py-2 rounded-md text-xs bg-white/[0.07] hover:bg-white/15 transition-colors"
            >
              <UIcon name="i-heroicons-arrow-down-tray" class="w-3.5 h-3.5 shrink-0 text-white/60" />
              <span class="truncate">{{ getVideoName(item, index) }}</span>
            </a>
          </div>
        </template>

        <!-- ③ HLS：勾选集数 -->
        <template v-else>
          <div class="flex items-center gap-2 px-1">
            <span class="text-xs text-white/60">选集（已选 {{ picked.length }}）</span>
            <label class="ml-auto flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
              <!-- UCheckbox 在画面浮层里不能用（见 CLAUDE.md），自己画一个 -->
              <span
                class="w-3.5 h-3.5 rounded border transition-colors"
                :class="dlFullSpeed ? 'bg-rose-500 border-rose-500' : 'border-white/40'"
                @click="dlFullSpeed = !dlFullSpeed"
              />
              <span @click="dlFullSpeed = !dlFullSpeed">全速下载（会影响当前播放）</span>
            </label>
          </div>
          <div class="flex items-center gap-2 px-1 text-[11px]">
            <button class="text-white/60 hover:text-white transition-colors" @click="pickAll">全选</button>
            <button class="text-white/60 hover:text-white transition-colors" @click="picked = []">清空</button>
            <button class="text-white/60 hover:text-white transition-colors" @click="pickCurrent">只选当前集</button>
          </div>
          <div class="grid grid-cols-5 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-10 gap-1">
            <button
              v-for="(item, index) in playlist" :key="index"
              class="relative py-2.5 px-1 rounded-md text-sm transition-colors"
              :class="picked.includes(index)
                ? 'bg-rose-500/80 text-white font-semibold'
                : queuedSet.has(item)
                  ? 'text-emerald-300/70'
                  : 'text-white/75 hover:bg-white/10'"
              :title="getVideoName(item, index)"
              @click="toggle(index)"
            >
              <span class="block truncate">{{ getVideoName(item, index) }}</span>
              <!-- 已经在队列里/下好了：标一枚小勾，免得重复勾选（enqueue 那边也会去重） -->
              <UIcon
                v-if="queuedSet.has(item) && !picked.includes(index)"
                name="i-heroicons-check" class="absolute top-1 right-1 w-3 h-3"
              />
            </button>
          </div>
        </template>
      </div>

      <!-- 底部一行：说明 + 开始。说明必须写清楚，否则「下载功能坏了」是唯一的解读 -->
      <div v-if="!dlIsMp4" class="shrink-0 px-3 pt-2 pb-3 border-t border-white/10 flex items-center gap-3">
        <div class="text-[11px] text-white/45 leading-snug min-w-0">
          输出 <span class="text-white/70">.ts</span>（VLC / mpv / PotPlayer 直接能播）。
          <template v-if="!dlStreaming">
            这个浏览器不支持流式写盘（只有桌面版 Chrome/Edge 支持），整集先攒在内存里、单集上限 3GB，手机上大文件很可能失败。
          </template>
          下载会和播放抢带宽，缓冲吃紧时会自动让路。
        </div>
        <button
          class="ml-auto shrink-0 px-3.5 py-2 rounded-lg text-sm font-medium transition-all active:scale-95"
          :class="picked.length ? 'bg-rose-500 hover:bg-rose-400' : 'bg-white/10 text-white/40 cursor-not-allowed'"
          @click="start"
        >
          下载 {{ picked.length || '' }} 集
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 下载抽屉：任务队列 + 选集勾选。
 *
 * **做成底部抽屉而不是气泡菜单**：竖屏时播放器只有 200 多 px 高、容器还是 `overflow-hidden`，
 * 往上展开的浮层会被裁掉一半（同选集面板的理由）。
 *
 * 真正的下载在模块级队列里跑（`composables/videoPlayer/download/`），
 * 所以这块关掉、切集、离开这一页都不影响进度。
 */
import { BLOB_WARN_BYTES } from '~/composables/videoPlayer/download/fileSink'
import type { DlTask, DlState } from '~/composables/videoPlayer/download/downloadQueue'

const {
  showDownloads, playlist, currentIndex, getVideoName,
  dlIsMp4, dlTasks, dlPending, dlStreaming, dlFullSpeed,
  startDownload, mp4DownloadHref, cancelDownload, clearFinishedDownloads,
  isPlaying, strategy,
} = useVideoPlayerCtx()

const WARN_BYTES = BLOB_WARN_BYTES

const picked = ref<number[]>([])

/** 已经排进队列（或下好）的那几集：勾选面板上要看得见，否则只能靠 enqueue 去重悄悄拦掉 */
const queuedSet = computed(() => new Set(
  dlTasks.filter(t => t.state === 'queued' || t.state === 'running' || t.state === 'done')
    .map(t => t.placeholder),
))

/** 正在让路时说一句：不说的话「进度条不动」只会被当成卡死 */
const holdNote = computed(() =>
  !dlFullSpeed.value && isPlaying.value && strategy.value.healthZone === 'panic'
    ? '画面正在缓冲，已暂缓下载' : '')

/**
 * 点空白即关。判据是「这一下有没有落在可交互的东西上」而不是 `@click.self`——
 * 后者只认根元素，标题栏、滚动容器、格子之间的缝隙全都不算，结果只有边缘一圈能关（同选集面板）。
 */
const onBlankClick = (e: MouseEvent) => {
  const el = e.target as HTMLElement | null
  if (el?.closest?.('button, a, label, input')) return
  showDownloads.value = false
}

const toggle = (i: number) => {
  const at = picked.value.indexOf(i)
  if (at >= 0) picked.value.splice(at, 1)
  else picked.value.push(i)
}
const pickAll = () => { picked.value = playlist.value.map((_, i) => i) }
const pickCurrent = () => { picked.value = [currentIndex.value] }

const start = () => {
  if (!picked.value.length) return
  const list = [...picked.value].sort((a, b) => a - b)
  picked.value = []
  // 不 await：目录授权弹窗在 startDownload 内部**同步**弹出（await 之后再弹会被浏览器拦），
  // 这里再等它反而什么也做不了
  void startDownload(list)
}

/** 打开抽屉时默认勾上当前集：最常见的意图就是「下我正在看的这一集」 */
watch(showDownloads, open => {
  if (open && !picked.value.length && !dlIsMp4.value) picked.value = [currentIndex.value]
})

const stateIcon = (s: DlState) => ({
  queued: 'i-heroicons-clock',
  running: 'i-heroicons-arrow-down-tray',
  done: 'i-heroicons-check-circle',
  failed: 'i-heroicons-exclamation-triangle',
  canceled: 'i-heroicons-x-circle',
}[s])

const stateColor = (s: DlState) => ({
  queued: 'text-white/40',
  running: 'text-violet-300 animate-pulse',
  done: 'text-emerald-400',
  failed: 'text-rose-400',
  canceled: 'text-white/30',
}[s])

const stateText = (t: DlTask) => {
  if (t.state === 'queued') return '排队中'
  if (t.state === 'canceled') return '已取消'
  if (t.state === 'failed') return '失败'
  if (t.state === 'done') return formatBytes(t.bytes)
  if (!t.segTotal) return '正在取地址…'
  return `${t.segDone}/${t.segTotal} 片 · ${formatBytes(t.bytes)} · ${formatSpeed(t.kbps)}`
}
</script>

<style scoped>
/* 从下往上铺开，同选集面板 */
.sheet-enter-active { transition: opacity .2s ease, transform .3s cubic-bezier(.2, 1.1, .4, 1); }
.sheet-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.sheet-enter-from,
.sheet-leave-to { opacity: 0; transform: translateY(16px); }
</style>
