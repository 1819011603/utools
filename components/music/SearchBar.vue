<script setup lang="ts">
/**
 * 搜索框 + 历史胶囊。
 *
 * 不接收 props：搜索状态由页面持有（它同时要喂给 ResultList），
 * 这里只通过 emit 把「用户想搜什么」抛上去 —— 搜索不属于播放器上下文，
 * 所以这个组件**不走 useMusicPlayerCtx**（播放器可复用的前提就是它不认识搜索）。
 */
const props = defineProps<{ searching: boolean }>()
const emit = defineEmits<{ (e: 'search', kw: string): void }>()

/**
 * 输入框的文字用 `defineModel` 双向绑定：地址栏带着 `?kw=` 打开、或点浏览器前进/后退时，
 * 页面要能把词直接摆进输入框（不然框里是空的，用户会以为「搜过的词丢了」，即使下面结果还在）。
 */
const input = defineModel<string>({ default: '' })

/**
 * 搜索历史。`bump: true` —— 反复搜同一个歌手是常态（今天搜、明天接着听），
 * 默认那套「重复就返回 false」会让最常搜的词永远停在末尾、先被淘汰（同 video-search 的处置）。
 */
const { addToHistory, getHistory, clearHistory } = useHistory<{ kw: string }>('music-search', { maxItems: 200 })
const history = ref(getHistory())

// 同 video-search：云同步直接写 localStorage，这个快照不重读就得刷新页面才看得到
onBeforeUnmount(onSyncApplied('music-search', () => { history.value = getHistory() }))

const submit = (kw = input.value) => {
  const q = kw.trim()
  if (!q) return
  input.value = q
  emit('search', q)
  // 搜下去那一刻就记，不等结果：搜出 0 条也是一次「我搜过这个」，
  // 而两个音源是异步落地的，等「有结果了」再记就得挑一个说不清的时机
  addToHistory({ kw: q }, { bump: true })
  history.value = getHistory()
}

const clearAll = () => { clearHistory(); history.value = [] }

defineExpose({ submit })
</script>

<template>
  <div class="space-y-3">
    <div class="flex gap-2">
      <UInput
        v-model="input"
        placeholder="歌名 / 歌手，如「周杰伦」"
        size="lg"
        class="flex-1"
        icon="i-heroicons-magnifying-glass"
        :disabled="props.searching"
        @keyup.enter="submit()"
      />
      <UButton size="lg" :loading="props.searching" :disabled="!input.trim()" @click="submit()">
        搜索
      </UButton>
    </div>

    <div v-if="history.length" class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-gray-400 shrink-0">最近搜过</span>
      <UButton
        v-for="h in history.slice(0, 12)"
        :key="h.timestamp"
        size="2xs"
        color="gray"
        variant="soft"
        @click="submit(h.data.kw)"
      >
        {{ h.data.kw }}
      </UButton>
      <UButton size="2xs" color="gray" variant="ghost" @click="clearAll">清空</UButton>
    </div>
  </div>
</template>
