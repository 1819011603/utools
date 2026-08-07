<template>
  <UCard :ui="{ body: { padding: open ? undefined : 'p-0' } }">
    <template #header>
      <button class="w-full flex items-center gap-2 text-left" @click="emit('update:modelValue', !open)">
        <UIcon :name="icon" class="w-5 h-5 shrink-0" :class="iconClass" />
        <span class="font-semibold">{{ title }}</span>
        <span v-if="hint" class="text-xs text-gray-400 truncate">{{ hint }}</span>
        <UIcon
          name="i-heroicons-chevron-down"
          class="w-4 h-4 ml-auto shrink-0 text-gray-400 transition-transform duration-200"
          :class="{ 'rotate-180': open }"
        />
      </button>
    </template>

    <!-- v-show 而不是 v-if：这些面板里有输入框和探测矩阵，折叠一次就重建会丢掉滚动位置和瞬时状态 -->
    <div v-show="open">
      <slot />
    </div>
  </UCard>
</template>

<script setup lang="ts">
/**
 * 可折叠的卡片外壳。播放器页面下半部分（连接策略 / HLS / 预加载 / 快捷键）全用它，
 * **默认折叠**——那几块是排查问题时才看的，平时挡在播放器和播放列表下面纯属噪音。
 */
const props = defineProps<{
  modelValue?: boolean
  title: string
  icon: string
  iconClass?: string
  /** 折叠状态下也想让人看见的一句话摘要（如当前连接策略） */
  hint?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const open = computed(() => !!props.modelValue)
</script>
