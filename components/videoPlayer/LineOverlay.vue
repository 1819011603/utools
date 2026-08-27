<template>
  <Transition name="drawer">
    <div
      v-if="showLines && lines.length > 1"
      data-no-gesture
      class="absolute inset-y-0 right-0 z-30 w-[70%] min-w-[13rem] max-w-[17rem]
             flex flex-col bg-black/80 backdrop-blur-xl ring-1 ring-white/10 text-white"
      @contextmenu.prevent
    >
      <div class="shrink-0 flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span class="text-[15px] font-semibold">换源</span>
        <span class="text-[11px] text-white/45">{{ lines.length }} 条线路</span>
        <button class="ml-auto p-1 rounded-lg text-white/60 hover:bg-white/10" title="关闭" @click="showLines = false">
          <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
        </button>
      </div>

      <div class="no-sb flex-1 overflow-y-auto px-2.5 pb-4 space-y-1">
        <!-- 切换中只换这枚图标，**绝不 disabled**：disabled 控件不派发鼠标事件，
             那一下会落到手势层上（CLAUDE.md 里「点切集结果全屏了」那条） -->
        <button
          v-for="(l, i) in lines"
          :key="i"
          class="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors"
          :class="i === currentLine ? 'bg-rose-500/80 font-medium' : 'hover:bg-white/10 text-white/80'"
          @click="pick(i)"
        >
          <UIcon v-if="pending === i" name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin" />
          <UIcon v-else-if="i === currentLine" name="i-heroicons-check" class="w-3.5 h-3.5 shrink-0" />
          <span v-else class="w-3.5 shrink-0 text-center text-[11px] text-white/40">{{ i + 1 }}</span>
          <span class="min-w-0 flex-1 truncate">{{ l.name }}</span>
          <span class="shrink-0 text-[11px]" :class="i === currentLine ? 'text-white/80' : 'text-white/35'">
            {{ l.count > 1 ? l.count + ' 集' : '单集' }}
          </span>
        </button>
      </div>

      <p class="shrink-0 px-3.5 pb-3 text-[11px] text-white/40 leading-snug">
        换源留在这一集、接着当前进度播；各线路集数常常不同，找不到同名那集就按序号落位。
      </p>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面内的换源面板。左侧那个悬浮抽屉里也有一份（LinePicker），但它是**页面上的**浮层
 * —— 全屏时 `fixed` 元素挂在全屏元素外面，一个像素都看不见，而「这条线路播不动」
 * 恰恰是全屏看片时才发现的事。
 */
const { showLines, playlistLines, playlistSource, isSwitchingLine, switchLine } = useVideoPlayerCtx()

const lines = playlistLines
const currentLine = computed(() => playlistSource.value?.line ?? -1)

const pending = ref(-1)
watch(isSwitchingLine, v => { if (!v) pending.value = -1 })

const pick = async (i: number) => {
  if (i === currentLine.value || isSwitchingLine.value) return
  pending.value = i
  // 先关面板：换源要重解析一整条线路，慢站好几秒，那几秒里画面上的解析遮罩才是该看的东西
  showLines.value = false
  await switchLine(i)
}
</script>

<style scoped>
.drawer-enter-active { transition: transform .26s cubic-bezier(.22, 1, .36, 1), opacity .2s ease; }
.drawer-leave-active { transition: transform .18s ease-in, opacity .18s ease; }
.drawer-enter-from,
.drawer-leave-to { transform: translateX(100%); opacity: 0; }
</style>
