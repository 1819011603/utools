<script setup lang="ts">
/**
 * 下载队列面板。
 *
 * **不接收 props**，自己从 ctx 解构（同 PlayerBar / videoPlayer 那套约定）。
 * 依赖 `useMusicPlayerCtx()` 提供这些键（由 useMusicDownload 平铺进 controller）：
 *   · `showDownloads`   — 面板开关（已在 useMusicMediaState 里）
 *   · `downloads`       — MusicDownloadItem[]，界面直接渲染这一份
 *   · `cancelDownload`  — (key: string) => void，取消单条
 *   · `cancelAll`       — () => void，全部中断（已完成的保留）
 *   · `clearFinished`   — () => void，清掉 done/error/canceled 那几行
 *   · `hasActiveDownloads` / `finishedCount` — 只是为了让顶部两颗按钮该灰就灰，
 *     **不接线也不会崩**（下面用可选链兜了一道），因为它们是纯派生值
 *
 * 做成浮层而不是页面里的一块：下载是「挂后台跑」的动作，用户开着它去搜下一首是常态，
 * 占住页面主区等于逼他在「看列表」和「看进度」之间二选一。
 */
import { formatBytes } from '~/composables/musicPlayer/display'
import type { MusicDownloadItem, MusicDownloadStatus } from '~/composables/musicPlayer/useMusicDownload'

const ctx = useMusicPlayerCtx() as any
const {
  downloads, cancelDownload, cancelAll, clearFinished, showDownloads,
} = ctx

const items = computed<MusicDownloadItem[]>(() => downloads?.value ?? [])

const activeCount = computed(() => items.value.filter(d => isRunning(d.status)).length)
const doneCount = computed(() => items.value.filter(d => d.status === 'done').length)
const finishedCount = computed(() => items.value.filter(d => !isRunning(d.status)).length)

function isRunning(s: MusicDownloadStatus) {
  return s === 'queued' || s === 'resolving' || s === 'downloading'
}

/** 状态文案。取消和失败必须分开写——把用户自己按的取消画成故障，只会让人以为出了 bug */
const statusText = (d: MusicDownloadItem) => {
  switch (d.status) {
    case 'queued': return '排队中'
    case 'resolving': return '正在获取地址…'
    case 'downloading': return d.totalBytes ? `${d.percent}%` : '下载中…'
    case 'done': return '已保存'
    case 'canceled': return '已取消'
    case 'error': return d.error || '下载失败'
  }
}

const statusClass = (d: MusicDownloadItem) => {
  if (d.status === 'error') return 'text-rose-600 dark:text-rose-400'
  if (d.status === 'done') return 'text-emerald-600 dark:text-emerald-400'
  if (d.status === 'canceled') return 'text-gray-400 dark:text-gray-500'
  return 'text-gray-500 dark:text-gray-400'
}

/**
 * 体积那一行。**总长未知时也要把已收到的字节写出来**：
 * 无损单曲能到 115MB，光有一条不确定的进度条，用户没法判断是在跑还是卡死了。
 */
const sizeText = (d: MusicDownloadItem) => {
  if (d.status === 'done') return formatBytes(d.totalBytes || d.receivedBytes)
  if (!isRunning(d.status)) return d.receivedBytes ? formatBytes(d.receivedBytes) : ''
  if (d.totalBytes) return `${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)}`
  return formatBytes(d.receivedBytes)
}

/** 传给 UProgress 的值。总长未知时给 undefined → 画成不确定态，别拿 0 冒充「刚开始」 */
const progressValue = (d: MusicDownloadItem) => {
  if (d.status === 'done') return 100
  if (d.status === 'downloading' && !d.totalBytes) return undefined
  return d.percent
}

const subtitle = (d: MusicDownloadItem) =>
  [d.artist, d.format?.toUpperCase()].filter(Boolean).join(' · ')
</script>

<template>
  <!--
    贴在底部播放条上方：播放条是 fixed 的，面板浮在它之上而不是盖住它——
    下载的时候多半还在听歌，把传输控制挡掉等于用一个功能挡了另一个。
  -->
  <div
    v-if="showDownloads"
    class="fixed z-40 bottom-24 sm:bottom-28 inset-x-2 sm:inset-x-auto sm:right-4 sm:w-[26rem]"
  >
    <UCard
      :ui="{
        body: { padding: 'p-0' },
        header: { padding: 'px-4 py-2.5' },
        ring: 'ring-1 ring-gray-200 dark:ring-gray-800',
        shadow: 'shadow-xl',
      }"
    >
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 text-primary-500 shrink-0" />
          <div class="text-sm font-medium">下载队列</div>
          <!-- 计数写在标题上：面板收起时用户唯一想知道的就是「还剩几首」 -->
          <span v-if="items.length" class="text-xs text-gray-500 tabular-nums">
            {{ activeCount ? `${activeCount} 首进行中` : `${doneCount} 首已完成` }}
          </span>

          <div class="ml-auto flex items-center gap-1">
            <UButton
              icon="i-heroicons-stop-circle"
              color="gray"
              variant="ghost"
              size="2xs"
              :disabled="!activeCount"
              title="中断所有还没下完的（已完成的保留）"
              @click="cancelAll?.()"
            >
              全部中断
            </UButton>
            <UButton
              icon="i-heroicons-trash"
              color="gray"
              variant="ghost"
              size="2xs"
              :disabled="!finishedCount"
              title="清掉已完成、已取消和失败的那几行"
              @click="clearFinished?.()"
            >
              清除已完成
            </UButton>
            <UButton
              icon="i-heroicons-x-mark"
              color="gray"
              variant="ghost"
              size="2xs"
              title="关闭"
              aria-label="关闭下载面板"
              @click="showDownloads = false"
            />
          </div>
        </div>
      </template>

      <!-- 空态也要有一句话：一块什么都没有的白板，用户会以为面板坏了 -->
      <div v-if="!items.length" class="px-4 py-8 text-center text-sm text-gray-500">
        还没有下载任务。在列表或播放条上点下载按钮试试。
      </div>

      <!-- max-h + 滚动：批量下整张专辑时这里能有几十行，撑高会把播放条顶出屏幕 -->
      <div v-else class="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
        <div
          v-for="d in items"
          :key="d.key"
          class="px-4 py-2.5 flex items-center gap-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate text-sm" :class="d.status === 'canceled' && 'text-gray-400 line-through'">
                {{ d.name }}
              </span>
              <span v-if="subtitle(d)" class="truncate text-xs text-gray-400 shrink-0">{{ subtitle(d) }}</span>
            </div>

            <UProgress
              class="mt-1.5"
              size="xs"
              :color="d.status === 'error' ? 'red' : d.status === 'done' ? 'green' : 'primary'"
              :value="progressValue(d)"
              :max="100"
            />

            <div class="mt-1 flex items-center gap-2 text-xs">
              <span :class="statusClass(d)" class="truncate">{{ statusText(d) }}</span>
              <span v-if="sizeText(d)" class="ml-auto tabular-nums text-gray-400 shrink-0">
                {{ sizeText(d) }}
              </span>
            </div>
          </div>

          <!--
            收工的行不给取消键，但**位置要留着**（w-6 占位），
            否则每下完一首整列按钮就横向抖一下。
          -->
          <div class="w-6 shrink-0 grid place-items-center">
            <UButton
              v-if="isRunning(d.status)"
              icon="i-heroicons-x-circle"
              color="gray"
              variant="ghost"
              size="2xs"
              :aria-label="`取消下载 ${d.name}`"
              title="取消这一首"
              @click="cancelDownload?.(d.key)"
            />
            <UIcon
              v-else-if="d.status === 'done'"
              name="i-heroicons-check-circle"
              class="w-4 h-4 text-emerald-500"
            />
            <UIcon
              v-else-if="d.status === 'error'"
              name="i-heroicons-exclamation-circle"
              class="w-4 h-4 text-rose-500"
            />
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>
