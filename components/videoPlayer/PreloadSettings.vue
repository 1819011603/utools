<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-heroicons-cog-6-tooth" class="w-5 h-5 text-gray-500" />
        <span class="font-semibold">播放设置</span>
      </div>
    </template>

    <div class="flex items-center gap-4">
      <UFormGroup label="预加载策略">
        <USelectMenu v-model="preloadStrategy" :options="PRELOAD_OPTIONS" @change="applyPreload" />
      </UFormGroup>
      <div class="text-xs text-gray-500 mt-6">
        <p>• <strong>none</strong>: 不预加载，节省流量</p>
        <p>• <strong>metadata</strong>: 只加载元数据</p>
        <p>• <strong>auto</strong>: 自动预加载整个视频</p>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
const { preloadStrategy, applyPreload } = useVideoPlayerCtx()

// 只有这一处用到，就近放着
const PRELOAD_OPTIONS = [
  { label: '不预加载 (none)', value: 'none' },
  { label: '仅元数据 (metadata)', value: 'metadata' },
  { label: '自动预加载 (auto)', value: 'auto' },
]
</script>
