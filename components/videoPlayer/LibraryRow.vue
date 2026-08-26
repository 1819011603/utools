<template>
  <div
    class="group relative flex items-center gap-2.5 p-1.5 rounded-xl transition-colors"
    :class="current
      ? 'bg-rose-500/10 ring-1 ring-rose-400/30'
      : 'hover:bg-gray-100 dark:hover:bg-gray-800'"
  >
    <!--
      整行是一颗按钮（不是只让封面可点）：条目本身窄，命中区域越大越好，
      触摸端尤其明显。不可播（没有来源页的老记录）就不做成按钮，免得点了没反应
    -->
    <component
      :is="playable ? 'button' : 'div'"
      :type="playable ? 'button' : undefined"
      class="flex items-center gap-2.5 min-w-0 flex-1 text-left"
      :class="playable ? 'cursor-pointer' : 'cursor-default'"
      @click="playable && $emit('open')"
    >
      <div class="relative shrink-0">
        <PosterImg :src="cover" :alt="title" class="w-11 h-[3.75rem] rounded-lg ring-1 ring-black/5 dark:ring-white/10" />
        <!-- 看到哪了：细细一条压在封面底边。数字在右边那行已经有了，这里只要一眼的量感 -->
        <div v-if="percent > 0" class="absolute inset-x-0 bottom-0 h-1 bg-black/40 rounded-b-lg overflow-hidden">
          <div class="h-full bg-rose-500" :style="{ width: percent + '%' }" />
        </div>
      </div>

      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate" :class="current ? 'text-rose-600 dark:text-rose-300' : 'text-gray-900 dark:text-white'">
          {{ title }}
        </p>
        <p class="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{{ sub }}</p>
      </div>
    </component>

    <!--
      删除键**不能只在 hover 时出现**：触摸端没有 hover，那样等于删不掉。
      桌面上淡着、hover 才实，够用又不抢眼
    -->
    <button
      type="button"
      class="shrink-0 p-1.5 rounded-lg text-gray-400 opacity-60 sm:opacity-0 group-hover:opacity-100
             hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-rose-500 transition-all"
      title="从列表移除"
      @click.stop="$emit('remove')"
    >
      <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 「播放历史 / 收藏影片」里的一行：封面 + 标题 + 副行 + 进度条 + 删除。
 *
 * 两份清单长得一样，只是副行内容不同，所以做成一个纯展示组件由 LibraryPanel 喂数据
 * （它同时也是**唯一**知道「点一条该跳到哪」的地方——那件事要读播放器上下文）。
 */
defineProps<{
  title: string
  cover?: string
  /** 副行：「第10集 · 12:34 · 41%」这类 */
  sub?: string
  /** 看到百分之几（0 = 不画那条进度） */
  percent?: number
  /** 是不是正在播的这部剧 */
  current?: boolean
  /** 有来源页才点得动（手工贴地址播的老记录没有） */
  playable?: boolean
}>()

defineEmits<{ (e: 'open'): void; (e: 'remove'): void }>()
</script>
