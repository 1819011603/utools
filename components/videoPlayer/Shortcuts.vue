<template>
  <div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
    <div v-for="item in SHORTCUTS" :key="item.keys" class="flex items-center gap-2">
      <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">{{ item.keys }}</kbd>
      <span class="text-gray-600 dark:text-gray-400">{{ item.desc }}</span>
    </div>
  </div>

  <div class="mt-5 pt-4 border-t border-gray-200 dark:border-gray-800">
    <div class="flex items-center gap-2 mb-3">
      <UIcon name="i-heroicons-hand-raised" class="w-5 h-5 text-violet-500" />
      <span class="font-semibold text-sm">画面手势（触摸 / 鼠标通用）</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <div v-for="item in GESTURES" :key="item.act" class="flex items-start gap-2">
        <span class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs shrink-0">{{ item.act }}</span>
        <span class="text-gray-600 dark:text-gray-400">{{ item.desc }}</span>
      </div>
    </div>
  </div>
  </div>
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
  { keys: 'N / P', desc: '下一集 / 上一集' },
  { keys: 'I', desc: '画中画' },
]

// 与 useVideoGestures 一一对应，改手势时两处都要动
const GESTURES = [
  { act: '鼠标单击 / 双击', desc: '播放暂停 / 全屏切换（桌面标准）' },
  { act: '触摸单击（小窗）', desc: '中间三分之一播放/暂停，两侧唤出控制栏' },
  { act: '触摸单击（全屏）', desc: '显示/隐藏控制栏（不会误触暂停）' },
  { act: '触摸双击左右', desc: '快退 / 快进 5 秒' },
  { act: '触摸双击中间', desc: '播放 / 暂停' },
  { act: '按住右侧', desc: '临时 2 倍速快进，松手恢复' },
  { act: '左右滑动', desc: '拖动进度（松手才跳转）' },
  { act: '上下滑动（全屏内）', desc: '右侧调音量，左侧调亮度' },
  { act: '锁定按钮', desc: '屏蔽全部手势与快捷键，防止误触' },
  { act: '手机全屏', desc: '自动锁定横屏铺满' },
]
</script>
