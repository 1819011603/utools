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
      <!-- 掉帧是解码/渲染侧的唯一直接证据：缓冲读数再好看也照不出它。
           判读方式写进 title，否则光看一个数字没人知道该跟什么比 -->
      <div :title="'解码器丢掉、没能画出来的帧。判读：'
        + '① 缓冲健康但掉帧在涨 → 解码/GPU/倍速太高；'
        + '② 缓冲被吃空但掉帧不涨 → 网络或预取问题；'
        + '③ 切标签页回来时一次性猛涨 → 内存换页/GC 卡住了主线程。'
        + '偶尔零星几帧属正常。'">
        <span class="text-gray-500">掉帧：</span>
        <span class="font-medium" :class="droppedPercent > 1 ? 'text-red-500' : droppedPercent > 0.2 ? 'text-amber-500' : ''">
          {{ hlsStats?.dropped ?? 0 }} 帧（{{ droppedPercent.toFixed(2) }}%）
        </span>
      </div>
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
      <!-- 「单条」是低并发（≤2 条）档的读数，跟左边那个混了各并发档的均值不是一回事：
           每 IP 限总量的源上 6 条各自都慢，均值会把「单连接被限速了」判反。加不加线程只看它 -->
      <div :title="'左值：各并发档采样的均值。'
        + '括号里的「单条」只取低并发（≤2 条）档，是「这个源一条连接能跑多快」——'
        + '加不加线程的判据：门槛按当前倍速放大（1x 下 ≥1MB/s 封 2 条、≥500KB/s 封 3 条，'
        + '低于门槛才放开多开），且只在存货过了阶梯放开线之后才生效——'
        + '起播/切集/拖进度那一刻一律按存货阶梯来。'
        + '「保有」= 当前每连接 ÷ 单条基线：加线程当场就掉，比聚合拐点早得多，'
        + `所以只在它没掉多少时才允许继续加（<70% 收到 3 条、<45% 收到 2 条）。当前目标 ${strategy.targetConn} 条。`">
        <span class="text-gray-500">单连接速度：</span>
        <span class="font-medium">{{ formatSpeed(strategy.perConnKBps) }}</span>
        <span v-if="strategy.soloKBps > 0" class="text-xs text-gray-400"> (单条 {{ formatSpeed(strategy.soloKBps) }})</span>
        <!-- 保有率是「加线程有没有加个白的」最快的信号，比聚合拐点早得多，所以摆在这里而不是聚合那一格 -->
        <span
          v-if="strategy.soloRetain > 0"
          class="text-xs"
          :class="strategy.soloRetain < 0.45 ? 'text-red-500' : strategy.soloRetain < 0.7 ? 'text-amber-500' : 'text-gray-400'"
        > 保有 {{ Math.round(strategy.soloRetain * 100) }}%</span>
      </div>
      <div>
        <span class="text-gray-500">聚合速度：</span>
        <span class="font-medium" :class="dualChannel && !dualChannelUnavailable ? 'text-green-500' : ''">
          {{ formatSpeed(aggregateKBps) }}
          <span class="text-xs text-gray-400">({{ aggregateMbps }} Mbps)</span>
        </span>
      </div>
      <div><span class="text-gray-500">视频码率：</span><span class="font-medium">{{ strategy.segMbps }} Mbps</span></div>
      <!-- 「饱和」是「为什么只开这么几条」最直接的答案：峰值聚合 ÷ 单条基线，
           超过它的每一条都只能从别人嘴里抢带宽 -->
      <div :title="'饱和并发 = 实测峰值聚合 ÷ 单条基线：源站给这个 IP 的总量摊给「每条都能跑满」的连接数。'
        + '开超过它的每一条都只是分摊，最需要的那一片反而更晚到。'">
        <span class="text-gray-500">目标并发：</span>
        <span class="font-medium">{{ strategy.targetConn }}</span>
        <span
          v-if="strategy.satConn > 0"
          class="text-xs"
          :class="strategy.targetConn > strategy.satConn ? 'text-red-500' : 'text-gray-400'"
        > / 饱和 {{ strategy.satConn }}</span>
      </div>
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
import { MSE_CEILING_SECS } from '~/composables/videoPlayer/types'
const {
  hlsConfig, hlsStats, bufferedPercent, progressPercent, playbackRate, playbackDiag,
  tierLabel, tierBadgeColor, tierIsAuto, guardRateCeiling, effectiveTierParams,
  strategy, stall, prefetchInfo, aggregateKBps, aggregateMbps,
  dualChannel, dualChannelUnavailable, purgePlayedSegments,
} = useVideoPlayerCtx()

// MSE 窗口上限：就是 engine/hlsConfig.ts 交给 hls.js 的 maxMaxBufferLength（append 的硬闸）。
// 它**不再跟着「预加载时长」变**——那个旋钮现在量的是「够播几秒」，单位不同，见 hlsConfig 的说明
const mseCeilingSecs = MSE_CEILING_SECS

const cacheMB = computed(() => (prefetchInfo.value.bytes / 1024 / 1024).toFixed(0))

const droppedPercent = computed(() => {
  const s = hlsStats.value
  return s && s.total > 0 ? (s.dropped / s.total) * 100 : 0
})

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
