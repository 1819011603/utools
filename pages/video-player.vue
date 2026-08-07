<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频播放器</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">支持 M3U8/MP4 播放，并发加载分片，倍速/音量调整</p>
      </div>
    </div>

    <VideoPlayerSourceCard />
    <VideoPlayerStage v-if="isVideoLoaded" />
    <VideoPlayerHlsSettings v-if="isHls" />
    <VideoPlayerPreloadSettings v-if="isVideoLoaded && !isHls" />
    <VideoPlayerShortcuts />

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
const { isVideoLoaded, isHls, errorMessage } = ctx

onMounted(() => ctx.mount())
onUnmounted(() => ctx.unmount())
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(20px);
}

/* 自定义滑块样式 */
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  cursor: pointer;
}
</style>
