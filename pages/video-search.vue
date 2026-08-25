<template>
  <div class="relative max-w-[92rem] mx-auto">
    <!--
      两团极淡的光斑铺在整页最底下（pointer-events-none + -z-10，绝不吃点击）。
      layouts 里那层渐变是通铺的，本页需要一个「视线落点」——光斑压在搜索框正后方，
      眼睛自然被带到那里。透明度全在 10% 以下，靠 blur-3xl 化开，看得出「有点暖」就够了
    -->
    <div
      class="pointer-events-none absolute inset-x-0 -top-24 -z-10 overflow-hidden h-96 transition-opacity duration-700"
      :class="compact ? 'opacity-40' : 'opacity-100'"
    >
      <div class="wf-drift absolute left-1/2 -translate-x-[60%] top-0 w-[28rem] h-[28rem] rounded-full
                  bg-rose-300/20 dark:bg-rose-500/10 blur-3xl" />
      <div class="wf-drift absolute left-1/2 translate-x-[10%] top-10 w-[24rem] h-[24rem] rounded-full
                  bg-violet-300/20 dark:bg-violet-500/10 blur-3xl" style="animation-delay: -7s" />
    </div>

    <div class="transition-all duration-500" :class="compact ? 'space-y-3' : 'space-y-6'">
      <!--
        搜完就把大标题收起来（`compact`）：这一页搜完之后的主角是结果网格，
        而「按片名搜索」这句话，用户点进来那一刻起就一直知道自己在哪，占着一屏顶部纯属浪费。
        收起用 grid-rows 0fr↔1fr 的写法而不是 v-if：高度是「内容有多高就多高」，
        不用为标题写死一个 max-height（字号一改就穿帮），而且 0fr 是可过渡的，收放都有动画
      -->
      <div
        class="grid transition-all duration-500 ease-out"
        :class="compact ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'"
      >
        <div class="overflow-hidden">
          <!-- 标题跟站点主视觉对齐（渐变字），副标题压成一行小字：
               这一页真正的主角是下面那个搜索框，标题不该抢戏 -->
          <div class="text-center pt-2 wf-fade-up">
            <h1 class="text-4xl sm:text-5xl font-bold tracking-tight bg-gradient-to-r from-rose-500 via-pink-500 to-violet-500
                       bg-clip-text text-transparent pb-1">
              按片名搜索
            </h1>
            <p class="text-base text-gray-500 dark:text-gray-400 mt-2">
              一个片名，各站同时搜 · 点一格直接送去解析
            </p>
          </div>
        </div>
      </div>

      <!--
        搜完（compact）之后页面已经变宽，搜索框、结果摘要、搜索历史三样各占一整行居中摆着
        全是浪费——页面两侧一大片空白。改成三栏：搜索框仍居中，摘要挪去左边、历史挪去右边，
        `lg:` 才生效——窄屏三样宽度都不够分栏，退回原来的纵向堆叠（先搜索框，摘要和历史跟着）。
        用 grid-template-columns 显式分栏而不是 flex + margin，是因为要「两侧宽度相等地把
        搜索框夹在正中间」，flex 只能做到「谁占的空间大小取决于内容」，两侧文字长度一长一短
        就会把搜索框顶偏
      -->
      <div
        class="wf-fade-up transition-all duration-500 ease-out"
        :class="compact ? 'grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-3' : 'flex flex-col items-center gap-3'"
      >
        <!--
          搜索框不套 UCard：卡片的白底 + 边框会把它压成一个普通表单区块，
          而它是这一页唯一的入口。做成一条悬浮的玻璃条（半透明 + backdrop-blur + 柔光投影），
          聚焦时外面那圈渐变光晕亮起来 —— 「高级感」是这么来的，不是靠把粉色调重
        -->
        <div
          class="relative w-full transition-all duration-500 ease-out"
          :class="compact ? 'max-w-md lg:max-w-sm lg:col-start-2 lg:row-start-1 lg:justify-self-center' : 'max-w-none'"
          style="animation-delay: 60ms"
        >
        <!--
          这里**没有**外发光。试过在框外糊一圈渐变光晕，但 input 带 autofocus，
          一进页面它就恒亮，整条搜索框糊成一片粉，反倒像没做完的样式。
          聚焦反馈只留「描边转成玫瑰色 + 投影加深一档」——够清楚，也不抢戏
        -->
        <div
          class="relative flex items-center gap-2 rounded-2xl
                 bg-white/80 dark:bg-white/[0.06] backdrop-blur-xl
                 ring-1 transition-all duration-300"
          :class="[
            focused ? 'ring-rose-300/70 dark:ring-rose-400/30' : 'ring-black/5 dark:ring-white/10',
            compact
              ? 'px-1.5 py-1.5 shadow-md shadow-rose-100/40 dark:shadow-black/20'
              : 'px-2 py-2 shadow-lg shadow-rose-100/50 dark:shadow-black/20',
          ]"
        >
          <UIcon
            name="i-heroicons-magnifying-glass"
            class="shrink-0 transition-all duration-300"
            :class="[
              focused ? 'text-rose-500' : 'text-gray-400',
              compact ? 'w-4 h-4 ml-2' : 'w-5 h-5 ml-2.5',
            ]"
          />
          <!--
            用原生 input 而不是 UInput：这里要的是「无边框、直接坐在玻璃条上」，
            UInput 自带底色和 ring，得靠一串 :ui 覆盖去拆自己的样式，不如直接写
          -->
          <input
            v-model="input"
            type="search"
            placeholder="片名，如：东宫"
            autofocus
            class="flex-1 min-w-0 bg-transparent border-0 outline-none transition-all duration-300
                   text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500
                   [&::-webkit-search-cancel-button]:hidden"
            :class="compact ? 'py-1.5 text-sm' : 'py-2.5 text-base'"
            @focus="focused = true"
            @blur="focused = false"
            @keyup.enter="run()"
          >
          <button
            type="button"
            :disabled="!input.trim() || searching"
            class="shrink-0 flex items-center gap-1.5 rounded-xl font-medium text-white
                   bg-gradient-to-r from-rose-500 to-pink-500
                   shadow-md shadow-rose-300/40 dark:shadow-none
                   transition-all duration-300 hover:shadow-lg hover:shadow-rose-300/50 hover:brightness-105
                   active:scale-[0.97] disabled:opacity-40 disabled:shadow-none disabled:cursor-not-allowed
                   disabled:hover:brightness-100"
            :class="compact ? 'px-3.5 py-1.5 text-[13px]' : 'px-4 sm:px-5 py-2.5 text-sm'"
            @click="run()"
          >
            <UIcon
              :name="searching ? 'i-heroicons-arrow-path' : 'i-heroicons-magnifying-glass'"
              class="w-4 h-4"
              :class="{ 'animate-spin': searching }"
            />
            <span class="hidden sm:inline">搜索</span>
          </button>
        </div>
      </div>

      <!-- 只数真正会去搜的站：manual 的那几个（源站有人机校验）压根不发请求，
           算进去会让人以为它们也在搜、然后奇怪为什么永远没结果 -->
      <!-- 搜之前讲规则（哪些站会搜、哪些只能去源站），搜之后只报结果：
           「N 个站点并发搜索」这句话在结果已经摆在眼前时没有任何用处，还占一行。
           **必须是搜索框的兄弟节点，不能再套一层公共容器**：套了一层的话这一整块只算
           网格里的一个格子，摘要和历史会被挤在同一个格子里自己换行，压根到不了另一侧
           （踩过：摘要和历史贴在一起飘在搜索框左边，看着比之前更乱） -->
      <p
        class="shrink-0 text-xs text-gray-500 dark:text-gray-400 wf-fade-up"
        :class="compact ? 'lg:col-start-1 lg:row-start-1 lg:justify-self-start' : 'w-full text-center'"
        style="animation-delay: 120ms"
      >
        <template v-if="compact">
          「<span class="text-gray-700 dark:text-gray-200">{{ keyword }}</span>」·
          {{ autoCount }} 站合计 <span class="font-semibold text-rose-500">{{ totalFound }}</span> 个结果
        </template>
        <template v-else>
          {{ autoCount }} 个站点并发搜索，谁先回来先显示<template v-if="manualNames">；{{ manualNames }} 只能在源站搜</template>。
        </template>
      </p>

      <!--
        搜过的片名。摆成一行小胶囊而不是一张历史卡片：这一页的主角是海报网格，
        而历史的用处只有一个——**点一下重搜**（追剧就是天天搜同一个名字）。
        限 12 条：一行扫得完，再多就成了另一块要读的东西
      -->
      <div
        v-if="kwHistory.length"
        class="wf-fade-up flex items-center gap-1.5 flex-wrap"
        :class="compact ? 'lg:col-start-3 lg:row-start-1 lg:justify-self-end' : 'w-full justify-center'"
        style="animation-delay: 140ms"
      >
        <UIcon name="i-heroicons-clock" class="w-3.5 h-3.5 shrink-0 text-gray-400" />
        <button
          v-for="h in kwHistory.slice(0, 12)"
          :key="h.timestamp"
          type="button"
          class="px-2.5 py-1 rounded-full text-xs cursor-pointer transition-all duration-200
                 ring-1 hover:-translate-y-px active:translate-y-0"
          :class="h.data.kw === keyword
            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-300 ring-rose-300/70 dark:ring-rose-400/25 font-medium'
            : 'bg-white/70 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400 ring-black/5 dark:ring-white/10 hover:text-rose-600 dark:hover:text-rose-300 hover:ring-rose-200 dark:hover:ring-rose-400/20'"
          @click="input = h.data.kw; run(h.data.kw)"
        >{{ h.data.kw }}</button>
        <button
          type="button"
          class="px-2 py-1 rounded-full text-xs text-gray-400 hover:text-red-500 cursor-pointer transition-colors"
          title="清空搜索历史"
          @click="clearKwHistory"
        >清空</button>
      </div>

      </div>

      <div
        v-if="keyword"
        class="wf-fade-up rounded-2xl bg-white/70 dark:bg-white/[0.04] backdrop-blur-sm
               ring-1 ring-black/5 dark:ring-white/10 shadow-sm p-5 sm:p-6 space-y-5"
        style="animation-delay: 160ms"
      >
        <!-- 站点改横排按钮，点哪个看哪个的结果，下面整块留给海报网格 -->
        <VideoSearchSiteRail
          :model-value="activeId"
          :states="states"
          @update:model-value="activeId = $event"
        />

        <VideoSearchSiteResults
          v-if="activeState"
          :key="activeState.siteId"
          :state="activeState"
          :keyword="keyword"
          @retry="retrySite(activeState.siteId)"
          @page="goPage(activeState.siteId, $event)"
        />
      </div>

      <!-- 还没搜过时的空状态：与其画一个灰扑扑的占位框，不如把「有哪些站」摆出来当预告 -->
      <div v-else class="wf-fade-up py-12 text-center space-y-4" style="animation-delay: 160ms">
        <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-rose-100 to-violet-100
                    dark:from-rose-500/15 dark:to-violet-500/10 flex items-center justify-center
                    ring-1 ring-white/60 dark:ring-white/10 shadow-sm">
          <UIcon name="i-heroicons-film" class="w-8 h-8 text-rose-400/80" />
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400">输入片名开始搜索</p>
        <div class="flex flex-wrap justify-center gap-2 pt-1">
          <span
            v-for="s in states"
            :key="s.siteId"
            class="px-2.5 py-1 rounded-full text-xs text-gray-500 dark:text-gray-400
                   bg-white/70 dark:bg-white/[0.06] ring-1 ring-black/5 dark:ring-white/10"
          >{{ s.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const { keyword, states, searching, totalFound, search, retrySite, goPage, saveCache, restoreCache, reset } = useVideoSearch()

const input = ref('')
const focused = ref(false)

/**
 * 搜完就换成紧凑版：收起大标题、搜索框缩窄上提。
 * 判据就是「搜过没有」——一旦有结果，这一页的主角就是结果网格，
 * 标题和一条通栏的输入框再占掉大半屏，用户每次都得先滚一段才看得到片。
 */
const compact = computed(() => !!keyword.value)

// 选中的站点按 **id** 记，不按下标：规则表增删站点后下标会指到别人身上
const activeId = ref(states.value[0]?.siteId ?? '')
const activeState = computed(() => states.value.find(s => s.siteId === activeId.value) ?? states.value[0])

const autoCount = computed(() => states.value.filter(s => s.status !== 'manual').length)
const manualNames = computed(() => states.value.filter(s => s.status === 'manual').map(s => s.name).join('、'))

// ── 搜索历史 ──
// 与解析历史同一套（`utools-history-video-search`，含持久化授权那一整套说法）。
// `bump: true`：反复搜同一个片名是常态（今天搜、明天接着看），默认「重复就丢弃」会让
// 最常搜的词永远停在末尾、先被淘汰。
const { addToHistory, getHistory, clearHistory } = useHistory<{ kw: string }>('video-search', { maxItems: 200 })
const kwHistory = ref(getHistory())
const clearKwHistory = () => { clearHistory(); kwHistory.value = [] }

// 这个 ref 是打开页面那一刻的快照，而云同步是直接写 localStorage 的
// ——不重读的话「另一台设备搜过的词」要刷新页面才出现
onBeforeUnmount(onSyncApplied('video-search', () => { kwHistory.value = getHistory() }))

const run = (kw = input.value) => {
  const q = kw.trim()
  if (!q) return
  autoPicked.value = false
  search(q)
  syncUrlToQuery(q)
  // 搜下去那一刻就记，不等结果：搜出 0 条也是一次「我搜过这个」，
  // 而且各站是异步落地的，等「有结果了」再记就得挑一个说不清的时机
  addToHistory({ kw: q }, { bump: true })
  kwHistory.value = getHistory()
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
//
// 这一页**必须走 router 而不是 history.replaceState**（与 /video-parse、/video-player 相反）。
// 那两页手写 replaceState 是为了绕开「视频地址自带未编码 & 会被路由拆散」那个坑，
// 代价是 vue-router 不知道地址栏变过。本页没有那个坑（kw 就是个词，router 自己会编码），
// 却有另一个需求：**点侧边栏「按片名搜索」要能清空重来**。
// 那是一次同路由跳转，组件不会重新挂载、onMounted 不会再跑，只有 route.query 变得出来——
// 而 replaceState 写进去的 kw 在 router 眼里根本不存在，跳转前后 query 都是空，等于没变化，
// 于是页面继续挂着上一次的关键词和整屏结果（踩过）。
const route = useRoute()
const router = useRouter()

const syncUrlToQuery = (kw: string) => {
  void router.replace({ query: kw ? { kw } : {} })
}

/** 按地址栏里的 kw 把页面摆成对应的样子。命中缓存就不发请求 */
const applyKeyword = (kw: string) => {
  input.value = kw
  autoPicked.value = false
  if (restoreCache(kw)) {
    const id = firstWithItems()
    if (id) { activeId.value = id; autoPicked.value = true }
    return
  }
  search(kw)
}

const queryKw = () => {
  const v = route.query.kw
  return (Array.isArray(v) ? v[0] : v ?? '').toString().trim()
}

// 地址栏的 kw 变了就跟着走：点导航进来（kw 没了）→ 清空；点浏览器前进/后退 → 摆回那一次。
// **自己刚写进去的值要跳过**，否则 run() 里的 syncUrlToQuery 会绕回来再搜一遍
watch(() => route.query.kw, () => {
  const kw = queryKw()
  if (kw === keyword.value) return
  if (!kw) { reset(); input.value = ''; autoPicked.value = false; return }
  applyKeyword(kw)
})

onMounted(() => {
  // 地址栏没带 kw = 从导航进来的，**就该是一张空白页**。
  // 早先这里会把上次的搜索摆回来、还顺手把 ?kw= 写回地址栏，于是点侧边栏「按片名搜索」
  // 会莫名其妙落在上一次搜过的词上（踩过）。缓存只服务「带着 kw 刷新/回退」那一种情况。
  const kw = queryKw()
  if (kw) applyKeyword(kw)
})
</script>
