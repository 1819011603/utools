<template>
  <!--
    菜单本体。`data-ctx-menu` 给「点外面就关」用来认自己人；`data-no-gesture` 让手势层整块放过
    （漏挂的代价见 useVideoGestures 那条注释：点在菜单上会被当成画面双击，直接被拽进全屏）。
    自己也要 `@contextmenu.prevent`——在菜单上再右键一下不该冒出浏览器原生菜单。
  -->
  <Transition name="ctx">
    <div
      v-if="ctxMenuAt"
      data-ctx-menu
      data-no-gesture
      class="absolute z-40 w-56 rounded-xl overflow-hidden text-sm text-white
             bg-black/80 backdrop-blur-md ring-1 ring-white/15 shadow-2xl"
      :style="{ left: ctxMenuAt.x + 'px', top: ctxMenuAt.y + 'px' }"
      @contextmenu.prevent
    >
      <!--
        播放速度排在最前：右键菜单里它是唯一「看片当下高频要改」的东西（其余都是查看类）。
        档位表复用 controls.rateOptions，跟控制栏那份倍速菜单和 </> 快捷键同一个来源——
        写死一份的话开了「超快倍速」这里就少几档（踩过同类问题，见 useVideoUiControls）。
        绑 desiredRate 不是 playbackRate：后者是自动最佳倍速算出来的实际值，
        高亮跟着它跳会让人以为自己没点中。
      -->
      <div class="px-3 pt-2.5 pb-2 border-b border-white/10">
        <div class="text-[11px] text-white/45 mb-1.5">播放速度</div>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="rate in rateOptions"
            :key="rate"
            class="px-1.5 py-0.5 rounded text-xs tabular-nums transition-colors"
            :class="desiredRate === rate
              ? 'bg-gradient-to-r from-rose-400/50 to-violet-400/50 font-semibold'
              : 'text-white/70 hover:bg-white/10 hover:text-white'"
            @click="setPlaybackRate(rate)"
          >{{ rate === 1 ? '正常' : rate + 'x' }}</button>
        </div>
      </div>

      <!--
        媒体信息：点一下开/关那块浮层，菜单本身跟着收起（菜单挡在面板左上角）。
        这一项就是「解析页写 1080p、播放器写 808p」那类疑问的落脚处，所以给它最靠上的位置。
      -->
      <button class="row" @click="toggleMediaInfo">
        <UIcon name="i-heroicons-information-circle" class="w-4 h-4 text-violet-300" />
        <span class="flex-1 text-left">媒体信息</span>
        <UIcon
          v-if="showMediaInfo"
          name="i-heroicons-check"
          class="w-4 h-4 text-emerald-300"
        />
      </button>

      <!-- 复制地址：按需取址的站点每集都是现签地址，想拿去 ffprobe / curl 验一把只能从这儿取 -->
      <button class="row" :disabled="!mediaInfo.url" @click="copyVideoUrl">
        <UIcon
          :name="copyState === 'ok' ? 'i-heroicons-check-circle'
            : copyState === 'fail' ? 'i-heroicons-exclamation-triangle' : 'i-heroicons-clipboard-document'"
          class="w-4 h-4"
          :class="copyState === 'ok' ? 'text-emerald-300' : copyState === 'fail' ? 'text-amber-300' : 'text-white/60'"
        />
        <span class="flex-1 text-left">
          {{ copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败（需 https）' : '复制视频地址' }}
        </span>
      </button>

      <!-- 画中画的快捷键是 I，没人猜得到；这里给它一个看得见的入口 -->
      <button v-if="supportsPiP" class="row" @click="pickPiP">
        <UIcon name="i-heroicons-square-2-stack" class="w-4 h-4 text-white/60" />
        <span class="flex-1 text-left">画中画</span>
        <span class="text-[11px] text-white/35">I</span>
      </button>

      <button class="row" @click="pickFullscreen">
        <UIcon
          :name="isFullscreen ? 'i-heroicons-arrows-pointing-in' : 'i-heroicons-arrows-pointing-out'"
          class="w-4 h-4 text-white/60"
        />
        <span class="flex-1 text-left">{{ isFullscreen ? '退出全屏' : '全屏' }}</span>
        <span class="text-[11px] text-white/35">F</span>
      </button>

      <button class="row border-t border-white/10 text-white/60" @click="closeContextMenu">
        <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
        <span class="flex-1 text-left">关闭</span>
        <span class="text-[11px] text-white/30">Esc</span>
      </button>
    </div>
  </Transition>

  <!--
    信息面板挂在这里而不是 Stage：它只有右键菜单一个入口，两者由同一份状态驱动，
    而 Stage 已经贴着 500 行上限（见 CLAUDE.md），多一个标签不如在这一层收口。
  -->
  <VideoPlayerMediaInfo />
</template>

<script setup lang="ts">
const {
  ctxMenuAt, showMediaInfo, mediaInfo, copyState, closeContextMenu, copyVideoUrl,
  rateOptions, desiredRate, setPlaybackRate,
  supportsPiP, togglePiP, isFullscreen, toggleFullscreen,
} = useVideoPlayerCtx()

// 开面板就收菜单（菜单正压在面板左上角），关面板则留着菜单——那一下多半是想再点别的
const toggleMediaInfo = () => {
  showMediaInfo.value = !showMediaInfo.value
  if (showMediaInfo.value) closeContextMenu()
}

// 这两项都是「点完就该收起」：全屏/画中画一切换，菜单留在原坐标上就成了错位的浮块
const pickPiP = () => { closeContextMenu(); togglePiP() }
const pickFullscreen = () => { closeContextMenu(); void toggleFullscreen() }
</script>

<style scoped>
/*
  菜单行的公用样式。写成 @apply 而不是每个 button 复制一串 class：
  这里有五行，任何一处间距/hover 改动漏一行都会看得出来。
*/
.row {
  @apply w-full flex items-center gap-2.5 px-3 py-2 transition-colors;
}
.row:hover:not(:disabled) {
  @apply bg-white/10;
}
.row:disabled {
  @apply opacity-40 cursor-not-allowed;
}

/* 从落点方向弹出来一点点：整块淡入会让人看不出它是从鼠标那儿长出来的 */
.ctx-enter-active { transition: opacity .12s ease, transform .18s cubic-bezier(.2, 1.4, .4, 1); }
.ctx-leave-active { transition: opacity .12s ease; }
.ctx-enter-from { opacity: 0; transform: scale(.92); transform-origin: top left; }
.ctx-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .ctx-enter-active { transition: opacity .12s ease; }
  .ctx-enter-from { transform: none; }
}
</style>
