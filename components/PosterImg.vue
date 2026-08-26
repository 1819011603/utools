<template>
  <div class="relative overflow-hidden bg-gray-100 dark:bg-gray-800">
    <img
      v-if="src && stage !== 'dead'"
      :key="stage"
      :src="stage === 'proxy' ? '/api/thumb?url=' + encodeURIComponent(src) : src"
      :alt="alt"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="w-full h-full object-cover"
      @error="onError"
    >
    <div v-else class="w-full h-full flex items-center justify-center">
      <UIcon :name="icon" class="w-1/2 h-1/2 max-w-6 max-h-6 text-gray-300 dark:text-gray-600" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 封面图。尺寸完全由外面的 class 决定（这里只负责「怎么把图弄出来」）。
 *
 * 两级兜底，缺一不可：
 *   · `referrerpolicy="no-referrer"` —— 图床普遍带防盗链，不加成片 403；
 *   · 直连失败退到 `/api/thumb` 代理一趟 —— 有的站连图片都过反爬、有的图床被 DNS 污染，
 *     只有服务端那条带代理的通道走得通（见 server/api/thumb.ts）。
 * 两条都挂了就画一个占位块：破图比没有图更难看，而封面本来就是锦上添花。
 *
 * `:key="stage"` 是必须的：只改 `src` 时浏览器会复用同一个 img 元素，
 * 而它已经处在「加载失败」状态，换了地址也不一定重新发请求（实测 Chrome 有时不发）。
 */
const props = withDefaults(defineProps<{
  src?: string
  alt?: string
  /** 没有图时画什么。海报位用胶片，别的地方可以换 */
  icon?: string
}>(), { src: '', alt: '', icon: 'i-heroicons-film' })

type Stage = 'direct' | 'proxy' | 'dead'
const stage = ref<Stage>('direct')

// 换了一部剧就重新从直连开始试（同一个组件实例会被复用）
watch(() => props.src, () => { stage.value = 'direct' })

const onError = () => { stage.value = stage.value === 'direct' ? 'proxy' : 'dead' }
</script>
