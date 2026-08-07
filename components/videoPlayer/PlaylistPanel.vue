<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
        {{ playlistTitle || '播放列表' }}
        <span v-if="playlistTitle" class="font-normal text-gray-400">· 共 {{ playlist.length }} 集</span>
        <!-- Toast 会消失，这里常驻一个上次刷新时间，随时能确认刷没刷过 -->
        <span v-if="lastRefreshAt" class="font-normal text-xs text-gray-400">
          · 已于 {{ formatClock(lastRefreshAt) }} 刷新
        </span>
      </span>
      <div class="flex gap-2">
        <!-- 带签名的地址会过期，用交接槽里的来源就地重解析，不用回解析页 -->
        <UButton
          v-if="playlistSource"
          size="xs"
          variant="soft"
          color="violet"
          icon="i-heroicons-arrow-path"
          :loading="isRefreshingLinks"
          title="链接过期播不了时，用同一来源和线路重新解析并替换"
          @click="refreshPlaylistLinks"
        >
          刷新链接
        </UButton>
        <UButton size="xs" variant="soft" @click="clearAllProgress">清除进度</UButton>
        <UButton size="xs" variant="ghost" color="red" @click="clearPlaylist">清空列表</UButton>
      </div>
    </div>

    <!-- 网格排布：几十集竖着列要滚很久，横着摆一眼能扫到目标集 -->
    <div class="max-h-80 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
      <!-- 列数给足：一屏能扫到的集数越多越省事，超长剧尤其明显 -->
      <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2">
        <div
          v-for="(item, index) in playlist"
          :key="index"
          class="relative group/item rounded cursor-pointer transition-colors text-sm text-center px-2 py-2 truncate"
          :class="[
            index === currentIndex
              ? 'bg-violet-500 text-white font-medium'
              : 'bg-white dark:bg-gray-700 hover:bg-violet-100 dark:hover:bg-gray-600',
            // 看过的（有进度记录）标成琥珀色，跟没看过的区分开
            index !== currentIndex && getSavedProgress(item) > 0 ? 'text-amber-600 dark:text-amber-400' : '',
          ]"
          :title="getSavedProgress(item) > 0
            ? `${getVideoName(item, index)}（看到 ${formatTime(getSavedProgress(item))}）`
            : getVideoName(item, index)"
          @click="playByIndex(index)"
        >
          <UIcon
            v-if="index === currentIndex && isPlaying"
            name="i-heroicons-speaker-wave"
            class="w-3.5 h-3.5 inline-block mr-1 align-text-bottom"
          />
          {{ getVideoName(item, index) }}
          <!-- 下载按钮压在右上角，hover 才出现，免得占掉格子宽度 -->
          <button
            v-if="item.startsWith('http') && !isDownloading"
            class="absolute -top-1 -right-1 opacity-0 group-hover/item:opacity-100 p-1 rounded-full bg-violet-500 text-white shadow transition-opacity"
            title="下载这一集"
            @click.stop="downloadVideo(item)"
          >
            <UIcon name="i-heroicons-arrow-down-tray" class="w-3 h-3 block" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  playlist, currentIndex, playlistTitle, playlistSource, lastRefreshAt, isRefreshingLinks,
  isPlaying, isDownloading,
  getSavedProgress, getVideoName, playByIndex, downloadVideo,
  refreshPlaylistLinks, clearAllProgress, clearPlaylist,
} = useVideoPlayerCtx()
</script>
