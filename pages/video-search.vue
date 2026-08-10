<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">按片名搜索</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
        一个片名，各站同时搜，按站点分开看；点一格直接送去解析
      </p>
    </div>

    <UCard>
      <div class="space-y-3">
        <div class="flex gap-2">
          <UInput
            v-model="input"
            placeholder="片名，如：东宫"
            icon="i-heroicons-magnifying-glass"
            class="flex-1"
            autofocus
            @keyup.enter="run()"
          />
          <UButton icon="i-heroicons-magnifying-glass" :loading="searching" :disabled="!input.trim()" @click="run()">
            搜索
          </UButton>
        </div>
        <!-- 只数真正会去搜的站：manual 的那几个（源站有人机校验）压根不发请求，
             算进去会让人以为它们也在搜、然后奇怪为什么永远没结果 -->
        <p class="text-xs text-gray-500 dark:text-gray-400">
          {{ autoCount }} 个站点并发搜索，谁先回来先显示<template v-if="manualNames">；{{ manualNames }} 只能在源站搜</template>。
          <template v-if="keyword">已搜「{{ keyword }}」，合计 {{ totalFound }} 个结果。</template>
        </p>
      </div>
    </UCard>

    <UCard v-if="keyword">
      <!-- 站点列表放**左侧竖排**而不是顶部横排 tab：站名带括号里的英文（「奈飞工厂 (netflixgc)」），
           五个横着摆一行放不下、还会被挤成省略号，而竖排一屏就能全看见，加站也不会撑爆。
           窄屏退回横向滚动条：那时纵向空间比横向金贵，竖排会把结果顶到屏幕外 -->
      <div class="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
        <div class="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible pb-1 md:pb-0 md:border-r md:border-gray-200 md:dark:border-gray-800 md:pr-3">
          <button
            v-for="s in states"
            :key="s.siteId"
            type="button"
            class="shrink-0 md:w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors"
            :class="s.siteId === activeId
              ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400 font-medium'
              : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
            @click="activeId = s.siteId"
          >
            <span class="flex-1 truncate">{{ s.name }}</span>
            <UIcon v-if="s.status === 'searching'" name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin" />
            <UIcon v-else-if="s.status === 'error'" name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0 text-red-500" />
            <UIcon v-else-if="s.status === 'blocked' || s.status === 'manual'" name="i-heroicons-shield-exclamation" class="w-3.5 h-3.5 shrink-0 text-amber-500" />
            <UBadge v-else-if="s.items.length" color="rose" variant="subtle" size="xs">{{ s.items.length }}</UBadge>
            <UBadge v-else-if="s.status === 'done'" color="gray" variant="subtle" size="xs">0</UBadge>
          </button>
        </div>

        <VideoSearchSiteResults
          v-if="activeState"
          :key="activeState.siteId"
          :state="activeState"
          :keyword="keyword"
          @retry="retrySite(activeState.siteId)"
        />
      </div>
    </UCard>

    <UCard v-else>
      <div class="py-10 text-center space-y-2">
        <UIcon name="i-heroicons-film" class="w-10 h-10 mx-auto text-gray-300" />
        <p class="text-sm text-gray-500">输入片名开始搜索</p>
        <p class="text-xs text-gray-400">支持 {{ states.map(s => s.name).join(' · ') }}</p>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
const { keyword, states, searching, totalFound, search, retrySite, saveCache, restoreCache } = useVideoSearch()

const input = ref('')
// 选中的站点按 **id** 记，不按下标：规则表增删站点后下标会指到别人身上
const activeId = ref(states.value[0]?.siteId ?? '')
const activeState = computed(() => states.value.find(s => s.siteId === activeId.value) ?? states.value[0])

const autoCount = computed(() => states.value.filter(s => s.status !== 'manual').length)
const manualNames = computed(() => states.value.filter(s => s.status === 'manual').map(s => s.name).join('、'))

const run = (kw = input.value) => {
  const q = kw.trim()
  if (!q) return
  autoPicked.value = false
  search(q)
  syncUrlToQuery(q)
}

/** 第一个真有结果的站点，用来自动选中 */
const firstWithItems = () => states.value.find(s => s.status === 'done' && s.items.length)?.siteId

/**
 * 结果一落地就把焦点挪到第一个真有结果的站点 —— 但**只挪一次**。
 * 各站快慢不一，每来一份就重挑一次的话，用户刚点开某个站就会被下一份结果抢走。
 */
const autoPicked = ref(false)
watch(states, () => {
  if (!autoPicked.value) {
    const id = firstWithItems()
    if (id) { activeId.value = id; autoPicked.value = true }
  }
  // 存盘必须在自动选中那段**外面**：写在里面的话，第一个站落地后 autoPicked 就为 true，
  // 后面几站的结果一份都存不进去，表现是「点进一条结果再回来，只剩第一个站有数据」（踩过）
  saveCache()
}, { deep: true })

// ── 地址栏同步 ──
// 用原生 replaceState 而非 router.replace：本页只读 window.location.search，
// 避免 query 变化触发路由重解析，也不污染后退栈（与 /video-parse、/video-player 同一套做法）
const syncUrlToQuery = (kw: string) => {
  if (typeof window === 'undefined') return
  window.history.replaceState(window.history.state, '', location.pathname + (kw ? '?kw=' + encodeURIComponent(kw) : ''))
}

onMounted(() => {
  const kw = (new URLSearchParams(window.location.search).get('kw') ?? '').trim()

  // 地址栏没带 kw = 从导航进来的，**就该是一张空白页**。
  // 早先这里会把上次的搜索摆回来、还顺手把 ?kw= 写回地址栏，于是点侧边栏「按片名搜索」
  // 会莫名其妙落在上一次搜过的词上（踩过）。缓存只服务「带着 kw 刷新/回退」那一种情况。
  if (!kw) return

  input.value = kw
  // 命中缓存就直接摆回来，不必再等一轮各站搜索
  if (restoreCache(kw)) {
    const id = firstWithItems()
    if (id) { activeId.value = id; autoPicked.value = true }
    return
  }
  run(kw)
})
</script>
