<template>
  <div class="space-y-1">
    <div v-for="row in rows" :key="row.name" class="flex items-center gap-2 text-xs flex-wrap">
      <span class="w-8 shrink-0 text-gray-500 dark:text-gray-400">{{ row.name }}</span>
      <span
        v-for="cell in row.cells"
        :key="cell.channel"
        class="px-1.5 py-0.5 rounded font-mono"
        :class="{
          'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300': cell.reach === 'ok',
          'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300': cell.reach === 'fail',
          'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': cell.reach === 'unknown',
          'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500': cell.reach === 'skip',
        }"
        :title="cell.reach === 'unknown' ? '超时，未判定'
          : (cell.reach === 'skip' ? '未探测：已有更优通道可用' : '')"
      >
        {{ cell.reach === 'ok' ? '✓' : cell.reach === 'fail' ? '✗' : cell.reach === 'unknown' ? '?' : '–' }}
        {{ cell.label }}
        <span v-if="cell.ms" class="opacity-60">{{ cell.ms }}ms</span>
      </span>
    </div>
    <!-- 总耗时单独一行：上面各格的 ms 是并发跑出来的，加起来跟这个数没关系
         （实测分片轴 946 + 5637，整轮只花 5.6s），不摆出来就没法判断「到底等了多久」 -->
    <div v-if="totalMs" class="flex items-center gap-2 text-xs">
      <span class="w-8 shrink-0 text-gray-500 dark:text-gray-400">总计</span>
      <span
        class="px-1.5 py-0.5 rounded font-mono"
        :class="totalMs >= 6000 ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'
          : totalMs >= 3000 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'"
        title="整轮探测的墙钟耗时（各通道并发，非上面数字之和）"
      >{{ totalMs }}ms</span>
      <span class="text-gray-400">整轮墙钟耗时，起播前要等的就是它</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 可达性探测矩阵（两轴 × 四通道）的纯展示。播放器折叠区和解析页的「可达性检测」共用——
 * ✓/✗/?/– 四态各自的含义（尤其 skip 的「没测」不是「不通」）只该有一处说法。
 */
import type { ProbeMatrixRow } from '~/composables/videoPlayer/useReachabilityProbe'

defineProps<{
  rows: ProbeMatrixRow[]
  /** 整轮探测的墙钟耗时（ProbeResult.totalMs）。不传就不渲染那一行（老结论没有这个字段） */
  totalMs?: number
}>()
</script>
