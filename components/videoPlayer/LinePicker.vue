<template>
  <div class="space-y-3">
    <p class="text-xs text-gray-500 dark:text-gray-400">
      共 {{ lines.length }} 条线路 · 当前
      <b class="text-gray-700 dark:text-gray-200">{{ currentName || '未知' }}</b>
      <br>
      换源会留在这一集、接着这个进度播；各线路集数可能不同，找不到同名那集就按序号落位。
    </p>

    <ul class="space-y-1">
      <li v-for="(l, i) in lines" :key="i">
        <button
          type="button"
          class="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-colors"
          :class="i === currentLine
            ? 'bg-emerald-500/10 ring-1 ring-emerald-400/40'
            : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'"
          @click="pick(i)"
        >
          <span
            class="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium"
            :class="i === currentLine
              ? 'bg-emerald-500 text-white'
              : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400'"
          >
            <!-- 切换中只换这枚图标，**绝不 disabled**：disabled 控件不派发鼠标事件，
                 那一下会被下面的手势层接走（CLAUDE.md 里「点切集结果全屏了」那条） -->
            <UIcon v-if="pending === i" name="i-heroicons-arrow-path" class="w-3.5 h-3.5 animate-spin" />
            <UIcon v-else-if="i === currentLine" name="i-heroicons-check" class="w-4 h-4" />
            <template v-else>{{ i + 1 }}</template>
          </span>

          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium truncate text-gray-900 dark:text-white">{{ l.name }}</span>
            <span v-if="l.sublabel" class="block text-xs text-gray-500 truncate">{{ l.sublabel }}</span>
          </span>

          <span
            class="shrink-0 text-xs px-2 py-0.5 rounded-md"
            :class="i === currentLine
              ? 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10'
              : 'text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/5'"
          >{{ i === currentLine ? '当前' : (l.count > 1 ? l.count + ' 集' : '单集') }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * 换源（换线路）面板。
 *
 * 线路表来自最近一次解析（`handoff.playlistLines`），只有走 `?parseUrl=` 那条路进来的
 * 播放列表才有——手工贴地址播的没有「线路」这回事，这块整个不渲染（见 SideDock 的 v-if）。
 *
 * 一条线路播不动是最常见的一件事，而在此之前唯一的出路是「回解析页重选」——
 * 那要重来一遍解析、还得自己找回第几集。这里换源全程留在播放器里，集数和进度都跟着走。
 */
const emit = defineEmits<{ (e: 'close'): void }>()

const { playlistLines, playlistSource, isSwitchingLine, switchLine } = useVideoPlayerCtx()

const lines = playlistLines
const currentLine = computed(() => playlistSource.value?.line ?? -1)
const currentName = computed(() => playlistLines.value[currentLine.value]?.name || playlistSource.value?.lineName || '')

/** 正在切的是哪一条（转圈图标画在它自己身上，而不是整块面板变灰） */
const pending = ref(-1)
watch(isSwitchingLine, v => { if (!v) pending.value = -1 })

const pick = async (i: number) => {
  if (i === currentLine.value || isSwitchingLine.value) return
  pending.value = i
  // 面板先关掉：换源要重解析一整条线路，慢站好几秒，而那几秒里画面上有
  //「正在解析播放列表…」的遮罩在交代进度，压着一块面板反而看不见
  emit('close')
  await switchLine(i)
}
</script>
