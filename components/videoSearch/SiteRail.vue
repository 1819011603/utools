<template>
  <!--
    站点改成一行横排按钮，不再是竖排/可折叠的侧栏：站数不多（个位数），
    横排一屏就摆得下，也不用再维护展开/收起那套状态和 hover 联动
  -->
  <div class="flex flex-wrap gap-2">
    <button
      v-for="(s, i) in states"
      :key="s.siteId"
      type="button"
      :aria-pressed="s.siteId === modelValue"
      class="wf-fade-up group relative flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm
             cursor-pointer select-none transition-all duration-300 hover:-translate-y-px
             active:translate-y-0 active:scale-[0.985]
             focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      :class="s.siteId === modelValue
        ? 'bg-gradient-to-r from-rose-500/[0.14] via-pink-500/[0.09] to-violet-500/[0.07] text-rose-600 dark:text-rose-300 font-medium ring-1 ring-inset ring-rose-300/70 dark:ring-rose-400/25 shadow-sm shadow-rose-100/70 dark:shadow-none'
        : 'bg-white/60 dark:bg-white/[0.03] text-gray-600 dark:text-gray-300 ring-1 ring-inset ring-gray-200/70 dark:ring-white/[0.07] hover:bg-white hover:text-rose-600 dark:hover:text-rose-300 hover:ring-rose-200 dark:hover:bg-white/[0.07] dark:hover:ring-rose-400/20 hover:shadow-sm'"
      :style="{ animationDelay: i * 40 + 'ms' }"
      @click="$emit('update:modelValue', s.siteId)"
    >
      <span>{{ s.name }}</span>

      <!-- 状态角标：搜索中/出错/只能去源站 三种各有形，剩下的一律显示条数 -->
      <UIcon v-if="s.status === 'searching'" name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin text-rose-400" />
      <UIcon v-else-if="s.status === 'error'" name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0 text-red-500" />
      <UIcon v-else-if="s.status === 'blocked' || s.status === 'manual'" name="i-heroicons-shield-exclamation" class="w-3.5 h-3.5 shrink-0 text-amber-500" />
      <span
        v-else-if="s.items.length"
        class="shrink-0 min-w-[1.375rem] px-1.5 py-0.5 rounded-md text-[11px] font-semibold tabular-nums text-center transition-colors"
        :class="s.siteId === modelValue
          ? 'bg-rose-500 text-white shadow-sm shadow-rose-300/50'
          : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-300 group-hover:bg-rose-100 group-hover:text-rose-600 dark:group-hover:bg-rose-400/15 dark:group-hover:text-rose-300'"
      >{{ s.items.length }}</span>
      <span
        v-else-if="s.status === 'done'"
        class="shrink-0 min-w-[1.375rem] px-1.5 py-0.5 rounded-md text-[11px] text-center text-gray-400 dark:text-gray-500 bg-gray-100/70 dark:bg-white/5"
      >0</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { SiteSearchState } from '~/composables/useVideoSearch'

defineProps<{ states: SiteSearchState[]; modelValue: string }>()
defineEmits<{ 'update:modelValue': [string] }>()
</script>
