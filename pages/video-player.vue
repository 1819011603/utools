<template>
  <div class="space-y-6">
    <!-- 起播后把大标题收掉：手机上它白占一屏，而画面就在下面 -->
    <div v-if="!isVideoLoaded" class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">放映厅</h1>
        <p class="text-gray-500 dark:text-gray-400 mt-1 text-sm">M3U8 / MP4，多线并发预取，自动挑连接方式</p>
      </div>
    </div>

    <!--
      播放器排在最前面（腾讯视频移动端就是这样）：进来第一眼要看到的是画面，
      而不是那个只在换片时才用一次的地址输入框。
    -->
    <VideoPlayerStage v-if="isVideoLoaded" />

    <!--
      起播后视频源默认收起：地址栏一贴就不用再看它，而它占着播放器正下方最好的位置。
      还没起播时（v-model 初值）默认展开——那时它是页面上唯一有用的东西。
    -->
    <VideoPlayerCollapseCard
      v-model="openSource"
      title="视频源"
      icon="i-heroicons-link"
      icon-class="text-rose-400"
      :hint="playlist.length > 1 ? `播放列表 ${currentIndex + 1}/${playlist.length}` : ''"
    >
      <VideoPlayerSourceCard />
    </VideoPlayerCollapseCard>

    <!--
      走 ?parseUrl= 分享链接进来时，整份播放列表要现场解析，慢的站点好几秒。
      这期间 Stage 还没渲染（它 v-if="isVideoLoaded"），它内部那个「正在获取播放地址」
      的遮罩一个字也看不到，页面上就是一片空白，用户只会以为链接是坏的。
    -->
    <UCard v-if="isResolvingUrl && !isVideoLoaded">
      <div class="flex items-center gap-3">
        <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 text-violet-500 animate-spin shrink-0" />
        <div class="min-w-0">
          <p class="font-medium text-gray-900 dark:text-white">正在解析播放列表…</p>
          <p class="text-sm text-gray-500 dark:text-gray-400 truncate">{{ resolveStage || '正在获取页面…' }}</p>
        </div>
      </div>
    </UCard>

    <!--
      下半部分一律默认折叠：这几块都是「出问题才看」或「设一次就不动」的东西，
      摊开来会把播放器和选集挤到屏幕外——手机上尤其明显（要滑三屏才看得到第 2 集）。
      连接那块的开合直接复用 showAdvancedProxy，播放器标题栏上的策略徽标点一下就能把它掀开。
    -->
    <div class="space-y-3">
      <!-- 选集：日常走播放器里那个抽屉，这份是「想一眼看全 + 刷新链接」时才展开的 -->
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
        hint="双击左右 ±5s · 按住右侧 2x · 滑动调进度/音量"
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
 * M3U8/MP4 播放器。
 *
 * 本页只做三件事：建控制器、provide 给子组件、接生命周期。
 * 全部业务逻辑在 composables 里按功能分模块（见 CLAUDE.md「视频播放器」一节）：
 *   useVideoMediaState      裸状态（打断模块间依赖环）
 *   useVideoHandoff         交接槽 / 剧名集名 / 按需取址作业单
 *   useVideoServerTier      服务器档位与抗卡参数
 *   useVideoConnStrategy    可达性探测 / 线性阶梯兜底 / 代理 URL
 *   useVideoPlaylistCtl     播放列表 / 进度记忆 / 刷新链接
 *   useVideoEngine          hls.js 生命周期 / 预取装配 / 自愈调参
 *   useVideoEvents          <video> 事件 / 起播预缓冲
 *   useVideoUiControls      播放控制 / 进度条 / 全屏 / 快捷键
 *   useVideoDeepLink        地址栏双向同步
 *   useVideoPlayerController 装配 + 持久化 + 生命周期（本页用的就是它）
 */
const ctx = useVideoPlayerController()
provide(VIDEO_PLAYER_KEY, ctx)

// 本页模板只用到这几项，其余全在子组件里各自 inject
const {
  isVideoLoaded, isHls, errorMessage, isResolvingUrl, resolveStage,
  showAdvancedProxy, strategyLabel, playlist, currentIndex,
} = ctx

// 折叠区的开合。连接那块用控制器里的 showAdvancedProxy（播放器标题栏的策略徽标也要能掀开它），
// 其余三块只有本页用得到，就近放着
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

<!--
  本页没有自己的样式：过渡类名和音量滑块的皮肤都挪进了 components/videoPlayer/Stage.vue。
  它们原本写在这里，而元素在 Stage 子组件内——父组件的 scoped 罩不到子组件内部，
  一直没生效（过渡是硬切、滑块是浏览器默认样式）。scoped 样式必须跟元素同一个组件。
-->
