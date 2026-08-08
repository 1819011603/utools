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
        class="no-sb absolute z-30 bottom-full right-0 mb-2 w-64 p-3 rounded-xl
               bg-gradient-to-br from-white/10 via-rose-200/10 to-violet-300/15
               backdrop-blur-md ring-1 ring-white/20 shadow-xl shadow-violet-950/20
               space-y-3 text-white text-sm [text-shadow:0_1px_2px_rgba(0,0,0,.8)]
               max-h-[min(70vh,320px)] overflow-y-auto"
      >
        <!--
          不用 UCheckbox/UInput：那套是亮色主题的，压在画面上一片糊。
          底子是**淡雅的玫瑰→薰衣草半透明渐变**（跟整站同一套色），不是一块黑板——
          但因此白字必须配 text-shadow、次要文字不能再低于 /60，否则遇到亮画面就看不见了。
        -->
        <label class="flex items-center gap-2 cursor-pointer">
          <input v-model="autoFullscreen" type="checkbox" class="accent-violet-500 w-4 h-4" @change="saveState">
          <span>加载后自动全屏</span>
        </label>

        <label class="flex items-start gap-2 cursor-pointer">
          <input v-model="autoBestRate" type="checkbox" class="accent-violet-500 w-4 h-4 mt-0.5" @change="saveState">
          <span>
            自动最佳倍速
            <span class="block text-xs text-white/70">1x ~ {{ autoRateCap }}x，流畅就提速，卡了就降回</span>
          </span>
        </label>

        <div class="pt-2 border-t border-white/15 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span>跳过片头</span>
            <div class="flex items-center gap-1">
              <input
                v-model.number="skipIntro" type="number" min="0" max="300" step="5"
                class="w-16 px-2 py-1 rounded bg-white/20 text-right tabular-nums outline-none
                       focus:ring-1 focus:ring-violet-400"
                @change="saveState"
              >
              <span class="text-white/70 text-xs">秒</span>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span>跳过片尾</span>
            <div class="flex items-center gap-1">
              <input
                v-model.number="skipOutro" type="number" min="0" max="300" step="5"
                class="w-16 px-2 py-1 rounded bg-white/20 text-right tabular-nums outline-none
                       focus:ring-1 focus:ring-violet-400"
                @change="saveState"
              >
              <span class="text-white/70 text-xs">秒</span>
            </div>
          </div>
          <p class="text-xs text-white/60">片尾：剩余时间少于此值自动跳下一集（0 = 关闭）</p>
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
/* 不显示滚动条：那条灰槽不吃 backdrop-blur，比菜单本身还实，是画面上最扎眼的一块 */
.no-sb { scrollbar-width: none; -ms-overflow-style: none; }
.no-sb::-webkit-scrollbar { display: none; }

.menu-enter-active { transition: opacity .15s ease, transform .25s cubic-bezier(.2, 1.4, .4, 1); }
.menu-leave-active { transition: opacity .15s ease, transform .15s ease-in; }
.menu-enter-from,
.menu-leave-to { opacity: 0; transform: translateY(8px) scale(.95); }
</style>
