<template>
  <div ref="menuRef" class="relative">
    <button
      class="text-white hover:text-violet-400 transition-colors"
      title="播放器设置（自动全屏 / 自动倍速 / 跳过片头片尾）"
      @click="open = !open"
    >
      <UIcon name="i-heroicons-cog-6-tooth" class="w-5 h-5" :class="{ 'rotate-90': open }" style="transition: transform .3s" />
    </button>

    <Transition name="menu">
      <div
        v-if="open"
        class="absolute bottom-full right-0 mb-2 w-64 p-3 rounded-xl bg-black/90 backdrop-blur-md
               ring-1 ring-white/15 shadow-2xl space-y-3 text-white text-sm"
      >
        <!-- 控制栏是浮在黑画面上的，这里不用 UCheckbox/UInput：那套是亮色主题的，压在黑底上一片糊 -->
        <label class="flex items-center gap-2 cursor-pointer">
          <input v-model="autoFullscreen" type="checkbox" class="accent-violet-500 w-4 h-4" @change="saveState">
          <span>加载后自动全屏</span>
        </label>

        <label class="flex items-start gap-2 cursor-pointer">
          <input v-model="autoBestRate" type="checkbox" class="accent-violet-500 w-4 h-4 mt-0.5" @change="saveState">
          <span>
            自动最佳倍速
            <span class="block text-xs text-white/50">1x ~ {{ autoRateCap }}x，流畅就提速，卡了就降回</span>
          </span>
        </label>

        <div class="pt-2 border-t border-white/15 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span>跳过片头</span>
            <div class="flex items-center gap-1">
              <input
                v-model.number="skipIntro" type="number" min="0" max="300" step="5"
                class="w-16 px-2 py-1 rounded bg-white/10 text-right tabular-nums outline-none
                       focus:ring-1 focus:ring-violet-400"
                @change="saveState"
              >
              <span class="text-white/50 text-xs">秒</span>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span>跳过片尾</span>
            <div class="flex items-center gap-1">
              <input
                v-model.number="skipOutro" type="number" min="0" max="300" step="5"
                class="w-16 px-2 py-1 rounded bg-white/10 text-right tabular-nums outline-none
                       focus:ring-1 focus:ring-violet-400"
                @change="saveState"
              >
              <span class="text-white/50 text-xs">秒</span>
            </div>
          </div>
          <p class="text-xs text-white/40">片尾：剩余时间少于此值自动跳下一集（0 = 关闭）</p>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * 控制栏里的齿轮菜单。这几项原来摊在页面的「视频源」卡片上，
 * 但它们全是**看片当下**才会改的东西（尤其跳过片头片尾），放在播放器里手不用离开画面。
 */
import { onClickOutside } from '@vueuse/core'

const { autoFullscreen, autoBestRate, autoRateCap, skipIntro, skipOutro, saveState } = useVideoPlayerCtx()

const menuRef = ref<HTMLElement>()
const open = ref(false)
onClickOutside(menuRef, () => { open.value = false })
</script>

<style scoped>
.menu-enter-active { transition: opacity .15s ease, transform .25s cubic-bezier(.2, 1.4, .4, 1); }
.menu-leave-active { transition: opacity .15s ease, transform .15s ease-in; }
.menu-enter-from,
.menu-leave-to { opacity: 0; transform: translateY(8px) scale(.95); }
</style>
