<template>
  <!--
    媒体信息浮层：**视频本身**的事实（真实像素/编码/帧率/码率/地址）。
    跟页面下方那块「HLS 配置与统计」分工不同——那边是传输与抗卡诊断（线程/聚合速度/饱和并发），
    这边是「我正在看的到底是什么片子」，而后者原来在整个界面上一个字都没有。

    摆右上角：左侧垂直居中是锁定键、顶部是信息条、底部是控制栏，只有这一块是空的。
    全屏时才是它真正要用的时候（那时页面上的折叠卡一个都看不见）。
  -->
  <Transition name="info">
    <div
      v-if="showMediaInfo"
      data-ctx-menu
      data-no-gesture
      class="absolute right-3 top-16 z-30 w-[19rem] max-w-[calc(100%-1.5rem)] max-h-[62%]
             overflow-y-auto no-sb rounded-xl text-white
             bg-black/78 backdrop-blur-md ring-1 ring-white/15 shadow-2xl"
      @contextmenu.prevent
    >
      <div class="flex items-center gap-2 px-3 py-2 border-b border-white/10 sticky top-0 bg-black/70 backdrop-blur-md">
        <UIcon name="i-heroicons-information-circle" class="w-4 h-4 text-violet-300" />
        <span class="text-sm font-medium flex-1">媒体信息</span>
        <button class="p-0.5 rounded hover:bg-white/15" title="关闭" @click="showMediaInfo = false">
          <UIcon name="i-heroicons-x-mark" class="w-4 h-4 text-white/70" />
        </button>
      </div>

      <div class="px-3 py-2 space-y-1.5 text-xs">
        <!--
          解码实测排第一，且**必须带上「当前这一帧」这句话**：它跟站点标的档位对不上是常态，
          实测某站正片 1920×808@25、正片前面还拼了 8 秒贴片 1920×1080@30
          （清单里用 #EXT-X-DISCONTINUITY 隔开，压根是两段不同编码）。
          少了这句解释，两个数字对不上只会被当成 bug。
        -->
        <div v-if="mediaInfo.pixels" class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">解码实测</span>
          <span class="font-medium tabular-nums">{{ mediaInfo.pixels }}</span>
          <span class="text-white/35">当前这一帧的真实像素</span>
        </div>
        <div v-if="mediaInfo.declared" class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">清单声明</span>
          <span class="font-medium tabular-nums">{{ mediaInfo.declared }}</span>
          <span v-if="mediaInfo.levelCount > 1" class="text-white/35">共 {{ mediaInfo.levelCount }} 档</span>
        </div>
        <p
          v-if="mediaInfo.pixels && mediaInfo.declared && !sameHeight"
          class="text-[11px] text-amber-300/80 leading-snug"
        >
          两者不一致：站点标的档位不总是真实编码，而正片前面的贴片/广告常常是另一个分辨率。
          以解码实测为准。
        </p>

        <div v-if="mediaInfo.videoCodec || mediaInfo.audioCodec" class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">编码</span>
          <span class="font-medium break-all">
            {{ mediaInfo.videoCodec || '—' }}<span v-if="mediaInfo.audioCodec"> / {{ mediaInfo.audioCodec }}</span>
          </span>
        </div>
        <div v-if="mediaInfo.fps || mediaInfo.bitrateMbps" class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">帧率 / 码率</span>
          <span class="font-medium tabular-nums">
            {{ mediaInfo.fps ? mediaInfo.fps + ' fps' : '—' }}
            <span v-if="mediaInfo.bitrateMbps"> · 声明 {{ mediaInfo.bitrateMbps }} Mbps</span>
          </span>
        </div>
        <!-- 声明码率常常离实测差一截（尤其可变码率），实测那份来自分片实际大小，判「喂不喂得动」只看它 -->
        <div v-if="strategy.segMbps > 0" class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">实测码率</span>
          <span class="font-medium tabular-nums">{{ strategy.segMbps }} Mbps</span>
        </div>

        <div class="flex items-baseline gap-2 pt-1 border-t border-white/10">
          <span class="text-white/45 shrink-0">时长</span>
          <span class="font-medium tabular-nums">
            {{ formatTime(mediaInfo.currentTime) }} / {{ formatTime(mediaInfo.duration) }}
          </span>
        </div>
        <div class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">倍速</span>
          <span class="font-medium tabular-nums">
            {{ mediaInfo.rate }}x
            <!-- 实际 ≠ 目标时要说清是谁压的，否则「我明明选了 3x」无从查起 -->
            <span v-if="mediaInfo.rate !== mediaInfo.desiredRate" class="text-amber-300">
              （目标 {{ mediaInfo.desiredRate }}x，被带宽/抗卡守卫压住）
            </span>
          </span>
        </div>
        <div class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">格式 / 缓冲</span>
          <span class="font-medium tabular-nums">
            {{ isHls ? 'HLS/M3U8' : 'MP4' }} · 有效可播 {{ mediaInfo.buffered.toFixed(1) }}s
          </span>
        </div>
        <!-- 掉帧是解码/渲染侧唯一的直接证据，缓冲读数再好看也照不出它（判读口径同统计面板） -->
        <div class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">掉帧</span>
          <span
            class="font-medium tabular-nums"
            :class="droppedPercent > 1 ? 'text-red-400' : droppedPercent > 0.2 ? 'text-amber-300' : ''"
          >{{ mediaInfo.dropped }} / {{ mediaInfo.totalFrames }} 帧（{{ droppedPercent.toFixed(2) }}%）</span>
        </div>
        <div class="flex items-baseline gap-2">
          <span class="text-white/45 shrink-0">就绪等级</span>
          <span class="font-medium">{{ readyStateText }}</span>
        </div>

        <div v-if="mediaInfo.url" class="pt-1 border-t border-white/10">
          <div class="flex items-center gap-2">
            <span class="text-white/45">播放地址</span>
            <button
              class="px-1.5 py-0.5 rounded text-[11px] hover:bg-white/15 text-white/70"
              @click="copyVideoUrl"
            >{{ copyState === 'ok' ? '已复制' : copyState === 'fail' ? '需 https' : '复制' }}</button>
          </div>
          <!-- 全文摊开而不是截断：拿它去 curl/ffprobe 复现时少一段就白搭（签名都在 query 里） -->
          <p class="mt-1 text-[11px] text-white/50 break-all leading-snug">{{ mediaInfo.url }}</p>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
const { showMediaInfo, mediaInfo, copyState, copyVideoUrl, isHls, strategy } = useVideoPlayerCtx()

// 「解码实测跟声明档差多少」只比高度：声明档格式化成「1080p (2500kbps)」，
// 里面的 1080 就是高度，拿它跟实测像素的高度对一下就够，不必再解一遍字符串宽度
const sameHeight = computed(() => {
  const real = mediaInfo.value.pixels.split('×')[1]?.trim()
  const declared = mediaInfo.value.declared.match(/^(\d+)p/)?.[1]
  return !!real && !!declared && real === declared
})

const droppedPercent = computed(() => {
  const m = mediaInfo.value
  return m.totalFrames > 0 ? (m.dropped / m.totalFrames) * 100 : 0
})

// 跟 videoDiag.ts 的 READY_STATE_TXT 同一套说法（那份是给诊断长句用的，这里要短）
const READY_STATE = ['0 无数据', '1 仅元数据', '2 有当前帧·不够续播', '3 够续播', '4 缓冲充足']
const readyStateText = computed(() => READY_STATE[mediaInfo.value.readyState] ?? String(mediaInfo.value.readyState))
</script>

<style scoped>
/* 滚动条那条灰槽在黑画面上是最扎眼的一块，而且它不吃 backdrop-blur（同 Stage 里那份 .no-sb） */
.no-sb { scrollbar-width: none; -ms-overflow-style: none; }
.no-sb::-webkit-scrollbar { display: none; }

.info-enter-active { transition: opacity .16s ease, transform .24s cubic-bezier(.2, 1.4, .4, 1); }
.info-leave-active { transition: opacity .16s ease; }
.info-enter-from { opacity: 0; transform: translateY(-8px) scale(.96); }
.info-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .info-enter-active { transition: opacity .15s ease; }
  .info-enter-from { transform: none; }
}
</style>
