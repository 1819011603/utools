<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-heroicons-command-line" class="w-5 h-5 text-amber-500" />
        <span class="font-semibold">快捷键</span>
      </div>
    </template>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div v-for="item in SHORTCUTS" :key="item.keys" class="flex items-center gap-2">
        <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">{{ item.keys }}</kbd>
        <span class="text-gray-600 dark:text-gray-400">{{ item.desc }}</span>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
// 与 useVideoUiControls.handleKeydown 一一对应，改按键时两处都要动
const SHORTCUTS = [
  { keys: 'Space', desc: '播放/暂停' },
  { keys: '←/→', desc: '快退/快进 5秒' },
  { keys: '↑/↓', desc: '音量调整' },
  { keys: 'M', desc: '静音' },
  { keys: 'F', desc: '全屏' },
  { keys: 'Enter', desc: '全屏/恢复' },
  { keys: '</>', desc: '倍速调整' },
  { keys: 'P', desc: '画中画' },
  { keys: '双击', desc: '全屏切换' },
]
</script>
