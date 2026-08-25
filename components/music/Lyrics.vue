<script setup lang="ts">
/**
 * 歌词面板。播放条和将来的全屏播放页共用这一个。
 *
 * 数据来自取址时顺带拿到的 `Track.lrc`，**经常是空的**（实测酷我那个源给的是空占位），
 * 所以三种状态都要画：有时间轴（跟唱高亮）、只有文本（整块显示）、没有（说明原因）。
 * 不做成「没有就整个不渲染」是因为用户会以为功能坏了 —— 说清是这个音源没提供更好。
 */
import { activeLrcIndex, parseLrc } from '~/composables/musicPlayer/lrc'

const { current, currentTime, seekTo } = useMusicPlayerCtx()

const parsed = computed(() => parseLrc(current.value?.lrc))
const hasLyrics = computed(() => parsed.value.lines.length > 0)

/** 当前该高亮哪一行。没有时间轴时恒为 -1（整块显示，不高亮） */
const activeIndex = computed(() =>
  parsed.value.synced ? activeLrcIndex(parsed.value.lines, currentTime.value) : -1,
)

const listEl = ref<HTMLElement>()

/**
 * 高亮行滚进视野。用 `block: 'center'` 而不是 `nearest` —— 歌词跟唱的惯例是
 * 当前句居中，两边各露几句上下文；`nearest` 会让它贴在容器边缘，看不到下一句要唱什么。
 * （这和选集面板的取舍相反，那边是"已经在视野里就别动"。）
 */
watch(activeIndex, async (i) => {
  if (i < 0) return
  await nextTick()
  listEl.value?.querySelector(`[data-lrc="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-heroicons-musical-note" class="w-5 h-5 text-primary-500" />
        <span class="font-medium">歌词</span>
        <UBadge v-if="parsed.synced" color="primary" variant="soft" size="xs">跟唱</UBadge>
      </div>
    </template>

    <div v-if="!current" class="py-8 text-center text-sm text-gray-500">
      还没有在播放的曲目
    </div>

    <div v-else-if="!hasLyrics" class="py-8 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-document-text" class="w-8 h-8 mb-2 text-gray-300" />
      <p>这个音源没有提供歌词</p>
      <p class="text-xs mt-1">换另一个音质档试试，两个源的附带数据不一样</p>
    </div>

    <div v-else ref="listEl" class="max-h-72 overflow-y-auto space-y-1 py-2">
      <p
        v-for="(l, i) in parsed.lines"
        :key="i"
        :data-lrc="i"
        class="text-sm leading-relaxed transition-colors px-2 py-0.5 rounded"
        :class="[
          parsed.synced && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60',
          i === activeIndex
            ? 'text-primary-600 dark:text-primary-400 font-medium'
            : 'text-gray-500 dark:text-gray-400',
        ]"
        @click="parsed.synced && l.time >= 0 && seekTo(l.time)"
      >
        {{ l.text }}
      </p>
    </div>
  </UCard>
</template>
