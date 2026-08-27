<template>
  <div class="space-y-6">
    <!-- 起播后把大标题收掉：手机上它白占一屏，而画面就在下面。
         这一页不出站点的品牌栏（画面要置顶），所以未起播时自己补一枚回首页的入口 -->
    <div v-if="!isVideoLoaded" class="pt-6 flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">放映厅</h1>
        <p class="text-gray-500 dark:text-gray-400 mt-1 text-sm">M3U8 / MP4，多线并发预取，自动挑连接方式</p>
      </div>
      <UButton to="/" variant="soft" color="gray" size="xs" icon="i-heroicons-home">工具首页</UButton>
    </div>

    <!-- 播放器排在最前面：进来第一眼要看到的是画面，而不是那个只在换片时才用一次的输入框 -->
    <VideoPlayerStage v-if="isVideoLoaded" />

    <!-- 左侧悬浮抽屉：收藏 / 播放历史 / 收藏影片 / 换源。它自己是 fixed 的，
         摆在这里只是为了让「播放器相关」的东西在模板里挨着 -->
    <LibraryDock />

    <!-- 「上次看到第 N 集」。紧贴播放器下面，它要回答的是「我现在该从哪儿看」 -->
    <VideoPlayerResumeBar v-if="isVideoLoaded" />

    <!-- 起播后视频源默认收起：地址栏一贴就不用再看它，而它占着播放器正下方最好的位置 -->
    <VideoPlayerCollapseCard
      v-model="openSource"
      title="视频源"
      icon="i-heroicons-link"
      icon-class="text-rose-400"
      :hint="playlist.length > 1 ? `播放列表 ${currentIndex + 1}/${playlist.length}` : ''"
    >
      <VideoPlayerSourceCard />
    </VideoPlayerCollapseCard>

    <!-- 走 ?parseUrl= 进来时整份列表要现场解析，慢的站点好几秒。这期间 Stage 还没渲染，
         它内部那个遮罩一个字也看不到，页面上就是一片空白 -->
    <UCard v-if="isResolvingUrl && !isVideoLoaded">
      <div class="flex items-center gap-3">
        <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-violet-500 animate-spin shrink-0" />
        <div class="min-w-0">
          <p class="font-medium text-gray-900 dark:text-white">正在解析播放列表…</p>
          <p class="text-sm text-gray-500 dark:text-gray-400 truncate">{{ resolveStage || '正在获取页面…' }}</p>
        </div>
      </div>
    </UCard>

    <!-- 下半部分一律默认折叠：这几块都是「出问题才看」或「设一次就不动」的，
         摊开来会把播放器和选集挤到屏幕外 -->
    <div class="space-y-3">
      <VideoPlayerCollapseCard
        v-if="playlist.length > 1"
        v-model="openPlaylist"
        title="选集 / 播放列表"
        icon="i-heroicons-queue-list"
        icon-class="text-violet-500"
        :hint="`共 ${playlist.length} 集 · 当前第 ${currentIndex + 1} 集`"
      >
        <VideoPlayerPlaylistPanel />
      </VideoPlayerCollapseCard>

      <VideoPlayerCollapseCard
        v-model="showAdvancedProxy"
        title="连接与防盗链"
        icon="i-heroicons-signal"
        icon-class="text-sky-500"
        :hint="isVideoLoaded ? strategyLabel : ''"
      >
        <VideoPlayerConnSettings />
      </VideoPlayerCollapseCard>

      <VideoPlayerCollapseCard
        v-if="isHls"
        v-model="openHls"
        title="HLS 配置与统计"
        icon="i-heroicons-cog-6-tooth"
        icon-class="text-gray-500"
      >
        <VideoPlayerHlsSettings />
      </VideoPlayerCollapseCard>

      <VideoPlayerCollapseCard
        v-if="isVideoLoaded && !isHls"
        v-model="openPreload"
        title="MP4 预加载"
        icon="i-heroicons-arrow-down-tray"
        icon-class="text-gray-500"
      >
        <VideoPlayerPreloadSettings />
      </VideoPlayerCollapseCard>

      <VideoPlayerCollapseCard
        v-model="openKeys"
        title="快捷键与手势"
        icon="i-heroicons-command-line"
        icon-class="text-amber-500"
        hint="双击左右 ±5s · 长按右侧加速 · 滑动调进度/音量"
      >
        <VideoPlayerShortcuts />
      </VideoPlayerCollapseCard>
    </div>

    <UAlert
      v-if="errorMessage"
      color="red"
      variant="soft"
      icon="i-heroicons-exclamation-triangle"
      :title="errorMessage"
      :close-button="{ icon: 'i-heroicons-x-mark', color: 'red', variant: 'link' }"
      @close="errorMessage = ''"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * M3U8/MP4 播放器。本页只做三件事：建控制器、provide 给子组件、接生命周期。
 * 全部业务逻辑在 composables/videoPlayer/ 里按功能分模块（见 CLAUDE.md「视频播放器」一节）。
 */
const ctx = useVideoPlayerController()
provide(VIDEO_PLAYER_KEY, ctx)

const {
  isVideoLoaded, isHls, errorMessage, isResolvingUrl, resolveStage,
  showAdvancedProxy, strategyLabel, playlist, currentIndex,
} = ctx

// 视频源：还没起播时展开（那时它是唯一有用的东西），起播后收起
const openSource = ref(!ctx.isVideoLoaded.value)
watch(isVideoLoaded, v => { if (v) openSource.value = false })

const openPlaylist = ref(false)
const openHls = ref(false)
const openPreload = ref(false)
const openKeys = ref(false)

onMounted(() => ctx.mount())
onUnmounted(() => ctx.unmount())
</script>

<!-- 本页没有自己的样式：过渡类名和滑块皮肤都在 components/videoPlayer/ 里，
     scoped 样式必须跟元素同一个组件（父组件罩不到子组件内部） -->
