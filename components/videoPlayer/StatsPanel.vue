<template>
  <div class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
    <!-- 服务器档位 + 缓冲健康区 + 真实卡顿 -->
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <UBadge :color="tierBadgeColor" variant="subtle" size="xs">
        服务器：{{ tierLabel }}{{ tierIsAuto ? '（自动）' : '（锁定）' }}
      </UBadge>
      <!-- 判据写进 title：这个徽标曾被误读成「源站不行」，其实它只是把可播秒数跟档位阈值比了一下 -->
      <UBadge
        :color="strategy.healthZone === 'panic' ? 'red' : strategy.healthZone === 'low' ? 'amber' : 'green'"
        variant="subtle" size="xs"
        :title="`判据：有效可播 ${strategy.playableSecs}s（MSE + 预取缓存）`
          + ` vs 濒卡 <${effectiveTierParams.panicSecs}s / 吃紧 <${effectiveTierParams.lowSecs}s`"
      >
        {{ strategy.healthZone === 'panic' ? '濒卡' : strategy.healthZone === 'low' ? '吃紧' : '健康' }}
        {{ strategy.playableSecs }}s
      </UBadge>
      <UBadge v-if="guardRateCeiling < 99" color="amber" variant="subtle" size="xs">抗卡降速中</UBadge>
      <UBadge :color="stall.stallCount.value > 0 ? 'red' : 'green'" variant="subtle" size="xs">
        卡顿 {{ stall.stallCount.value }} 次 / {{ (stall.stallMsTotal.value / 1000).toFixed(1) }}s
      </UBadge>
      <UBadge color="gray" variant="subtle" size="xs">连续流畅 {{ stall.smoothSecs.value }}s</UBadge>
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
      <!-- 原来叫「缓冲健康」，和上面的健康区徽标是两码事。带上分母才看得出它是「到顶了」而不是「不够」 -->
      <div :title="`hls.js 已 append 进 MSE 的前向秒数，上限被我们锁在 ${mseCeilingSecs}s（append 几百 MB 会触发浏览器 MSE 配额/驱逐 → 缓冲空洞）。`
        + '大量预读在 JS 预取缓存里（=「已缓冲」那一项）。这个数到顶就不再涨，不代表吃紧。'">
        <span class="text-gray-500">MSE 窗口：</span>
        <span class="font-medium">{{ prefetchInfo.bufferSecs }} / {{ mseCeilingSecs }} 秒</span>
      </div>
      <!-- 分片数看不出内存压力（各站分片大小差一个量级），所以把 MB 摆在同一格 -->
      <div
        class="flex items-center gap-1"
        :title="`JS 侧内存缓存（不是 MSE）：已下载好、随时命中的分片。LRU 上限 ${hlsConfig.maxBufferSizeMB} MB，`
          + '超了淘汰最早的。长时间播放堆到上 GB 会让整个页面发卡，每小时自动清理一次已播过的分片。'"
      >
        <span class="text-gray-500">预取缓存：</span>
        <span class="font-medium">{{ prefetchInfo.cached }} 片 / {{ cacheMB }} MB</span>
        <UButton
          size="2xs" variant="ghost" color="gray" icon="i-heroicons-trash"
          title="清掉已经播过的分片，保留播放头前方的预取（不影响正在播的画面）"
          @click="onPurge"
        />
      </div>
      <div><span class="text-gray-500">预取中：</span><span class="font-medium">{{ prefetchInfo.pending }} 分片</span></div>
    </div>

    <!-- 实测策略引擎 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border-t border-gray-200 dark:border-gray-700 pt-2">
      <div><span class="text-gray-500">单连接速度：</span><span class="font-medium">{{ formatSpeed(strategy.perConnKBps) }}</span></div>
      <div>
        <span class="text-gray-500">聚合速度：</span>
        <span class="font-medium" :class="dualChannel && !dualChannelUnavailable ? 'text-green-500' : ''">
          {{ formatSpeed(aggregateKBps) }}
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
  hlsConfig, hlsStats, bufferedPercent, progressPercent, playbackRate, playbackDiag,
  tierLabel, tierBadgeColor, tierIsAuto, guardRateCeiling, effectiveTierParams,
  strategy, stall, prefetchInfo, aggregateKBps, aggregateMbps,
  dualChannel, dualChannelUnavailable, purgePlayedSegments,
} = useVideoPlayerCtx()

// MSE 窗口上限：与 useVideoEngine 里给 hls.js 的 maxMaxBufferLength 同一个算式（那边是 append 的硬闸）
const mseCeilingSecs = computed(() => Math.min(60, hlsConfig.value.maxMaxBufferLength))

const cacheMB = computed(() => (prefetchInfo.value.bytes / 1024 / 1024).toFixed(0))

const toast = useToast()

// 清理完必须给回执：释放 0 的时候尤其要说话，否则用户分不清「点了没反应」和「本来就没得清」
const onPurge = () => {
  const { removed, freedBytes } = purgePlayedSegments()
  if (!removed) {
    toast.add({ title: '没有可清理的已播分片', description: '播放头之前 30 秒内的分片会保留，供往回拖时命中', color: 'gray' })
    return
  }
  toast.add({
    title: `已释放 ${(freedBytes / 1024 / 1024).toFixed(0)} MB`,
    description: `清掉 ${removed} 个已播分片，前方预取原样保留`,
    color: 'green',
  })
}
</script>
