<script setup lang="ts">
/**
 * 封面。播放条、队列、收藏、下载面板共用这一个。
 *
 * ## 为什么不能只写一个 `<img :src>`
 *
 * 实测酷我的图床（`img1.kuwo.cn`）**浏览器直连超时**，而服务端走 `HTTPS_PROXY` 那条能取到
 * ——症状是一排灰块，控制台里连个错都不报（`<img>` 的超时不会触发 `onerror`，它就是一直挂着）。
 *
 * 所以走三级降级：**直连 → `/api/thumb` 代理 → 占位图标**。
 * 先直连是因为能直连的图一个字节都不该经过我们（`thumb.ts` 的注释里也是这个分工）。
 *
 * `<img>` 超时不报错这件事必须自己兜：只挂 `onerror` 的话，那种「一直转」的图永远等不到降级。
 */
const props = withDefaults(defineProps<{
  src?: string
  alt?: string
  /** 尺寸类名。调用方决定大小，组件只管加载策略 */
  sizeClass?: string
  /** 占位图标的大小 */
  iconClass?: string
  /** 直连多久没结果就转代理。图床超时的表现是「一直挂着」，等下去只会一直是灰块 */
  timeoutMs?: number
}>(), {
  sizeClass: 'w-10 h-10',
  iconClass: 'w-5 h-5',
  timeoutMs: 2500,
})

/** 'direct' → 'proxy' → 'failed'，单向推进，不会来回跳 */
const stage = ref<'direct' | 'proxy' | 'failed'>('direct')
let timer: ReturnType<typeof setTimeout> | null = null

const shownSrc = computed(() => {
  if (!props.src) return ''
  if (stage.value === 'direct') return props.src
  if (stage.value === 'proxy') return `/api/thumb?url=${encodeURIComponent(props.src)}`
  return ''
})

const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

/** 换歌就重来一轮：新封面可能在另一个图床上，不该继承上一张的降级结果 */
const restart = () => {
  clearTimer()
  stage.value = 'direct'
  if (!props.src) return
  timer = setTimeout(() => {
    // 只在还停在直连阶段时才升级——已经 onload 的会先把 timer 清掉
    if (stage.value === 'direct') stage.value = 'proxy'
  }, props.timeoutMs)
}

const onLoad = () => clearTimer()

const onError = () => {
  clearTimer()
  stage.value = stage.value === 'direct' ? 'proxy' : 'failed'
}

watch(() => props.src, restart, { immediate: true })
onBeforeUnmount(clearTimer)
</script>

<template>
  <div
    class="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0 grid place-items-center"
    :class="sizeClass"
  >
    <!-- no-referrer：这类图床常认 Referer，带上反而被拒 -->
    <img
      v-if="shownSrc"
      :key="shownSrc"
      :src="shownSrc"
      :alt="alt || ''"
      referrerpolicy="no-referrer"
      loading="lazy"
      class="w-full h-full object-cover"
      @load="onLoad"
      @error="onError"
    >
    <UIcon v-else name="i-heroicons-musical-note" class="text-gray-400" :class="iconClass" />
  </div>
</template>
