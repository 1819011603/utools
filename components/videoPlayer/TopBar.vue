<template>
  <Transition name="slide-down">
    <div
      v-show="controlsVisible"
      data-no-gesture
      class="absolute top-0 left-0 right-0 z-[5] bg-gradient-to-b from-black/80 to-transparent px-3 pt-3 pb-10
             flex items-center gap-2 text-white"
      @pointerdown="keepControlsAlive"
      @pointerup="keepControlsAlive"
    >
      <!-- 全屏里没有浏览器的返回键，退出全屏得有个显眼的入口（横屏握持时右上角够不着） -->
      <button
        v-if="isFullscreen"
        class="p-2 rounded-lg hover:bg-white/15 active:scale-90 transition-all shrink-0"
        title="退出全屏"
        @click="toggleFullscreen"
      >
        <UIcon name="i-heroicons-arrow-left" class="w-6 h-6" />
      </button>

      <div class="min-w-0 flex-1">
        <div class="font-semibold truncate drop-shadow">{{ playlistTitle || '放映厅' }}</div>
        <div class="text-xs text-white/70 truncate">
          <span v-if="playlist.length > 1">{{ currentVideoName }} · 第 {{ currentIndex + 1 }}/{{ playlist.length }} 集</span>
          <span v-else>{{ currentVideoName }}</span>
        </div>
      </div>

      <!--
        速度 + 时间 + 电量，**只在全屏出**：小窗时系统状态栏就在上面、页面上那行信息条也有一枚速度，
        再画一份纯属重复。位置放在「选集」左边而不是最右——右上角是拇指最难够到的地方，
        那儿该留给要点的东西
      -->
      <div v-if="isFullscreen" class="flex items-center gap-2 shrink-0 text-white/85 tabular-nums">
        <!-- 清晰度：与页面上那行信息条同一个值（见 useVideoEvents.videoRes），全屏时那行看不见，
             这里补一份。优先显示解码实测的真实像素，清单声明的值不总是准 -->
        <span v-if="videoRes" class="text-xs font-medium drop-shadow">{{ videoRes }}</span>
        <!--
          聚合下载速度摆在时间/电量**左边**：全屏时页面上那行信息条整个看不见，
          而「现在到底下得动下不动」恰恰是看片当下最想知道的一件事（卡的时候尤其）。
          只显示 KB/s / MB/s。**为 0 也照样渲染成「0 KB/s」**：缓存到量停取时聚合本来就是 0，
          让它消失反而更难读——数字一会儿在一会儿不在，时钟和电池还得跟着左右挪。
        -->
        <span
          v-if="isHls"
          class="text-xs font-medium drop-shadow"
          :class="dualChannel ? 'text-emerald-300/90' : 'text-white/70'"
          :title="`聚合下载速度 ≈ 单连接 ${formatSpeed(strategy.perConnKBps)} × ${strategy.targetConn} 并发`"
        >{{ formatSpeed(aggregateKBps) }}</span>
        <!--
          整片 MP4 的下载速度，与 HLS 那枚同一个位置。
          **要摆成「实测 / 需要」**：单看一个速度读不出问题，只有跟「码率 × 倍速」对着看
          才知道是不是物理上喂不动（3x 要 3 倍码率的持续供给）。喂不动标红。
          全屏时页面上那行信息条整个看不见，而这恰恰是卡的时候最想知道的一件事。
        -->
        <span
          v-else-if="mp4AvgMbps > 0"
          class="text-xs font-medium drop-shadow"
          :class="mp4Feedable ? 'text-emerald-300/90' : 'text-rose-300'"
          :title="`实测下载 ${formatSpeed(mp4Kbps)}；维持 ${playbackRate}x 需要 ${formatSpeed(mp4NeedKBps)}`
            + `（码率 ${mp4AvgMbps} Mbps × ${playbackRate}）`
            + (mp4Feedable ? '' : ' —— 喂不动，降低倍速或换线路')"
        >{{ formatSpeed(mp4Kbps) }} / {{ formatSpeed(mp4NeedKBps) }}</span>
        <span class="text-sm font-medium drop-shadow">{{ clock }}</span>
        <!-- 电量画成一枚小电池而不是写个数字：形状本身就传达「还剩多少」，扫一眼不用读数。
             拿不到电量的浏览器（Safari/Firefox）整块不渲染 -->
        <span v-if="batteryLevel !== null" class="flex items-center gap-1">
          <span class="flex items-center">
            <span class="relative w-6 h-3 rounded-[3px] ring-1 ring-white/60 p-[1.5px] flex items-center">
              <span
                class="h-full rounded-[1px] transition-all duration-700"
                :class="batteryLevel <= 20 && !charging ? 'bg-rose-400' : 'bg-white'"
                :style="{ width: Math.max(8, batteryLevel) + '%' }"
              />
              <UIcon v-if="charging" name="i-heroicons-bolt-solid" class="absolute inset-0 m-auto w-2.5 h-2.5 text-amber-300 drop-shadow" />
            </span>
            <span class="w-[2px] h-1.5 rounded-r-[1px] bg-white/60" />
          </span>
          <span class="text-xs">{{ batteryLevel }}%</span>
        </span>
      </div>

      <button
        v-if="playlist.length > 1"
        class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium shrink-0 transition-all active:scale-95"
        :class="showEpisodes ? 'bg-violet-500/80' : 'bg-white/10 hover:bg-white/20'"
        title="选集"
        @click="showEpisodes = !showEpisodes"
      >
        <UIcon name="i-heroicons-queue-list" class="w-5 h-5" />
        <span class="hidden sm:inline">选集</span>
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面顶部的信息条，与底部控制栏**同进同出**（共用 `controlsVisible`）。
 *
 * 全屏时页面上的标题栏整个看不见，「在看什么、第几集」就此消失；
 * 而这恰恰是切集前最需要确认的两件事，所以它必须画在画面里。
 */
const {
  playlistTitle, currentVideoName, playlist, currentIndex,
  showEpisodes, isFullscreen, controlsVisible,
  toggleFullscreen, keepControlsAlive,
  // 全屏顶栏那枚速度（时间/电量左边）：HLS 用聚合速度，整片 MP4 用「实测 / 需要」
  isHls, aggregateKBps, strategy, dualChannel,
  mp4AvgMbps, mp4Kbps, playbackRate,
  // 清晰度：与页面信息条共用同一份计算（useVideoEvents.videoRes）
  videoRes,
} = useVideoPlayerCtx()

// 维持**当前倍速**需要多少 KB/s。倍速是乘上去的：3x 要 3 倍码率的持续供给
const mp4NeedKBps = computed(() => (mp4AvgMbps.value * 1e6 / 8 / 1024) * playbackRate.value)
// 还没测出速率时不先扣红帽子（起播头几秒 mp4Kbps 恒为 0）
const mp4Feedable = computed(() => !mp4Kbps.value || mp4Kbps.value >= mp4NeedKBps.value)

// 时钟/电量**不进 ctx**：它只服务这一个组件，进 ctx 就得跟别的模块抢键名
// （「各模块返回的键名不能重复」那条约束），而它跟播放逻辑没有半点关系
const { clock, batteryLevel, charging } = useDeviceStatus(isFullscreen)
</script>

<style scoped>
.slide-down-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-down-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-down-enter-from,
.slide-down-leave-to { opacity: 0; transform: translateY(-24px); }
</style>
