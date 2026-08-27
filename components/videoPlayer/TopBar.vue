<template>
  <Transition name="slide-down">
    <div
      v-show="controlsVisible"
      data-no-gesture
      class="absolute top-0 left-0 right-0 z-[5] bg-gradient-to-b from-black/85 to-transparent
             px-2 pt-2 pb-8 sm:px-3 sm:pt-2.5 sm:pb-10 flex items-center gap-1.5 text-white"
      @pointerdown="keepControlsAlive"
      @pointerup="keepControlsAlive"
    >
      <!--
        返回键**常显**。这一页不出站点的品牌栏（画面要置顶），它是唯一的出口；
        全屏里则是退出全屏（横屏握持时右上角够不着，而全屏内没有浏览器的返回键）。
      -->
      <button
        class="p-1.5 rounded-lg hover:bg-white/15 active:scale-90 transition-all shrink-0"
        :title="isFullscreen ? '退出全屏' : '返回'"
        @click="goBack"
      >
        <UIcon name="i-heroicons-arrow-left" class="w-5 h-5 sm:w-6 sm:h-6" />
      </button>

      <div class="min-w-0 flex-1">
        <div class="text-sm sm:text-[15px] font-semibold truncate drop-shadow">
          {{ playlistTitle || '放映厅' }}
          <span v-if="videoRes" class="ml-1 text-xs font-normal text-white/55">| {{ videoRes }}</span>
        </div>
        <div v-if="currentVideoName" class="text-[11px] text-white/60 truncate">
          <span v-if="playlist.length > 1">{{ currentVideoName }} · 第 {{ currentIndex + 1 }}/{{ playlist.length }} 集</span>
          <span v-else>{{ currentVideoName }}</span>
        </div>
      </div>

      <!--
        速度 + 时间 + 电量**只在全屏出**：小窗时系统状态栏就在上面、页面上那行信息条也有一枚速度。
        摆在收藏左边而不是最右——右上角是拇指最难够到的地方，那儿该留给要点的东西。
      -->
      <div v-if="isFullscreen" class="flex items-center gap-2 shrink-0 text-white/80 tabular-nums">
        <!-- 为 0 也照样渲染成「0 KB/s」：缓存到量停取时聚合本来就是 0，让它消失反而更难读 -->
        <span
          v-if="isHls"
          class="text-xs font-medium drop-shadow"
          :class="dualChannel ? 'text-emerald-300/90' : 'text-white/65'"
          :title="`聚合下载速度 ≈ 单连接 ${formatSpeed(strategy.perConnKBps)} × ${strategy.targetConn} 并发`"
        >{{ formatSpeed(aggregateKBps) }}</span>
        <!-- 整片 MP4 要摆成「实测 / 需要」：单看一个速度读不出问题，只有跟「码率 × 倍速」对着看
             才知道是不是物理上喂不动。喂不动标红 -->
        <span
          v-else-if="mp4AvgMbps > 0"
          class="text-xs font-medium drop-shadow"
          :class="mp4Feedable ? 'text-emerald-300/90' : 'text-rose-300'"
          :title="`实测下载 ${formatSpeed(mp4Kbps)}；维持 ${playbackRate}x 需要 ${formatSpeed(mp4NeedKBps)}`
            + `（码率 ${mp4AvgMbps} Mbps × ${playbackRate}）`
            + (mp4Feedable ? '' : ' —— 喂不动，降低倍速或换线路')"
        >{{ formatSpeed(mp4Kbps) }} / {{ formatSpeed(mp4NeedKBps) }}</span>
        <span class="text-[13px] font-medium drop-shadow">{{ clock }}</span>
        <!-- 电量画成一枚小电池：形状本身就传达「还剩多少」，扫一眼不用读数。拿不到的浏览器整块不渲染 -->
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
          <span class="text-[11px]">{{ batteryLevel }}%</span>
        </span>
      </div>

      <!--
        手机竖屏时齿轮和选集在**顶栏**（安卓客户端也是这么摆的）：底部那一行放不下这么多，
        它只留倍速 · 画中画 · 全屏。宽屏和全屏里这两颗在控制栏，这儿就不重复出。
      -->
      <button
        v-if="compact"
        class="p-1.5 rounded-lg shrink-0 hover:bg-white/15 active:scale-90 transition-all"
        title="播放设置"
        @click="openOverlay('settings')"
      >
        <UIcon
          name="i-heroicons-cog-6-tooth" class="w-5 h-5 transition-transform"
          :class="{ 'rotate-90': showSettings }"
        />
      </button>
      <button
        v-if="compact && playlist.length > 1"
        class="p-1.5 rounded-lg shrink-0 transition-all active:scale-90"
        :class="showEpisodes ? 'bg-rose-500/80' : 'hover:bg-white/15'"
        title="选集"
        @click="openOverlay('episodes')"
      >
        <UIcon name="i-heroicons-queue-list" class="w-5 h-5" />
      </button>

      <!-- 收藏摆在画面里：全屏时页面整个看不见，而「这部好看，留一下」恰恰是看着看着才冒出来的念头。
           **认不出是哪部剧就不出**（手工贴地址播的列表收了也找不回来） -->
      <button
        v-if="canFavorite"
        class="p-1.5 rounded-lg shrink-0 transition-all active:scale-90 hover:bg-white/15"
        :class="isFavorited ? 'text-rose-400' : 'text-white'"
        :title="isFavorited ? '取消收藏' : '收藏这部剧'"
        @click="toggleFavorite"
      >
        <UIcon :name="isFavorited ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'" class="w-5 h-5" />
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面顶部信息条，与底部控制栏**同进同出**（共用 `controlsVisible`）。
 * 「选集」已挪去控制栏右侧（安卓端也在那一行），这里只留返回、片名、状态和收藏。
 */
const {
  playlistTitle, currentVideoName, playlist, currentIndex,
  isFullscreen, controlsVisible, toggleFullscreen, keepControlsAlive,
  canFavorite, isFavorited, toggleFavorite,
  // 手机竖屏时齿轮/选集在顶栏（见模板里的 compact）
  showSettings, showEpisodes, openOverlay,
  isHls, aggregateKBps, strategy, dualChannel,
  mp4AvgMbps, mp4Kbps, playbackRate,
  videoRes,
} = useVideoPlayerCtx()

const router = useRouter()

// 「手机竖屏」= 窄屏且不在全屏里。与 ControlBar 那份判据一致（那边靠它砍按钮，这边靠它补回来）
const isNarrow = useNarrowScreen()
const compact = computed(() => isNarrow.value && !isFullscreen.value)

/** 全屏里是「退出全屏」，小窗里是「离开这一页」——这一页没有站点的品牌栏，它是唯一的出口 */
const goBack = () => {
  if (isFullscreen.value) { void toggleFullscreen(); return }
  // `window.` 不能省：本组件作用域里有别的同名东西时会被遮蔽（CLAUDE.md 里踩过一次）
  if (window.history.length > 1) router.back()
  else void navigateTo('/')
}

// 维持**当前倍速**需要多少 KB/s。倍速是乘上去的：3x 要 3 倍码率的持续供给
const mp4NeedKBps = computed(() => (mp4AvgMbps.value * 1e6 / 8 / 1024) * playbackRate.value)
// 还没测出速率时不先扣红帽子（起播头几秒 mp4Kbps 恒为 0）
const mp4Feedable = computed(() => !mp4Kbps.value || mp4Kbps.value >= mp4NeedKBps.value)

// 时钟/电量**不进 ctx**：它只服务这一个组件，进 ctx 就得跟别的模块抢键名
const { clock, batteryLevel, charging } = useDeviceStatus(isFullscreen)
</script>

<style scoped>
.slide-down-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-down-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-down-enter-from,
.slide-down-leave-to { opacity: 0; transform: translateY(-24px); }
</style>
