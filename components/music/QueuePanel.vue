<script setup lang="ts">
/**
 * 播放队列。
 *
 * 不接收 props，自己从 ctx 解构（同 videoPlayer 那套约定）。
 *
 * 队列里存的是**剥掉 url 的占位**（见 types.ts 的 toStorableTrack）——
 * 地址约 20 分钟就过期，所以这里显示的曲目多半没有 `url`，点了才现取。
 * 因此**不能按「有没有 url」判断能不能点**，那会把整份队列锁死。
 */
import { formatTrackTime } from '~/composables/musicPlayer/display'

const { queue, queueIndex, current, isPlaying, showQueue, playAt, removeAt, clearQueue } = useMusicPlayerCtx()

const listEl = ref<HTMLElement>()

/**
 * 切歌时把当前这首滚进视野。用 `nearest` 而不是 `center`——
 * 已经在视野里就别动，否则每次切歌整块跳一下（同 PlaylistPanel 那条教训）。
 */
watch(queueIndex, async () => {
  await nextTick()
  listEl.value?.querySelector('[data-current="1"]')?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-queue-list" class="w-5 h-5 text-primary-500" />
          <span class="font-medium">播放队列</span>
          <UBadge v-if="queue.length" color="gray" variant="soft" size="xs">
            {{ queueIndex + 1 }} / {{ queue.length }}
          </UBadge>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            v-if="queue.length"
            size="2xs"
            color="gray"
            variant="ghost"
            @click="clearQueue"
          >
            清空
          </UButton>
          <UButton
            icon="i-heroicons-x-mark"
            size="2xs"
            color="gray"
            variant="ghost"
            aria-label="关闭"
            @click="showQueue = false"
          />
        </div>
      </div>
    </template>

    <div v-if="!queue.length" class="py-8 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300" />
      <p>队列是空的</p>
      <p class="text-xs mt-1">搜一首歌，点音质档就会把整份结果排进来</p>
    </div>

    <!-- max-h + 滚动：一次搜索就排进 30 首，铺开会把播放条挤出屏幕 -->
    <div v-else ref="listEl" class="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800 -my-2">
      <div
        v-for="(t, i) in queue"
        :key="t.key + i"
        :data-current="i === queueIndex ? '1' : undefined"
        class="flex items-center gap-2 py-2"
        :class="i === queueIndex && 'text-primary-600 dark:text-primary-400'"
      >
        <UButton
          :icon="i === queueIndex && isPlaying ? 'i-heroicons-speaker-wave' : 'i-heroicons-play'"
          color="gray"
          variant="ghost"
          size="2xs"
          :aria-label="`播放 ${t.name}`"
          @click="playAt(i)"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{{ t.name }}</div>
          <div class="truncate text-xs text-gray-500">
            {{ [t.artist, t.album].filter(Boolean).join(' · ') }}
          </div>
        </div>
        <span v-if="t.duration" class="text-xs tabular-nums text-gray-400 shrink-0">
          {{ formatTrackTime(t.duration) }}
        </span>
        <UButton
          icon="i-heroicons-x-mark"
          color="gray"
          variant="ghost"
          size="2xs"
          aria-label="从队列移除"
          @click="removeAt(i)"
        />
      </div>
    </div>
  </UCard>
</template>
