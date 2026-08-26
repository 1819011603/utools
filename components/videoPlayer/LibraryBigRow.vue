<template>
  <div
    class="group flex items-center gap-3 p-2 rounded-xl transition-colors cursor-pointer"
    :class="[
      current ? 'bg-rose-500/10 ring-1 ring-rose-400/30' : 'bg-gray-50 dark:bg-gray-800/60 hover:bg-gray-100 dark:hover:bg-gray-800',
      playable || managing ? '' : 'cursor-default',
    ]"
    @click="$emit('open')"
  >
    <PosterImg
      :src="cover"
      :alt="title"
      class="shrink-0 w-16 h-[5.5rem] sm:w-[4.5rem] sm:h-24 rounded-lg ring-1 ring-black/5 dark:ring-white/10"
    />

    <div class="min-w-0 flex-1">
      <p class="font-medium truncate" :class="current ? 'text-rose-600 dark:text-rose-300' : 'text-gray-900 dark:text-white'">
        {{ title }}
      </p>
      <p class="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{{ sub }}</p>

      <!-- 分类 + 进度条一行。百分比压在右端，跟进度条同一行读起来才是一件事 -->
      <div class="flex items-center gap-2 mt-2">
        <span v-if="cat" class="shrink-0 text-[11px] text-gray-400">{{ cat }}</span>
        <div class="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div class="h-full rounded-full bg-emerald-500 transition-[width] duration-300" :style="{ width: percent + '%' }" />
        </div>
        <span class="shrink-0 text-[11px] tabular-nums text-gray-400 w-8 text-right">{{ percent }}%</span>
      </div>
    </div>

    <!--
      管理模式下右侧是选择圈，非管理模式是删除键。两者**占同一个位置**：
      切来切去时行宽不变，列表不会整体抖一下
    -->
    <div class="shrink-0 w-8 flex items-center justify-center" @click.stop>
      <button
        v-if="managing"
        type="button"
        class="w-6 h-6 rounded-full flex items-center justify-center transition-colors"
        :class="selected
          ? 'bg-emerald-500 text-white'
          : 'ring-1 ring-gray-300 dark:ring-gray-600 text-transparent hover:ring-emerald-400'"
        :title="selected ? '取消选择' : '选择'"
        @click="$emit('toggle')"
      >
        <UIcon name="i-heroicons-check" class="w-4 h-4" />
      </button>
      <button
        v-else
        type="button"
        class="p-1.5 rounded-lg text-gray-400 opacity-60 sm:opacity-0 group-hover:opacity-100
               hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-rose-500 transition-all"
        title="删除这条"
        @click="$emit('remove')"
      >
        <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 「查看更多」面板里的一行：大封面 + 标题 + 副行 + 分类 + 进度条 + 选择/删除。
 *
 * 与抽屉里那行（`LibraryRow`）**故意不复用**：那边一行只有 60px 高、要塞进 340px 宽的抽屉，
 * 这边是整屏的浏览器，进度条、分类、多选圈都是这边独有的。硬合成一个组件的结果
 * 是十来个 props 互相排斥（`compact` 开着时这三个别传…），比两份模板更难改。
 */
defineProps<{
  title: string
  cover?: string
  cat?: string
  sub?: string
  percent: number
  current?: boolean
  playable?: boolean
  managing?: boolean
  selected?: boolean
}>()

defineEmits<{ (e: 'open'): void; (e: 'toggle'): void; (e: 'remove'): void }>()
</script>
