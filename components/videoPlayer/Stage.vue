<template>
  <!--
    **只有窄屏（手机）通栏铺满**：手机上 16:9 本来就不高，两侧再留白只会把它压得更小；
    而桌面窗口宽，铺满一整个 24 寸屏反而只剩一条黑带、下面的选集全被顶走，
    所以 sm 以上老老实实待在容器里（照旧带圆角）。
    通栏用 100vw + 居中位移，而不是 `-mx-4` 去抵容器 padding——后者要跟
    layouts/default.vue 的 px-4 严格对齐，那边一改就又露出白边。
    （100vw 比可用宽度多出的滚动条宽度由 layouts/default.vue 根上的 overflow-x-clip 兜住。）
  -->
  <div class="relative left-1/2 -translate-x-1/2 w-screen sm:left-auto sm:translate-x-0 sm:w-auto">
    <!--
      手势全部走 Pointer Events（鼠标/触摸同一套，见 useVideoGestures）：
      单击唤出控制栏、双击左右 ±5s、长按右侧临时 2x、横滑进度、全屏内竖滑音量/亮度。
      原来的 @click="togglePlay" 已移除——单击即暂停会让「只想看一眼进度」必然误触。
    -->
    <div
      ref="playerContainer"
      class="relative bg-black overflow-hidden group flex items-center justify-center select-none sm:rounded-xl"
      :class="[
        { 'cursor-none': isPlaying && !showControls },
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
      @contextmenu.prevent
    >
      <!--
        播放器已移除本地文件，只放网络地址，crossorigin 恒为 anonymous。
        非全屏也要**限高 78vh**：手机横屏时通栏宽度算出来的 16:9 高度（56.25vw）会超过视口短边，
        画面顶出屏幕、下面的信息行完全看不到。超过就由 max-h 接管，画面按 contain 居中
        （跟全屏一样左右留黑边），高度始终在一屏之内。
      -->
      <video
        ref="videoEl"
        :key="videoKey"
        class="max-w-full max-h-full"
        :class="isFullscreen ? 'w-auto h-full' : 'w-full aspect-video max-h-[78vh] object-contain'"
        :style="{
          filter: brightness === 1 ? undefined : `brightness(${brightness})`,
          // 恒非空：让 <video> 常驻合成层，forceRecomposite 才能只重画不闪（见 useVideoEngine）
          transform: videoTransform,
        }"
        crossorigin="anonymous"
        playsinline
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMetadata"
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
          <UIcon name="i-heroicons-arrow-path" class="w-12 h-12 text-white animate-spin" />
          <span class="text-white text-sm">
            <!-- resolveStage 带秒数（见 resolveWithUi）：不动的文案分不清「在跑」还是「卡死了」 -->
            {{ isResolvingUrl ? (resolveStage || '正在获取播放地址...') : isProbing ? '正在探测连接方式...' : '加载中...' }}
          </span>
        </div>
      </div>

      <!-- 顶部信息条：标题 + 第几集 + 选集，与底部控制栏同进同出 -->
      <VideoPlayerTopBar />

      <!--
        中央播放/暂停图标：切换时闪一下（外圈炸开光晕），**暂停期间则常驻**——
        暂停后画面是一张静止图，没有任何东西表明「是暂停了还是卡死了」。
        常驻的这枚可以直接点（自动播放被浏览器拦下时它就是唯一的入口）。
      -->
      <!-- 锁定态下不出：它带 data-no-gesture + @click，锁了还能暂停等于开关是坏的，
           而且它正好压在锁定态唯一的出口（左侧解锁键）上方 -->
      <Transition name="pop">
        <div
          v-if="!isLocked && (showPlayIcon || pausedIdle)"
          class="absolute inset-0 flex items-center justify-center"
          :class="pausedIdle ? 'cursor-pointer' : 'pointer-events-none'"
          data-no-gesture
          @click="pausedIdle && togglePlay()"
        >
          <!-- 整块可点而不只是那枚 80px 的圆：手机上要瞄准那个圈太难，「点了没反应」多半是没点中 -->
          <div class="relative">
            <span v-if="showPlayIcon" class="absolute inset-0 rounded-full bg-white/25 blast" />
            <div
              class="w-20 h-20 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center
                     ring-1 ring-white/20 transition-transform"
              :class="pausedIdle ? 'hover:scale-110 active:scale-95' : ''"
            >
              <UIcon :name="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'" class="w-10 h-10 text-white" />
            </div>
          </div>
        </div>
      </Transition>

      <!--
        双击 ±5s 的落点反馈：不给这一下反馈的话，跳了 5 秒和「没点到」看起来一模一样。
        半屏椭圆水波纹 + 三个依次亮起的箭头，读数在同侧连点时累加（5→10→15）。
      -->
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
                class="w-6 h-6 -mx-1 chev"
                :style="{ animationDelay: (i - 1) * 0.12 + 's' }"
              />
            </div>
            <!-- key 带上秒数：连点时数字换掉要重放一次弹跳，否则看不出又加了 5 秒 -->
            <span :key="seekFlash.secs" class="text-sm font-semibold tabular-nums secs-pop">
              {{ seekFlash.secs }} 秒
            </span>
          </div>
        </div>
      </Transition>

      <!-- 长按加速中的常驻提示：不显示的话松手前用户不知道自己触发了什么 -->
      <Transition name="drop">
        <!-- 往下让开顶部信息条，两个都在时不叠 -->
        <div v-if="boostActive" class="absolute top-20 left-1/2 -translate-x-1/2 pointer-events-none">
          <div class="flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-semibold
                      bg-gradient-to-r from-violet-600/90 to-fuchsia-500/90 backdrop-blur-sm
                      ring-1 ring-white/25 shadow-lg shadow-violet-900/40 boost-glow">
            <span class="flex">
              <UIcon
                v-for="i in 3"
                :key="i"
                name="i-heroicons-play-solid"
                class="w-3.5 h-3.5 -mx-0.5 chev"
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
          <div class="px-5 py-3.5 rounded-2xl bg-black/60 backdrop-blur-md text-white min-w-[160px]
                      flex flex-col items-center gap-2.5 ring-1 ring-white/15 shadow-2xl">
            <div class="flex items-center gap-2">
              <UIcon
                :name="gestureHud.kind === 'seek' ? 'i-heroicons-arrows-right-left'
                  : gestureHud.kind === 'volume' ? volumeIcon : 'i-heroicons-sun'"
                class="w-5 h-5 text-violet-300"
              />
              <span class="font-mono text-sm">{{ gestureHud.text }}</span>
              <span
                v-if="gestureHud.delta"
                :key="gestureHud.delta"
                class="text-sm font-mono font-semibold secs-pop"
                :class="gestureHud.delta.startsWith('+') ? 'text-emerald-300' : 'text-amber-300'"
              >{{ gestureHud.delta }}</span>
            </div>
            <div class="w-36 h-1.5 bg-white/20 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 shadow-[0_0_8px_rgba(167,139,250,.9)]"
                :style="{ width: (gestureHud.percent ?? 0) + '%' }"
              />
            </div>
          </div>
        </div>
      </Transition>

      <!--
        锁定按钮：锁上后它是唯一还能点的东西，所以点画面任意处都会让它露 3 秒。
        **未锁定时小窗里不出**：画面才 200 多 px 高，左侧垂直居中正好压在播放键上（实测截图）；
        而防误触本来就是全屏握持时才需要的事。
        **已锁定时任何尺寸都必须出**：锁定态下手势层全部 return、控制栏恒隐、快捷键也停，
        它是画面上唯一的出口。少了它，「全屏锁定 → 来电/系统手势退出全屏 → 变窄屏小窗」
        之后整个播放器点什么都没反应，只能刷新页面（实测踩过）。
        锁定态用半透明的紫→粉→蓝渐变，跟进度条/长按提示同一套色；
        原来那块实心琥珀在黑画面上跳得像个警告标（本意只是「状态不同」，不是「出事了」）。
      -->
      <Transition name="pop">
        <button
          v-if="isLocked ? showLockBtn : ((isFullscreen || !isNarrow) && (showControls || pausedIdle))"
          data-no-gesture
          class="absolute left-3 top-1/2 -translate-y-1/2 w-14 h-14 rounded-full text-white
                 flex items-center justify-center backdrop-blur-sm ring-1 transition-all duration-300
                 hover:scale-110 active:scale-95"
          :class="isLocked
            ? 'bg-gradient-to-br from-violet-400/60 via-fuchsia-400/45 to-sky-400/50 ring-white/25 shadow-lg shadow-violet-950/30'
            : 'bg-gradient-to-br from-white/15 to-white/5 ring-white/15 hover:from-white/25 hover:to-white/10'"
          :title="isLocked ? '解锁' : '锁定屏幕（屏蔽手势与控制栏）'"
          @click="toggleLock"
        >
          <!-- key 换掉 → 图标重新入场，锁上/解锁那一下能看见是「翻」过去的 -->
          <UIcon
            :key="String(isLocked)"
            :name="isLocked ? 'i-heroicons-lock-closed' : 'i-heroicons-lock-open'"
            class="w-6 h-6 lock-flip"
          />
        </button>
      </Transition>

      <VideoPlayerControlBar />

      <VideoPlayerEpisodeOverlay />
    </div>

    <!--
      画面下方的信息行：剧名 + 当前集 + 格式 + 连接策略（原来这些挤在卡片头里）。
      窄屏时画面通栏，这一行要自己补回 padding（否则贴到屏幕最左）；
      sm 以上画面已经在容器内，容器的 padding 就够了。
    -->
    <div class="px-4 sm:px-0 pt-3 flex items-center gap-2 flex-wrap text-sm">
      <span class="font-semibold truncate max-w-full">{{ playlistTitle || '放映厅' }}</span>
      <!--
        「第 N/M 集」是这一行最该显眼的东西，所以给实色徽标（其余都是 soft）。
        原来这里只有一枚写着集名的徽标，而且**挂着 `playlistTitle &&` 的条件** ——
        交接槽/直链进来的列表多半没有剧名，于是整页找不到任何「现在是第几集」的字样：
        画面里那份（TopBar）只在全屏出，选集面板要自己数格子。用户原话「不知道播到第多少集了」。
        集名单独一枚 soft 徽标：它常常就是「index.m3u8」这种没信息量的东西，不能拿它当集数用
      -->
      <UBadge v-if="playlist.length > 1" color="violet" variant="solid" size="xs">
        第 {{ currentIndex + 1 }}/{{ playlist.length }} 集
      </UBadge>
      <UBadge v-if="playlist.length > 1 && currentVideoName" color="violet" variant="soft" size="xs">
        {{ currentVideoName }}
      </UBadge>
      <UBadge :color="isHls ? 'violet' : 'blue'" variant="soft" size="xs">{{ isHls ? 'HLS/M3U8' : 'MP4' }}</UBadge>
      <!--
        整片 MP4 的「实测 / 需要」。单看一个速度读不出问题，只有跟「码率 × 倍速」对着看
        才知道是不是物理上喂不动（3x 要 3 倍码率的持续供给）。全屏里同一份数据画在顶栏（见 TopBar）。
      -->
      <UBadge
        v-if="!isHls && mp4AvgMbps > 0"
        :color="mp4Feedable ? 'green' : 'red'" variant="soft" size="xs"
        :title="`实测下载 ${formatSpeed(mp4Kbps)}；维持 ${playbackRate}x 需要 ${formatSpeed(mp4NeedKBps)}`
          + `（码率 ${mp4AvgMbps} Mbps × ${playbackRate}）`
          + (mp4Feedable ? '' : ' —— 喂不动，降低倍速或换线路')"
      >
        {{ formatSpeed(mp4Kbps) }} / 需 {{ formatSpeed(mp4NeedKBps) }}
      </UBadge>
      <UBadge v-if="hlsStats" color="green" variant="soft" size="xs">缓冲 {{ hlsStats.buffered.toFixed(1) }}s</UBadge>
      <!-- 预取线程：并发是自适应的（存货阶梯 / 缺口上限 / 闭环三方钳制），摆在这里才看得出
           「现在到底开了几条」。颜色跟统计面板同一套阈值：≥5 红、≥3 黄、其余绿。
           **0 也要显示**（灰色）：藏起来的话「停止预取了」和「这块没渲染」长得一样，
           而 0 线程恰恰是要判读的状态之一（已到预加载时长 → 停取） -->
      <UBadge
        v-if="isHls"
        :color="prefetchInfo.threads >= 5 ? 'red' : prefetchInfo.threads >= 3 ? 'amber'
          : prefetchInfo.threads ? 'green' : 'gray'"
        variant="soft"
        size="xs"
        :title="`预取并发（在途 ${prefetchInfo.pending} 片 / 缓存 ${prefetchInfo.cached} 片）`"
      >{{ prefetchInfo.threads }} 线程</UBadge>
      <!--
        聚合速度摆在线程数**旁边**：这两个数只有对着看才有意义。
        「线程多」本身不说明问题，「线程多但聚合速度没跟着涨」才是（每 IP 硬顶，加连接换不来带宽）；
        反过来「聚合速度是码率的好几倍却还在卡」说明带宽不是瓶颈、是摊薄——
        判读抗卡问题时这两条是同一句话的两半，分开摆就得来回翻统计面板（实测那次误判就是这么来的）。
        双通道真生效时标绿，跟统计面板同一套配色。
        **速度为 0 时照样渲染成「0 KB/s」，不整块消失**：缓存到量停取、或线程被压到 0 时聚合就是 0，
        徽标一消失读数就在「没在下」和「这块没了」之间没法区分，还会让旁边的线程徽标跳位置。
      -->
      <UBadge
        v-if="isHls"
        :color="dualChannel && !dualChannelUnavailable ? 'green' : 'gray'"
        variant="soft"
        size="xs"
        :title="`聚合下载速度 ≈ 单连接 ${formatSpeed(strategy.perConnKBps)} × ${strategy.targetConn} 并发`
          + `（${aggregateMbps} Mbps，视频码率 ${strategy.segMbps} Mbps）`"
      >{{ formatSpeed(aggregateKBps) }}</UBadge>
      <!-- 回解析页换线路：播放器手上只有一条线路的列表，换线路只能回去 -->
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

      <!--
        去源站看这一集：换线路解决不了的事（片源本身有问题、想看源站的评论/更新情况、
        或者干脆用站点自己的播放器）只能回源站。用 <a>（UButton 的 :to + external）
        而不是 window.open：后者只能在用户手势的调用栈里同步调，还会被拦截器吃掉。
        **文案要跟着精度走**——不精确到当前集时说成「当前集」就是骗人。
      -->
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

      <!-- 连接策略点一下展开页面下方那节设置（showAdvancedProxy 一个 ref 两处用） -->
      <UBadge
        :color="isProbing ? 'gray' : 'sky'" variant="soft" size="xs"
        class="cursor-pointer"
        title="点击展开连接与防盗链设置（含可达性探测矩阵）"
        @click="showAdvancedProxy = !showAdvancedProxy"
      >
        {{ isProbing ? '探测中…' : strategyLabel }}
      </UBadge>
    </div>
  </div>
</template>

<script setup lang="ts">
// 控制栏那一整块（播放/上下集/进度/倍速/全屏）已经拆去 VideoPlayerControlBar，
// 它自己 useVideoPlayerCtx()，所以这里不再解构那些键
const {
  videoEl, playerContainer, videoKey,
  isHls, isPlaying, isBuffering, isResolvingUrl, resolveStage, isProbing, isFullscreen, isVideoLoaded,
  showControls,  showPlayIcon,
  currentTime, duration,
  hlsStats, prefetchInfo, playlist, playlistTitle, currentIndex, strategyLabel, showAdvancedProxy,
  // 聚合速度那枚徽标要的：实测策略快照 + 两个换算值 + 双通道状态（配色跟统计面板一致）
  strategy, aggregateKBps, aggregateMbps, dualChannel, dualChannelUnavailable,
  playlistSource, backToParseSource, currentSourceLink,
  // 整片 MP4 的速度徽标（与全屏顶栏那枚同源）
  mp4AvgMbps, mp4Kbps, playbackRate,
  // 选集按钮在顶部信息条里（VideoPlayerTopBar），这里只留抽屉本身要用的状态
  currentVideoName, volumeIcon,
  togglePlay,
  // 容器的 mousemove 走手势层的 onMouseMove（要滤掉触摸补发的兼容鼠标事件），不直接用 handleMouseMove
  hideControlsDelayed,
  // 手势层（useVideoGestures）
  isLocked, showLockBtn, toggleLock, brightness, gestureHud, seekFlash, touchAction,
  videoTransform,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseMove, onClick, onDblClick,
  boostActive, boostRate,
  onTimeUpdate, onLoadedMetadata, onDurationChange, onProgress, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onPause, onVolumeChange, onVideoError,
} = useVideoPlayerCtx()

// 维持**当前倍速**需要多少 KB/s。倍速是乘上去的：3x 要 3 倍码率的持续供给
const mp4NeedKBps = computed(() => (mp4AvgMbps.value * 1e6 / 8 / 1024) * playbackRate.value)
// 还没测出速率时不先扣红帽子（起播头几秒 mp4Kbps 恒为 0）
const mp4Feedable = computed(() => !mp4Kbps.value || mp4Kbps.value >= mp4NeedKBps.value)

// 锁定按钮「未锁定时小窗不出」要用它。**曾经漏了这行声明**：模板里读不存在的属性只是一条
// Vue warn，取值恒 undefined（= 假），于是那个条件悄悄变成「任何尺寸都显示」，界面上看不出错
const isNarrow = useNarrowScreen()

// 「停在那儿了」：暂停且不是在加载/取址中。加载中另有转圈遮罩，两个叠一起只会打架。
// 自动播放被浏览器拦下时也是这个状态——那正是最需要一枚大播放键的时候。
const pausedIdle = computed(() =>
  isVideoLoaded.value && !isPlaying.value && !isBuffering.value && !isResolvingUrl.value)
</script>

<!--
  这些过渡类名以前只写在 pages/video-player.vue 的 scoped 样式里，
  而元素在本组件内——父组件的 scoped 罩不到子组件内部，等于一直没生效（淡入淡出全是硬切）。
  一律就近放在用它的组件里。
-->
<style scoped>
/* 控制栏：起落带一点缓动过冲，比线性 ease 显得「托」得住 */
.slide-up-enter-active { transition: opacity .25s ease, transform .32s cubic-bezier(.22, 1.4, .36, 1); }
.slide-up-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.slide-up-enter-from,
.slide-up-leave-to { opacity: 0; transform: translateY(24px); }

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

/* 长按提示条的呼吸光晕 */
.boost-glow { animation: glow 1.4s ease-in-out infinite; }
@keyframes glow {
  0%, 100% { box-shadow: 0 0 14px rgba(167, 139, 250, .45); }
  50%      { box-shadow: 0 0 26px rgba(217, 70, 239, .75); }
}

/*
  菜单里不显示滚动条：那条灰槽是画面上最扎眼的一块，而且它比菜单本身还实
  （原生滚动条不吃 backdrop-blur，也不受透明度影响）。打开即定位到当前档位（见 speedMenuList），
  真要翻仍然能滑，只是看不见轨道。
*/
.no-sb { scrollbar-width: none; -ms-overflow-style: none; }
.no-sb::-webkit-scrollbar { display: none; }

/* 锁定图标翻面 */
.lock-flip { animation: flip .35s ease-out; }
@keyframes flip {
  from { transform: rotateY(90deg) scale(.6); }
  to   { transform: rotateY(0) scale(1); }
}

/* 音量滑块的白色圆钮（同样从页面挪过来的：写在父组件里对这里的 input 无效） */
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 6px rgba(167, 139, 250, .9);
}

/* 系统开了「减弱动效」就只留淡入淡出——这类循环动画对前庭敏感的人是实打实的不适 */
@media (prefers-reduced-motion: reduce) {
  .blast, .ripple-blob, .chev, .secs-pop, .boost-glow, .lock-flip { animation: none; }
  .slide-up-enter-active, .slide-up-leave-active,
  .pop-enter-active, .pop-leave-active,
  .drop-enter-active, .drop-leave-active { transition: opacity .15s ease; }
  .pop-enter-from, .pop-leave-to, .drop-enter-from, .drop-leave-to { transform: none; }
}
</style>
