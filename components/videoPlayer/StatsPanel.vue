<template>
  <div class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
    <!-- 服务器档位 + 缓冲健康区 + 真实卡顿 -->
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <UBadge :color="tierBadgeColor" variant="subtle" size="xs">
        服务器：{{ tierLabel }}{{ tierIsAuto ? '（自动）' : '（锁定）' }}
      </UBadge>
      <UBadge
        :color="strategy.healthZone === 'panic' ? 'red' : strategy.healthZone === 'low' ? 'amber' : 'green'"
        variant="subtle" size="xs"
      >
        {{ strategy.healthZone === 'panic' ? '濒卡' : strategy.healthZone === 'low' ? '吃紧' : '健康' }}
      </UBadge>
      <UBadge v-if="guardRateCeiling < 99" color="amber" variant="subtle" size="xs">抗卡降速中</UBadge>
      <UBadge :color="stall.stallCount.value > 0 ? 'red' : 'green'" variant="subtle" size="xs">
        卡顿 {{ stall.stallCount.value }} 次 / {{ (stall.stallMsTotal.value / 1000).toFixed(1) }}s
      </UBadge>
      <UBadge color="gray" variant="subtle" size="xs">连续流畅 {{ stall.getSmoothSecs().toFixed(0) }}s</UBadge>
      <UBadge :color="strategy.aggregateScales ? 'green' : 'red'" variant="subtle" size="xs">
        {{ strategy.aggregateScales ? '可并行' : '带宽硬顶' }}
      </UBadge>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
      <div><span class="text-gray-500">已缓冲：</span><span class="font-medium">{{ (hlsStats?.buffered ?? 0).toFixed(1) }} 秒</span></div>
      <div><span class="text-gray-500">当前画质：</span><span class="font-medium">{{ hlsStats?.level }}</span></div>
      <div><span class="text-gray-500">缓冲进度：</span><span class="font-medium">{{ bufferedPercent.toFixed(1) }}%</span></div>
      <div><span class="text-gray-500">播放进度：</span><span class="font-medium">{{ progressPercent.toFixed(1) }}%</span></div>
    </div>

    <!-- 自适应预取状态 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
      <div>
        <span class="text-gray-500">预取线程：</span>
        <span
          class="font-medium"
          :class="prefetchInfo.threads >= 5 ? 'text-red-500' : prefetchInfo.threads >= 3 ? 'text-amber-500' : 'text-green-500'"
        >{{ prefetchInfo.threads }} 线程</span>
      </div>
      <div><span class="text-gray-500">缓冲健康：</span><span class="font-medium">{{ prefetchInfo.bufferSecs }} 秒</span></div>
      <div><span class="text-gray-500">预取完成：</span><span class="font-medium">{{ prefetchInfo.cached }} 分片</span></div>
      <div><span class="text-gray-500">预取中：</span><span class="font-medium">{{ prefetchInfo.pending }} 分片</span></div>
    </div>

    <!-- 实测策略引擎 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
      <div><span class="text-gray-500">单连接速度：</span><span class="font-medium">{{ strategy.perConnKBps }} KB/s</span></div>
      <div>
        <span class="text-gray-500">聚合速度：</span>
        <span class="font-medium" :class="dualChannel && !dualChannelUnavailable ? 'text-green-500' : ''">
          {{ aggregateKBps }} KB/s
          <span class="text-xs text-gray-400">({{ aggregateMbps }} Mbps)</span>
        </span>
      </div>
      <div><span class="text-gray-500">视频码率：</span><span class="font-medium">{{ strategy.segMbps }} Mbps</span></div>
      <div><span class="text-gray-500">目标并发：</span><span class="font-medium">{{ strategy.targetConn }}</span></div>
      <div>
        <span class="text-gray-500">最高流畅倍速：</span>
        <span class="font-medium" :class="strategy.maxFluentRate < playbackRate ? 'text-red-500' : 'text-green-500'">
          {{ strategy.maxFluentRate }}x
        </span>
      </div>
    </div>

    <!-- 播放卡点诊断：已缓冲一直加却不播时看这里 -->
    <div class="text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
      <span class="text-gray-500">播放状态：</span>
      <span class="font-medium">{{ playbackDiag }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  hlsStats, bufferedPercent, progressPercent, playbackRate, playbackDiag,
  tierLabel, tierBadgeColor, tierIsAuto, guardRateCeiling,
  strategy, stall, prefetchInfo, aggregateKBps, aggregateMbps,
  dualChannel, dualChannelUnavailable,
} = useVideoPlayerCtx()
</script>
