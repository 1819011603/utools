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

      <Transition name="slide-up">
        <div
          v-show="controlsVisible"
          data-no-gesture
          class="absolute z-10 bottom-0 left-0 right-0 pointer-events-none
                 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2.5 pb-2.5 pt-8 sm:px-4 sm:pb-4 sm:pt-12"
          @click.stop
          @pointerdown="keepControlsAlive"
          @pointerup="keepControlsAlive"
        >
          <!--
            腾讯视频移动端那套排布：竖屏时进度条**内联在按钮行里**（播放 | 时间 | 进度 | 倍速 | 全屏），
            宽屏才让它独占上面一行。原来固定「进度条一行 + 按钮一行」，
            窄屏上十来个控件挤成一坨还互相压字（实测截图里时间和齿轮叠在一起）。
            一行流式布局 + order 换位，两种屏幕共用同一个 progressBar ref。
          -->
          <!--
            `pointer-events-auto` 只给这一行：外层那圈渐变+上留白在小窗里有几十 px 高，
            让它吃事件的话，画面中间的双击（播放/暂停）全被它接走了——表现就是「小窗点不动」。
            `flex-nowrap`：窄屏一换行就摞成两排糊在画面中间（实测截图），宁可各项收小。
          -->
          <div class="pointer-events-auto flex items-center gap-1 flex-nowrap sm:gap-1.5 sm:flex-wrap">
            <button
              class="order-1 p-1 sm:p-1.5 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all shrink-0"
              @click="togglePlay"
            >
              <UIcon :name="isPlaying ? 'i-heroicons-pause-solid' : 'i-heroicons-play-solid'" class="w-6 h-6 sm:w-7 sm:h-7" />
            </button>

            <!--
              **窄屏也要有「上一集」**。原来是 `hidden sm:block`（竖屏一行放不下就砍它），
              代价是手机上根本没法往回切集，而且更坑的是：用户会去点「本该有这枚按钮的位置」，
              那儿是画面本身 → 连点两下正好被手势层判成双击 → 整个进了全屏
              （用户报「小屏点上下集就全屏了，没法切集」，根因就是这枚按钮不在）。
              一行放得下：窄屏本来就把音量整组、下载、画中画都收了。

              两个按钮在切集期间换成转圈图标：切集要等取址/探测/建流，画面中央那个转圈
              离手指很远，按钮自己不给反馈的话看着就像「点了没用」（于是用户又点一下）。
              **但绝不能 `:disabled`**：Chrome 不给 disabled 控件派发鼠标事件，那一下会落到
              容器上被手势层接走 → 又是「点切集结果全屏了」。切集中照样可点，
              交给 playByIndex 的 latest-wins 排队处理（连点两下就是跳两集，本来就该这样）。
            -->
            <button
              v-if="playlist.length > 1"
              class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
              :class="hasPrev ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
              :disabled="!hasPrev"
              title="上一集（P）"
              @click="playPrev"
            >
              <UIcon
                :name="isSwitching ? 'i-heroicons-arrow-path' : 'i-heroicons-backward-solid'"
                class="w-5 h-5 sm:w-6 sm:h-6" :class="{ 'animate-spin': isSwitching }"
              />
            </button>
            <!--
              hover / 手指按下就开始备下一集（见 useVideoPrewarm.prewarmNextNow）：
              比任何时间窗口都准的意图信号，能把「中途手动点下一集」从全冷路径救回来。
              pointerenter 覆盖鼠标与触摸笔，touchstart 补上手指（触摸端没有真正的 hover）。
            -->
            <button
              v-if="playlist.length > 1"
              class="order-1 p-1 sm:p-1.5 rounded-lg text-white transition-all shrink-0"
              :class="hasNext ? 'hover:bg-white/15 active:scale-90' : 'opacity-40 cursor-not-allowed'"
              :disabled="!hasNext"
              title="下一集（N）"
              @pointerenter="hasNext && prewarmNextNow()"
              @touchstart.passive="hasNext && prewarmNextNow()"
              @click="playNext"
            >
              <UIcon
                :name="isSwitching ? 'i-heroicons-arrow-path' : 'i-heroicons-forward-solid'"
                class="w-5 h-5 sm:w-6 sm:h-6" :class="{ 'animate-spin': isSwitching }"
              />
            </button>

            <!-- 手机上没有 hover，滑条永远展不开；音量有硬件键和竖滑手势，整组藏起来腾地方 -->
            <div class="order-1 hidden sm:flex items-center gap-2 group/volume ml-1 shrink-0">
              <button class="p-1.5 rounded-lg text-white hover:bg-white/15 transition-all" @click="toggleMute">
                <UIcon :name="volumeIcon" class="w-6 h-6" />
              </button>
              <div class="w-0 group-hover/volume:w-20 overflow-hidden transition-all duration-200">
                <input
                  type="range" min="0" max="1" step="0.05"
                  :value="volume"
                  class="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer accent-violet-500"
                  @input="setVolume"
                />
              </div>
            </div>

            <span class="order-2 text-white text-[11px] sm:text-sm font-mono tabular-nums whitespace-nowrap shrink-0">
              {{ formatTime(currentTime) }}<span class="text-white/50"> / {{ formatTime(duration) }}</span>
            </span>

            <!-- 进度条：窄屏内联占据中间空档，宽屏 order-first + w-full 自己占一行 -->
            <div
              ref="progressBar"
              class="order-3 flex-1 min-w-[64px] sm:order-first sm:w-full sm:flex-none sm:mb-1.5
                     relative h-1 sm:h-1.5 bg-white/25 rounded-full cursor-pointer group/progress touch-none"
              @pointerdown="startSeek"
              @mousemove="updateHoverTime"
              @mouseleave="hoverTime = null"
            >
              <div class="absolute h-full bg-white/35 rounded-full" :style="{ width: bufferedPercent + '%' }" />
              <div
                class="absolute h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400
                       shadow-[0_0_8px_rgba(167,139,250,.7)]"
                :style="{ width: progressPercent + '%' }"
              />
              <!-- 圆钮常显（腾讯也是常显）：触摸端没有 hover，藏起来就等于没有抓手 -->
              <div
                class="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 bg-white rounded-full shadow-lg
                       ring-2 ring-violet-400/50 transition-transform group-hover/progress:scale-125"
                :style="{ left: `calc(${progressPercent}% - 7px)` }"
              />
              <div
                v-if="hoverTime !== null"
                class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2 pointer-events-none"
                :style="{ left: hoverPercent + '%' }"
              >
                {{ formatTime(hoverTime) }}
              </div>
              <div
                v-else-if="seekPreviewTime !== null"
                class="absolute -top-8 px-2 py-1 bg-black/80 text-white text-xs rounded transform -translate-x-1/2"
                :style="{ left: seekPreviewPercent + '%' }"
              >
                {{ formatTime(seekPreviewTime) }}
              </div>
            </div>

            <!-- 右侧一组：宽屏时靠 ml-auto 推到最右（进度条独占上一行后这行需要自己撑开） -->
            <div class="order-4 flex items-center gap-0.5 shrink-0 sm:ml-auto">
              <div ref="speedMenuRef" class="relative">
                <button
                  class="px-1.5 sm:px-2 py-1.5 rounded-lg text-white hover:bg-white/15 transition-all text-xs sm:text-sm font-semibold whitespace-nowrap"
                  :title="autoBestRate
                    ? `自动最佳倍速：上限 ${autoRateCap}x，当前带宽下实际 ${playbackRate}x` : `倍速 ${playbackRate}x`"
                  @click="showSpeedMenu = !showSpeedMenu"
                >
                  <!-- 「/上限」只要开着自动就常显：早先加了 playbackRate !== autoRateCap 的条件，
                       生效倍速一爬到上限后缀就消失，控制栏上反而看不出自动还开着、上限是几 -->
                  {{ playbackRate }}x<span v-if="autoBestRate" class="text-white/50">/{{ autoRateCap }}</span>
                </button>
                <Transition name="fade">
                  <!--
                       z-30：菜单要盖过顶部信息条（z-[5]）和控制栏自己。原来没设 z，
                       菜单往上展开时最上面那几档（3.0x）正好落在顶部信息条底下，点不着。
                       再加高度上限 + 自身滚动：画面只有 200 多 px 高时，八个档位一屏放不下。
                  -->
                  <div
                    v-if="showSpeedMenu"
                    ref="speedMenuList"
                    class="no-sb absolute z-30 bottom-full right-0 mb-2 rounded-xl overflow-y-auto
                           min-w-[88px] max-h-[min(60vh,240px)]
                           bg-gradient-to-br from-white/10 via-rose-200/10 to-violet-300/15
                           backdrop-blur-md ring-1 ring-white/20 shadow-xl shadow-violet-950/20"
                  >
                    <button
                      v-for="rate in PLAYBACK_RATES"
                      :key="rate"
                      :data-rate="rate"
                      class="block w-full px-5 py-2.5 text-sm text-white text-center transition-colors
                             hover:bg-white/15 drop-shadow-[0_1px_2px_rgba(0,0,0,.8)]"
                      :class="{ 'bg-gradient-to-r from-rose-400/45 to-violet-400/45 font-semibold': desiredRate === rate }"
                      @click="setPlaybackRate(rate)"
                    >
                      {{ rate }}x
                    </button>
                  </div>
                </Transition>
              </div>

              <!-- 自动全屏 / 自动倍速 / 跳过片头片尾：全是看片当下才改的，放这儿手不用离开画面 -->
              <VideoPlayerSettingsMenu />

              <button v-if="supportsPiP && !isNarrow" class="p-1.5 rounded-lg text-white hover:bg-white/15 transition-all" title="画中画" @click="togglePiP">
                <UIcon name="i-heroicons-rectangle-stack" class="w-6 h-6" />
              </button>

              <button class="p-1.5 rounded-lg text-white hover:bg-white/15 active:scale-90 transition-all" title="全屏" @click="toggleFullscreen">
                <UIcon
                  :name="isFullscreen ? 'i-heroicons-arrows-pointing-in' : 'i-heroicons-arrows-pointing-out'"
                  class="w-6 h-6 sm:w-7 sm:h-7"
                />
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <VideoPlayerEpisodeOverlay />
    </div>

    <!--
      画面下方的信息行：剧名 + 当前集 + 格式 + 连接策略（原来这些挤在卡片头里）。
      窄屏时画面通栏，这一行要自己补回 padding（否则贴到屏幕最左）；
      sm 以上画面已经在容器内，容器的 padding 就够了。
    -->
    <div class="px-4 sm:px-0 pt-3 flex items-center gap-2 flex-wrap text-sm">
      <span class="font-semibold truncate max-w-full">{{ playlistTitle || '放映厅' }}</span>
      <UBadge v-if="playlistTitle && playlist.length > 1" color="violet" variant="soft" size="xs">
        {{ currentVideoName }}
      </UBadge>
      <UBadge :color="isHls ? 'violet' : 'blue'" variant="soft" size="xs">{{ isHls ? 'HLS/M3U8' : 'MP4' }}</UBadge>
      <UBadge v-if="hlsStats" color="green" variant="soft" size="xs">缓冲 {{ hlsStats.buffered.toFixed(1) }}s</UBadge>
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
import { onClickOutside } from '@vueuse/core'

const {
  videoEl, playerContainer, progressBar, speedMenuRef, videoKey, videoUrl,
  isHls, isPlaying, isBuffering, isResolvingUrl, resolveStage, isProbing, isFullscreen, isVideoLoaded,
  showControls, showPlayIcon, showSpeedMenu,
  currentTime, duration, volume, playbackRate, desiredRate, autoBestRate, autoRateCap,
  progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, hoverTime, hoverPercent,
  hlsStats, playlist, playlistTitle, hasPrev, hasNext, strategyLabel, showAdvancedProxy,
  playlistSource, backToParseSource,
  // 选集按钮在顶部信息条里（VideoPlayerTopBar），这里只留抽屉本身要用的状态
  currentVideoName, volumeIcon, supportsPiP,
  togglePlay, skip, startSeek, updateHoverTime, setVolume, toggleMute, setPlaybackRate,
  // 容器的 mousemove 走手势层的 onMouseMove（要滤掉触摸补发的兼容鼠标事件），不直接用 handleMouseMove
  toggleFullscreen, togglePiP, hideControlsDelayed, keepControlsAlive,
  // 手势层（useVideoGestures）
  isLocked, showLockBtn, toggleLock, brightness, gestureHud, seekFlash, touchAction, controlsVisible,
  videoTransform,
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseMove, onClick, onDblClick,
  boostActive, boostRate,
  playPrev, playNext, isSwitching, prewarmNextNow,
  onTimeUpdate, onLoadedMetadata, onLoadedData, onVideoEnded, onWaiting, onCanPlay,
  onCanPlayThrough, onSeeking, onSeeked, onPlaying, onPause, onVolumeChange, onVideoError,
} = useVideoPlayerCtx()

// 倍速菜单点击外部关闭
onClickOutside(speedMenuRef, () => { showSpeedMenu.value = false })

/**
 * 打开倍速菜单时把当前档位滚到视野中间。
 *
 * 八个档位一屏放不下（画面只有 200 多 px 高时更挤），而常用的高倍速正好在列表尾部——
 * 不定位的话每次打开都停在 0.5x，用户得先滑一段才看得见自己选的是哪个。
 *
 * 用 scrollTop 手算而不是 `scrollIntoView({ block: 'center' })`：后者会顺带滚动**外层**的
 * 滚动容器（页面/全屏层），表现是菜单一开画面自己往上跳一下。
 */
const speedMenuList = ref<HTMLElement | null>(null)
watch(showSpeedMenu, async (open) => {
  if (!open) return
  await nextTick()
  const box = speedMenuList.value
  const item = box?.querySelector<HTMLElement>(`[data-rate="${desiredRate.value}"]`)
  if (!box || !item) return
  box.scrollTop = item.offsetTop - (box.clientHeight - item.offsetHeight) / 2
})

// 「停在那儿了」：暂停且不是在加载/取址中。加载中另有转圈遮罩，两个叠一起只会打架。
// 自动播放被浏览器拦下时也是这个状态——那正是最需要一枚大播放键的时候。
// 窄屏（手机竖屏）：控制栏塞不下这么多图标，画中画这类低频项直接不渲染。
// 用 matchMedia 而不是 Tailwind 的 hidden：这两块是 <template>，没有能挂 class 的元素
const isNarrow = ref(false)
onMounted(() => {
  const mq = window.matchMedia('(max-width: 639px)')
  isNarrow.value = mq.matches
  mq.addEventListener('change', e => { isNarrow.value = e.matches })
})

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
