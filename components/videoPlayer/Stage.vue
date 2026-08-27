<template>
  <!--
    **只有窄屏（手机）通栏铺满**：手机上 16:9 本来就不高，两侧再留白只会把它压得更小；
    宽屏则老老实实待在容器里（照旧带圆角）。
    ⚠️ 这里曾试过 `sm:w-[calc(100vw-3rem)]` 想把画面铺得更宽 —— **`calc` 里的 `-` 两边必须有空格**，
    `calc(100vw-3rem)` 是无效 CSS，整条声明被丢掉 → 基础的 `w-screen` 在所有断点上都生效，
    画面当场变成整个视口宽、高度顶出屏幕。要写的话得用 Tailwind 的下划线转义
    （`calc(100vw_-_3rem)`），但眼下不需要：画面大小保持原样。
    100vw 比可用宽度多出的滚动条宽度由 layouts/default.vue 根上的 overflow-x-clip 兜住。
  -->
  <div class="relative left-1/2 -translate-x-1/2 w-screen sm:left-auto sm:translate-x-0 sm:w-auto">
    <!-- 手势全部走 Pointer Events（鼠标/触摸同一套，见 useVideoGestures） -->
    <div
      ref="playerContainer"
      class="relative bg-black overflow-hidden group flex items-center justify-center select-none sm:rounded-xl"
      :class="[
        // 隐藏鼠标**只在全屏里**做：窗口模式下画面只占页面的一块，指针在那块上凭空消失
        // 只会让人以为浏览器卡了。而且**只在画面上什么都没出的时候**藏 ——
        // 锁定态下解锁键露出来时指针必须跟着回来，否则那枚键看得见却点不准
        { 'cursor-none': isFullscreen && isPlaying && !showControls && !showLockBtn },
        isFullscreen ? 'fixed inset-0 z-50 rounded-none' : '',
      ]"
      :style="{ touchAction }"
      @mousemove="onMouseMove"
      @mouseleave="hideControlsDelayed"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @click="onClick"
      @dblclick="onDblClick"
      @contextmenu="onPlayerContextMenu"
    >
      <!--
        **不加 `crossorigin`**：HLS 走 MSE（src 是 blob，这属性对它毫无意义），而整片 MP4 直连时
        它是致命的——加了就把媒体请求变成 CORS 模式，源站不回 ACAO 就整个播不了。
      -->
      <video
        ref="videoEl"
        :key="videoKey"
        class="max-w-full max-h-full"
        :class="fitClass"
        :style="{
          filter: brightness === 1 ? undefined : `brightness(${brightness})`,
          // 恒非空：让 <video> 常驻合成层，forceRecomposite 才能只重画不闪（见 useVideoEngine）
          transform: videoTransform,
        }"
        playsinline
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
        @resize="onVideoResize"
        @durationchange="onDurationChange"
        @progress="onProgress"
        @loadeddata="onLoadedData"
        @play="isPlaying = true"
        @pause="onPause"
        @ended="onVideoEnded"
        @waiting="onWaiting"
        @canplay="onCanPlay"
        @canplaythrough="onCanPlayThrough"
        @seeking="onSeeking"
        @seeked="onSeeked"
        @playing="onPlaying"
        @volumechange="onVolumeChange"
        @error="onVideoError"
      />

      <div v-if="isBuffering || isResolvingUrl" class="absolute inset-0 flex items-center justify-center bg-black/30">
        <div class="flex flex-col items-center gap-2">
          <UIcon name="i-heroicons-arrow-path" class="w-10 h-10 text-white animate-spin" />
          <!-- resolveStage 带秒数：不动的文案分不清「在跑」还是「卡死了」 -->
          <span class="text-white text-[13px]">
            {{ isResolvingUrl ? (resolveStage || '正在获取播放地址...') : isProbing ? '正在探测连接方式...' : '加载中...' }}
          </span>
        </div>
      </div>

      <VideoPlayerTopBar />

      <!--
        中央播放/暂停图标：切换时闪一下，**暂停期间常驻**——暂停后画面是一张静止图，
        没有任何东西表明「是暂停了还是卡死了」。常驻这枚可以直接点（自动播放被拦下时它是唯一入口）。
        锁定态下不出：它带 @click，锁了还能暂停等于开关是坏的，而且正压在解锁键上方。
      -->
      <Transition name="pop">
        <div
          v-if="!isLocked && (showPlayIcon || pausedIdle)"
          class="absolute inset-0 flex items-center justify-center"
          :class="pausedIdle ? 'cursor-pointer' : 'pointer-events-none'"
          data-no-gesture
          @click="pausedIdle && togglePlay()"
        >
          <!-- 整块可点而不只是那枚圆：手机上要瞄准那个圈太难，「点了没反应」多半是没点中 -->
          <div class="relative">
            <span v-if="showPlayIcon" class="absolute inset-0 rounded-full bg-white/25 blast" />
            <div
              class="w-16 h-16 sm:w-[68px] sm:h-[68px] rounded-full bg-black/50 backdrop-blur-sm
                     flex items-center justify-center ring-1 ring-white/20 transition-transform"
              :class="pausedIdle ? 'hover:scale-110 active:scale-95' : ''"
            >
              <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-8 h-8 sm:w-9 sm:h-9 text-white" />
            </div>
          </div>
        </div>
      </Transition>

      <!-- 双击 ±5s 的落点反馈：不给反馈的话，跳了 5 秒和「没点到」看起来一模一样 -->
      <Transition name="ripple">
        <div
          v-if="seekFlash"
          :key="seekFlash.side"
          class="absolute inset-y-0 w-[38%] overflow-hidden pointer-events-none"
          :class="seekFlash.side === 'left' ? 'left-0' : 'right-0'"
        >
          <span
            class="absolute top-1/2 -translate-y-1/2 w-[150%] aspect-square rounded-full bg-white/15 ripple-blob"
            :class="seekFlash.side === 'left' ? '-left-1/2' : '-right-1/2'"
          />
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white drop-shadow-lg">
            <div class="flex" :class="seekFlash.side === 'left' ? 'flex-row-reverse' : ''">
              <UIcon
                v-for="i in 3"
                :key="i"
                :name="seekFlash.side === 'left' ? 'i-heroicons-chevron-left' : 'i-heroicons-chevron-right'"
                class="w-5 h-5 -mx-1 chev"
                :style="{ animationDelay: (i - 1) * 0.12 + 's' }"
              />
            </div>
            <!-- key 带上秒数：连点时数字换掉要重放一次弹跳，否则看不出又加了 5 秒 -->
            <span :key="seekFlash.secs" class="text-[13px] font-semibold tabular-nums secs-pop">
              {{ seekFlash.secs }} 秒
            </span>
          </div>
        </div>
      </Transition>

      <!-- 长按加速中的常驻提示：不显示的话松手前用户不知道自己触发了什么 -->
      <Transition name="drop">
        <div v-if="boostActive" class="absolute top-16 left-1/2 -translate-x-1/2 pointer-events-none">
          <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-white text-[13px] font-semibold
                      bg-black/65 backdrop-blur-sm ring-1 ring-white/20 shadow-lg">
            <span class="flex">
              <UIcon
                v-for="i in 3"
                :key="i"
                name="i-heroicons-play-solid"
                class="w-3 h-3 -mx-0.5 chev"
                :style="{ animationDelay: (i - 1) * 0.15 + 's' }"
              />
            </span>
            {{ boostRate }}x 快进中
          </div>
        </div>
      </Transition>

      <!-- 滑动手势的中央读数（进度/音量/亮度共用一张） -->
      <Transition name="pop">
        <div v-if="gestureHud" class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="px-4 py-2.5 rounded-xl bg-black/65 backdrop-blur-md text-white min-w-[136px]
                      flex flex-col items-center gap-2 ring-1 ring-white/15 shadow-2xl">
            <div class="flex items-center gap-2">
              <UIcon
                :name="gestureHud.kind === 'seek' ? 'i-heroicons-arrows-right-left'
                  : gestureHud.kind === 'volume' ? volumeIcon : 'i-heroicons-sun'"
                class="w-4 h-4 text-rose-300"
              />
              <span class="font-mono text-[13px]">{{ gestureHud.text }}</span>
              <span
                v-if="gestureHud.delta"
                :key="gestureHud.delta"
                class="text-[13px] font-mono font-semibold secs-pop"
                :class="gestureHud.delta.startsWith('+') ? 'text-emerald-300' : 'text-amber-300'"
              >{{ gestureHud.delta }}</span>
            </div>
            <div class="w-32 h-1 bg-white/20 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-rose-400 to-fuchsia-400"
                :style="{ width: (gestureHud.percent ?? 0) + '%' }"
              />
            </div>
          </div>
        </div>
      </Transition>

      <!--
        锁定按钮。**未锁定时只在全屏出**：防误触本来就是全屏握持时才需要的事，
        而小窗里左侧垂直居中正好压在中央播放键旁边。
        **已锁定时任何尺寸都必须出**：锁定态下手势层全 return、控制栏恒隐、快捷键也停，
        它是画面上唯一的出口——切应用回来时系统可能已经把全屏退了，条件里带上 isFullscreen
        就会变成「点什么都没反应，只能刷新页面」。
        样式照安卓端：一枚半透明黑的圆角方块，不是一大块渐变圆（后者在黑画面上像个警告标）。
      -->
      <Transition name="pop">
        <button
          v-if="isLocked ? showLockBtn : (isFullscreen && (showControls || pausedIdle))"
          data-no-gesture
          class="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-xl text-white
                 flex items-center justify-center bg-black/45 backdrop-blur-sm
                 ring-1 ring-white/15 hover:bg-black/65 active:scale-95 transition-all"
          :title="isLocked ? '解锁' : '锁定屏幕（屏蔽手势与控制栏）'"
          @click="toggleLock"
        >
          <!-- key 换掉 → 图标重新入场，锁上/解锁那一下能看见是「翻」过去的 -->
          <UIcon
            :key="String(isLocked)"
            :name="isLocked ? 'i-heroicons-lock-closed' : 'i-heroicons-lock-open'"
            class="w-5 h-5 lock-flip"
          />
        </button>
      </Transition>

      <VideoPlayerControlBar />

      <VideoPlayerEpisodeOverlay />
      <VideoPlayerSettingsPanel />
      <VideoPlayerLineOverlay />

      <!-- 右键菜单 + 它开出来的媒体信息面板（挂在容器内：容器就是全屏元素） -->
      <VideoPlayerContextMenu />
    </div>

    <!--
      画面下方只留「在看什么 + 去哪儿」这几样。
      **诊断读数（清晰度/格式/缓冲秒数/预取线程/聚合速度/MP4 速率）一概不摆在这里**——
      看片的人一个都用不上，而它们排成一行比片名还长。要判读抗卡就展开「HLS 配置与统计」，
      那边本来就有全套（含各并发档的单条基线和饱和并发），比这一行的摘要更能说明问题。
      窄屏时画面通栏，这一行要自己补回 padding。
    -->
    <div class="px-4 sm:px-0 pt-2.5 flex items-center gap-2 flex-wrap text-sm">
      <span class="font-semibold truncate max-w-full">{{ playlistTitle || '放映厅' }}</span>
      <!-- 「现在是第几集」要一眼看得到，所以给实色徽标（集名那枚常常是「index.m3u8」，不能拿它当集数用） -->
      <UBadge v-if="playlist.length > 1" color="violet" variant="solid" size="xs">
        第 {{ currentIndex + 1 }}/{{ playlist.length }} 集
      </UBadge>
      <UBadge v-if="playlist.length > 1 && currentVideoName" color="violet" variant="soft" size="xs">
        {{ currentVideoName }}
      </UBadge>

      <!-- 回解析页换线路。控制栏那颗「换源」是原地换（留在这一集），这一颗是回去重挑一次，两个都要留 -->
      <UButton
        v-if="playlistSource"
        size="xs"
        variant="soft"
        color="violet"
        icon="i-heroicons-arrow-uturn-left"
        title="回解析页，可换线路/换集（带着本片地址和当前线路过去）"
        @click="backToParseSource"
      >
        换线路
      </UButton>

      <!-- 用 <a>（:to + external）而不是 window.open：后者只能在用户手势的调用栈里同步调。
           文案跟着精度走——不精确到当前集时说成「当前集」就是骗人 -->
      <UButton
        v-if="currentSourceLink.url"
        :to="currentSourceLink.url"
        target="_blank"
        rel="noopener noreferrer"
        external
        size="xs"
        variant="soft"
        color="gray"
        icon="i-heroicons-arrow-top-right-on-square"
        :title="currentSourceLink.exact
          ? `在新标签打开当前这一集的源站播放页：${currentSourceLink.url}`
          : `在新标签打开源站播放页：${currentSourceLink.url}（这份列表只记得解析入口那一集，不一定是当前集）`"
      >
        {{ currentSourceLink.exact ? '源站本集' : '源站' }}
      </UButton>

      <!-- 探测中要说话（那几秒画面上什么都没有），探完就只剩一枚可点的入口 -->
      <UBadge
        v-if="isProbing"
        color="gray" variant="soft" size="xs"
        class="cursor-pointer"
        title="点击展开连接与防盗链设置（含可达性探测矩阵）"
        @click="showAdvancedProxy = !showAdvancedProxy"
      >探测连接方式…</UBadge>
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  videoEl, playerContainer, videoKey,
  isPlaying, isBuffering, isResolvingUrl, resolveStage, isProbing, isFullscreen, isVideoLoaded,
  showControls, showPlayIcon, showAdvancedProxy,
  playlist, playlistTitle, currentIndex, currentVideoName,
  playlistSource, backToParseSource, currentSourceLink,
  volumeIcon, togglePlay, hideControlsDelayed,
  // 手势层（useVideoGestures）+ 裸状态里的锁定 / 亮度 / 画面尺寸
  isLocked, showLockBtn, toggleLock, brightness, fitMode, gestureHud, seekFlash, touchAction,
  videoTransform,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseMove, onClick, onDblClick,
  boostActive, boostRate,
  onTimeUpdate, onLoadedMetadata, onDurationChange, onProgress, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onPause, onVolumeChange, onVideoError,
  onVideoResize,
  openContextMenu, recentTouch,
} = useVideoPlayerCtx()

/**
 * 右键菜单只给鼠标。
 *
 * **安卓上长按会派发 `contextmenu`**（长按落在 `<video>` 上，Chrome 弹的是媒体右键菜单：
 * 下载/画中画那一套），而那一下的本意是**长按加速**。不拦的话两件事一起发生：
 * 菜单盖在画面上，随之而来的 `pointercancel` 又把刚起来的加速掐掉。
 * `preventDefault` 同时也压掉了原生菜单和长按选字。
 */
const onPlayerContextMenu = (e: MouseEvent) => {
  if (recentTouch()) { e.preventDefault(); return }
  openContextMenu(e)
}

/**
 * 画面尺寸（设置抽屉里那一排）。
 * 非全屏一律保持 16:9 的盒子——页面版式不能被片源比例带着跳，只换 object-fit；
 * 全屏才允许换盒子形状。默认档在全屏里给 `w-auto h-full`，让画面按自己的比例居中。
 *
 * ⚠️ **比例只能写 `aspect-[16/9]`，绝不能用 `aspect-video`**：@nuxt/ui 挂了老的
 * `@tailwindcss/aspect-ratio` 插件，它把 `theme.aspectRatio` 整个换成 `{1…16}`（给
 * `aspect-w-16`/`aspect-h-9` 用的），于是 `video` 这个键压根不存在 —— `aspect-video`
 * **一个字节的 CSS 都不生成**，而任意值 `aspect-[16/9]` 照旧可用。
 * 这个坑在 16:9 片源上看不出来（`<video>` 自己就是 16:9），
 * 换成 4:3 的源（实测 ncat22 某剧）盒子当场长到 4:3、高度顶出屏幕。
 */
const fitClass = computed(() => {
  const fs = isFullscreen.value
  const box = fs ? 'w-full h-full' : 'w-full aspect-[16/9] max-h-[78vh]'
  switch (fitMode.value) {
    case 'cover': return `${box} object-cover`
    case 'fill': return `${box} object-fill`
    case '16-9': return `${fs ? 'h-full aspect-[16/9]' : box} object-fill`
    case '4-3': return `${fs ? 'h-full aspect-[4/3]' : 'w-full aspect-[4/3] max-h-[78vh]'} object-fill`
    default: return fs ? 'w-auto h-full' : `${box} object-contain`
  }
})

// 「停在那儿了」：暂停且不是在加载/取址中。加载中另有转圈遮罩，两个叠一起只会打架。
// 自动播放被浏览器拦下时也是这个状态——那正是最需要一枚大播放键的时候
const pausedIdle = computed(() =>
  isVideoLoaded.value && !isPlaying.value && !isBuffering.value && !isResolvingUrl.value)
</script>

<style scoped>
/* iOS 上长按 <video> 会弹系统 callout（「存储视频/拷贝」），同样要让位给长按加速。
   安卓那边靠 contextmenu 的 preventDefault 拦（见 onPlayerContextMenu） */
video {
  -webkit-touch-callout: none;
}

/* 通用弹入：中央图标、HUD、锁定键共用 */
.pop-enter-active { transition: opacity .16s ease, transform .28s cubic-bezier(.2, 1.5, .4, 1); }
.pop-leave-active { transition: opacity .35s ease, transform .35s ease-out; }
.pop-enter-from { opacity: 0; transform: scale(.7); }
.pop-leave-to { opacity: 0; transform: scale(1.25); }

/* 顶部提示条从上方掉下来 */
.drop-enter-active { transition: opacity .18s ease, transform .3s cubic-bezier(.2, 1.5, .4, 1); }
.drop-leave-active { transition: opacity .18s ease, transform .18s ease-in; }
.drop-enter-from,
.drop-leave-to { opacity: 0; transform: translateY(-14px) scale(.9); }

/* 双击区整体淡入淡出（水波纹自己另有动画） */
.ripple-enter-active { transition: opacity .12s ease; }
.ripple-leave-active { transition: opacity .45s ease; }
.ripple-enter-from,
.ripple-leave-to { opacity: 0; }

/* 播放/暂停图标外圈炸开的一圈光晕 */
.blast { animation: blast .5s ease-out forwards; }
@keyframes blast {
  from { transform: scale(1); opacity: .55; }
  to   { transform: scale(1.9); opacity: 0; }
}

/* 双击落点的水波纹：从屏幕外缘涌进来再退回去 */
.ripple-blob { animation: blob .7s ease-out; }
@keyframes blob {
  0%   { transform: translateY(-50%) scale(.55); opacity: 0; }
  35%  { opacity: 1; }
  100% { transform: translateY(-50%) scale(1); opacity: 0; }
}

/* 三个箭头依次亮起（delay 由内联 style 给），长按提示的三角也复用 */
.chev { animation: chev 1s ease-in-out infinite; }
@keyframes chev {
  0%, 100% { opacity: .3; }
  45%      { opacity: 1; }
}

/* 秒数变化时弹一下：连点累加要看得出来又加了 5 秒 */
.secs-pop { animation: secs .3s cubic-bezier(.2, 1.6, .4, 1); }
@keyframes secs {
  from { transform: scale(1.5); }
  to   { transform: scale(1); }
}

/* .no-sb（隐藏滚动条）在 assets/css/motion.css 里，scoped 罩不到别的组件、抄一份漏一份 */

/* 锁定图标翻面 */
.lock-flip { animation: flip .35s ease-out; }
@keyframes flip {
  from { transform: rotateY(90deg) scale(.6); }
  to   { transform: rotateY(0) scale(1); }
}

/* 系统开了「减弱动效」就只留淡入淡出——这类循环动画对前庭敏感的人是实打实的不适 */
@media (prefers-reduced-motion: reduce) {
  .blast, .ripple-blob, .chev, .secs-pop, .lock-flip { animation: none; }
  .pop-enter-active, .pop-leave-active,
  .drop-enter-active, .drop-leave-active { transition: opacity .15s ease; }
  .pop-enter-from, .pop-leave-to, .drop-enter-from, .drop-leave-to { transform: none; }
}
</style>
