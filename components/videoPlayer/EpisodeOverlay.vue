<template>
  <Transition name="sheet">
    <div
      v-if="showEpisodes && playlist.length > 1"
      data-no-gesture
      class="absolute inset-0 z-20 flex flex-col justify-end"
      @click="onBlankClick"
    >
      <!--
        **底部抽屉而不是整屏盖板**：换集时画面还在播，盖满一整块的话既看不见片子、
        又显得比它要做的事重得多。上半段留着（点一下就关），只在下面铺一层。
      -->
      <div class="max-h-[66%] flex flex-col rounded-t-2xl bg-black/80 backdrop-blur-xl ring-1 ring-white/10">
        <div class="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5 shrink-0 text-white">
          <span class="text-sm font-semibold truncate">{{ playlistTitle || '选集' }}</span>
          <span class="text-[11px] text-white/45 shrink-0">共 {{ playlist.length }} 集</span>
          <button
            class="ml-auto p-1 rounded-lg text-white/60 hover:bg-white/10 active:scale-90 transition-all shrink-0"
            title="关闭"
            @click="showEpisodes = false"
          >
            <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
          </button>
        </div>

        <!-- 格子**不给底色**，当前集只用一条下划线标出来：画面透过来还看得见，
             就不像是「盖了一块板子」。给每格上底色的话几十个灰块会糊成一片 -->
        <div class="no-sb flex-1 overflow-y-auto px-2.5 pb-3">
          <div class="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 gap-0.5">
            <button
              v-for="(item, index) in playlist"
              :key="index"
              :ref="el => { if (index === currentIndex) curEl = el as HTMLElement }"
              class="relative py-2.5 px-1 rounded-md text-[13px] transition-colors"
              :class="index === currentIndex
                ? 'text-white font-semibold'
                : getSavedProgress(item) > 0
                  ? 'text-amber-300/80 hover:bg-white/10'
                  : 'text-white/70 hover:bg-white/10'"
              :title="getVideoName(item, index)"
              @click="pick(index)"
            >
              <span class="block truncate">{{ getVideoName(item, index) }}</span>
              <span
                v-if="index === currentIndex"
                class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-6 h-[3px] rounded-full
                       bg-gradient-to-r from-rose-500 to-fuchsia-400 shadow-[0_0_8px_rgba(244,63,94,.8)]"
              />
              <!-- 看过但没看完：右上角一个小点，比写「已看」省地方 -->
              <span
                v-else-if="getSavedProgress(item) > 0"
                class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400/80"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面内的选集抽屉。页面下方那份列表在全屏时够不着，而「看完这集换下一集」
 * 正是全屏里最高频的动作。挂在播放器容器内（`absolute`），全屏时跟着一起进全屏。
 */
const {
  playlist, currentIndex, playlistTitle, showEpisodes,
  getSavedProgress, getVideoName, playByIndex,
} = useVideoPlayerCtx()

const curEl = ref<HTMLElement>()

/** 点空白即关。判据是「这一下有没有落在按钮上」而不是 `@click.self`——
 *  后者只认根元素本身，标题栏、缝隙、列表下方的空白全都不算，结果只有边缘一圈能关 */
const onBlankClick = (e: MouseEvent) => {
  if ((e.target as HTMLElement | null)?.closest?.('button')) return
  showEpisodes.value = false
}

const pick = (index: number) => {
  showEpisodes.value = false
  void playByIndex(index)
}

// 打开时把当前集滚到可见处：七十多集的剧默认停在第一屏，每次都得自己找
watch(showEpisodes, async (open) => {
  if (!open) return
  await nextTick()
  curEl.value?.scrollIntoView({ block: 'center' })
})
</script>

<style scoped>
.sheet-enter-active { transition: opacity .2s ease, transform .28s cubic-bezier(.2, 1.1, .4, 1); }
.sheet-leave-active { transition: opacity .18s ease, transform .18s ease-in; }
.sheet-enter-from,
.sheet-leave-to { opacity: 0; transform: translateY(20px); }
</style>
