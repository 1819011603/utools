<template>
  <div class="space-y-4">
    <UFormGroup label="视频地址" help="支持多个链接，每行一个，自动按顺序播放">
      <UTextarea
        v-model="videoUrlInput"
        placeholder="输入 m3u8 或 mp4 视频地址...&#10;支持多个链接，每行一个"
        :rows="3"
        @keydown.ctrl.enter="parseAndLoad"
      />
    </UFormGroup>

    <!--
      这张卡片只剩「输入框 + 播放」。选集已经内嵌进播放器（顶部信息条的「选集」按钮），
      页面上那份完整列表挪到下方折叠区当备用入口——两处都摆着只是把播放器又挤下去一屏。
      自动全屏/自动倍速/跳过片头片尾进了播放器控制栏的齿轮菜单（看片当下才改），
      连接策略与防盗链进了页面下方的折叠区（排查问题才看）——摊在这里只是把入口挤没了。
    -->
    <div class="flex gap-2 flex-wrap items-center">
      <UButton color="primary" :disabled="!videoUrlInput.trim()" :loading="isLoading" @click="parseAndLoad">
        <UIcon name="i-heroicons-play" class="w-4 h-4 mr-1" />
        解析并播放
      </UButton>
      <UButton size="sm" variant="soft" :color="deepLinkCopied ? 'green' : 'gray'" @click="copyDeepLink">
        <UIcon :name="deepLinkCopied ? 'i-heroicons-check' : 'i-heroicons-link'" class="w-4 h-4 mr-1" />
        {{ deepLinkCopied ? '已复制' : '复制直链' }}
      </UButton>
    </div>

    <!-- 示例只在还没起播时给：那时它是唯一「不用找地址就能试」的入口，播起来之后就是纯噪音 -->
    <div v-if="!isVideoLoaded" class="flex flex-wrap gap-2">
      <span class="text-sm text-gray-500">示例：</span>
      <UButton v-for="example in EXAMPLE_URLS" :key="example.url" size="xs" variant="soft" @click="loadExample(example.url)">
        {{ example.name }}
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
// 解构出来当顶层 setup 绑定：模板里自动解包 ref，v-model 也能直接写
const {
  videoUrlInput, isLoading, isVideoLoaded,
  playlist, currentIndex,
  parseAndLoad, loadExample,
  copyDeepLink, deepLinkCopied,
} = useVideoPlayerCtx()

// 只有这一处用到，就近放着
const EXAMPLE_URLS = [
  { name: 'Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Sintel (HLS)', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { name: 'Tears of Steel (MP4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
]
</script>
