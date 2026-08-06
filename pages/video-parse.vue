<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频解析</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
        粘贴视频站的播放页地址，解析出整季选集的真实播放地址，一键送进播放器
      </p>
    </div>

    <!-- 输入 -->
    <UCard>
      <div class="space-y-3">
        <UFormGroup label="播放页地址">
          <div class="flex gap-2">
            <UInput
              v-model="inputUrl"
              placeholder="https://www.example.com/play/123-4-567.html"
              icon="i-heroicons-link"
              class="flex-1"
              :disabled="busy"
              @keyup.enter="startResolve()"
            />
            <UButton
              icon="i-heroicons-magnifying-glass"
              :loading="busy"
              :disabled="!inputUrl.trim()"
              @click="startResolve()"
            >
              解析
            </UButton>
          </div>
        </UFormGroup>

        <div class="flex items-center gap-2 flex-wrap text-sm">
          <UBadge v-if="matchedRule" color="green" variant="soft" size="xs">
            规则：{{ matchedRule.name }}
          </UBadge>
          <UBadge v-else-if="inputUrl.trim()" color="orange" variant="soft" size="xs">
            没有匹配的解析规则
          </UBadge>
        </div>

        <!-- 进度 -->
        <div v-if="busy" class="space-y-2">
          <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" />
            <span>{{ stage }}</span>
          </div>
          <UProgress v-if="powTried > 0" :value="powPercent" size="xs" />
        </div>

        <UAlert
          v-if="error"
          color="red"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
          :title="error"
        />
      </div>
    </UCard>

    <!-- 结果 -->
    <UCard v-if="result">
      <template #header>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-2 min-w-0">
            <UIcon name="i-heroicons-film" class="w-5 h-5 shrink-0 text-violet-500" />
            <span class="font-medium truncate">{{ result.title || '解析结果' }}</span>
            <UBadge color="violet" variant="soft" size="xs">
              {{ currentLine?.name }}{{ currentLine?.sublabel ? ' · ' + currentLine.sublabel : '' }}
            </UBadge>
          </div>
          <div class="flex gap-2">
            <UButton size="xs" variant="ghost" icon="i-heroicons-share" title="复制带地址和线路的本页链接" @click="copyPageLink">
              分享本页
            </UButton>
            <UButton size="xs" variant="soft" icon="i-heroicons-clipboard" @click="copyAll">
              复制全部地址
            </UButton>
            <UButton
              size="xs"
              icon="i-heroicons-play"
              :disabled="!resolvedCount"
              @click="playAll()"
            >
              播放全部 ({{ resolvedCount }})
            </UButton>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <!-- 线路 -->
        <div class="space-y-2">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
            切换线路
            <span class="font-normal text-gray-400">（切换会重新解析该线路的全部集数）</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="(line, i) in result.lines"
              :key="i"
              size="xs"
              :color="i === result.activeLineIndex ? 'violet' : 'gray'"
              :variant="i === result.activeLineIndex ? 'solid' : 'soft'"
              :disabled="busy"
              :class="deadLines.has(i) ? 'opacity-40 line-through' : ''"
              :title="deadLines.has(i) ? '该线路不提供直链' : ''"
              @click="startResolve(i)"
            >
              {{ line.name }}
              <span v-if="line.sublabel" class="opacity-60 ml-1">{{ line.sublabel }}</span>
              <UBadge color="gray" variant="solid" size="xs" class="ml-1">{{ line.episodes.length }}</UBadge>
            </UButton>
          </div>
        </div>

        <UAlert
          v-if="result.lineUnsupported"
          color="red"
          variant="soft"
          icon="i-heroicons-no-symbol"
          :title="`「${currentLine?.name}」线路不提供直链`"
          description="这类线路的页面把播放地址留空，改由播放器运行时另行获取，服务端拿不到。换一条线路即可。"
        />

        <UAlert
          v-if="result.remaining > 0 && !busy"
          color="orange"
          variant="soft"
          icon="i-heroicons-exclamation-circle"
          :title="`还有 ${result.remaining} 集未解析（共 ${currentLine?.episodes.length || 0} 集）`"
          description="解析中断了，重新点「解析」可以继续。"
        />

        <UAlert
          v-if="hasSignedUrl"
          color="amber"
          variant="soft"
          icon="i-heroicons-clock"
          title="该线路的地址带时效签名"
          description="地址里含 sign/timestamp，过一段时间会失效，届时重新解析即可。不建议长期收藏或分享。"
        />

        <!-- 选集 -->
        <div class="space-y-2">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
            选集（{{ resolvedCount }}/{{ currentLine?.episodes.length || 0 }} 解析成功）
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              v-for="(ep, i) in currentLine?.episodes || []"
              :key="i"
              class="flex items-center gap-2 p-2 rounded-lg text-sm bg-gray-50 dark:bg-gray-800"
            >
              <UIcon
                :name="ep.videoUrl ? 'i-heroicons-check-circle' : 'i-heroicons-x-circle'"
                class="w-4 h-4 shrink-0"
                :class="ep.videoUrl ? 'text-green-500' : 'text-gray-400'"
              />
              <div class="min-w-0 flex-1">
                <div class="font-medium truncate">{{ ep.title || `第 ${i + 1} 集` }}</div>
                <div class="text-xs text-gray-400 truncate">
                  {{ ep.videoUrl || ep.error || '未解析' }}
                </div>
              </div>
              <UButton
                v-if="ep.videoUrl"
                size="2xs"
                variant="ghost"
                icon="i-heroicons-clipboard"
                title="复制地址"
                @click="copyOne(ep.videoUrl)"
              />
              <UButton
                v-if="ep.videoUrl"
                size="2xs"
                variant="ghost"
                icon="i-heroicons-play"
                title="从这一集开始播放"
                @click="playAll(i)"
              />
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- 历史 -->
    <UCard v-if="parseHistory.length">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-medium">解析历史</span>
          <UButton size="xs" variant="ghost" color="red" @click="clearAllHistory">清空</UButton>
        </div>
      </template>
      <div class="space-y-1">
        <div
          v-for="(h, i) in parseHistory"
          :key="i"
          class="flex items-center gap-2 p-2 rounded text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
          @click="inputUrl = h.data.url; startResolve()"
        >
          <UIcon name="i-heroicons-clock" class="w-4 h-4 shrink-0 text-gray-400" />
          <span class="flex-1 truncate">{{ h.data.title || h.data.url }}</span>
          <span class="text-xs text-gray-400 shrink-0">{{ formatWhen(h.timestamp) }}</span>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import type { ParseResult, ParseRule } from '~/composables/videoParseRules'

const toast = useToast()

const inputUrl = ref('')
const busy = ref(false)
const stage = ref('')
const error = ref('')
const result = ref<ParseResult | null>(null)

// 期望迭代约 65536 次；进度条只是给个「在动」的感觉，超过就压在 95%
const powTried = ref(0)
const powPercent = computed(() => Math.min(95, Math.round((powTried.value / 65536) * 100)))

// 解出的 cookie 在本次会话内复用：实测同站不同影片页共用同一挑战常量，
// 只有第一次解析需要算 PoW
const powCookie = ref('')
const lastParsedUrl = ref('')

const userRules = ref<ParseRule[]>([])
const matchedRule = computed(() => {
  const u = inputUrl.value.trim()
  if (!u) return null
  return matchParseRule(u, userRules.value)
})

const currentLine = computed(() => result.value?.lines[result.value.activeLineIndex] ?? null)
const resolvedEpisodes = computed(() => (currentLine.value?.episodes || []).filter(e => e.videoUrl))
const resolvedCount = computed(() => resolvedEpisodes.value.length)
const hasSignedUrl = computed(() =>
  resolvedEpisodes.value.some(e => /[?&](sign|timestamp|token|auth_key)=/i.test(e.videoUrl || '')),
)

// 已探明不给直链的线路（本次解析内记忆），置灰避免用户反复去点
const deadLines = ref(new Set<number>())

const { addToHistory, getHistory, clearHistory } = useHistory<{ url: string; title?: string }>('video-parse')
const parseHistory = ref(getHistory())

const formatWhen = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

const callResolve = (step: string, cookie: string, line?: number, offset?: number) =>
  $fetch<any>('/api/resolve', {
    query: {
      step,
      url: inputUrl.value.trim(),
      ...(cookie ? { cookie } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(offset ? { offset } : {}),
      ...(userRules.value.length ? { rules: JSON.stringify(userRules.value) } : {}),
    },
  })

// 续拉轮数上限：单批 40 集，20 轮足够 800 集，纯粹防死循环
const MAX_BATCHES = 20

/**
 * 长剧要分多批才拉得完（单请求的子请求数有上限）。
 * 首批回来后，只要 remaining > 0 就继续带 offset 拉下一批，把地址合并进已有结构。
 */
const fetchRemainingBatches = async (first: ParseResult, cookie: string, line?: number) => {
  const lineIdx = first.activeLineIndex
  const episodes = first.lines[lineIdx]?.episodes ?? []
  const total = episodes.length
  let next = first

  for (let round = 0; round < MAX_BATCHES && next.remaining > 0; round++) {
    stage.value = `正在解析选集 ${next.batchTo}/${total}…`
    const batch: ParseResult = await callResolve('extract', cookie, line, next.batchTo)

    // 每批返回的都是完整选集结构，但只有本批那几集带 videoUrl，按下标合并进来
    const got = batch.lines[batch.activeLineIndex]?.episodes ?? []
    for (let i = batch.batchFrom; i < batch.batchTo && i < total; i++) {
      if (!got[i]) continue
      episodes[i].videoUrl = got[i].videoUrl
      episodes[i].error = got[i].error
    }

    next = batch
    // 触发重渲染：改的是嵌套数组元素，Vue 3 的深层响应能覆盖，这里只更新进度字段
    result.value = { ...first, batchTo: batch.batchTo, remaining: batch.remaining }
  }

  if (next.remaining > 0) {
    toast.add({ title: `已解析 ${next.batchTo}/${total} 集`, description: '剩余集数过多，已停在安全上限', color: 'orange' })
  }
}

const startResolve = async (line?: number) => {
  const url = inputUrl.value.trim()
  if (!url || busy.value) return

  busy.value = true
  error.value = ''
  powTried.value = 0
  stage.value = '正在获取页面…'

  try {
    let res = await callResolve(powCookie.value ? 'extract' : 'challenge', powCookie.value, line)

    // 站点要求先过工作量证明 → 本地算 nonce 再重试
    if (res?.needPow) {
      stage.value = '正在计算站点校验…'
      const pow = await solvePow(res.c, res.n1, res.target, {
        onProgress: n => { powTried.value = n },
      })
      powCookie.value = pow.cookie
      stage.value = `校验通过（${pow.tried} 次 / ${pow.ms}ms），正在解析选集…`
      res = await callResolve('extract', pow.cookie, line)
    } else {
      stage.value = '正在解析选集…'
    }

    result.value = res as ParseResult
    // 首批只覆盖前 40 集，长剧要继续把后面的批次拉完
    if (res.remaining > 0) await fetchRemainingBatches(res as ParseResult, powCookie.value, line)

    // 换了片子就把上一部的死线路记录清掉（线路序号只在同一部片子里有意义）
    if (res.pageUrl !== lastParsedUrl.value) {
      deadLines.value = new Set()
      lastParsedUrl.value = res.pageUrl
    }
    if (res.lineUnsupported) deadLines.value.add(res.activeLineIndex)

    addToHistory({ url, title: res.title })
    parseHistory.value = getHistory()
    syncUrlToQuery()   // 地址栏跟着当前地址+线路走，随时可复制分享
  } catch (e: any) {
    // 409 = 服务端说 cookie 失效：丢掉重算一轮，只重试一次避免死循环
    const status = e?.statusCode || e?.response?.status
    if (status === 409 && powCookie.value) {
      powCookie.value = ''
      busy.value = false
      return startResolve(line)
    }
    error.value = e?.statusMessage || e?.data?.statusMessage || e?.message || '解析失败'
  } finally {
    busy.value = false
    stage.value = ''
    // 失败时也要把地址写回去：刷新页面能直接重试同一个地址。
    // 此时 syncUrlToQuery 里的 pageUrl 校验会自动省掉 line，不会带上残留线路号
    syncUrlToQuery()
  }
}

// ── URL 参数双向同步 ──────────────────────────────────────────
// 参数：url（播放页地址）、line（线路序号，0 基）
//
// 与 video-player 同一套做法，包括那个坑：播放页地址自带 query（?id=1&t=2）时，
// 未编码的 & 会被拆成独立参数，直接读 route.query.url 只能拿到第一段。
// 所以从原始 search 串手工解析，凡「不是本页已知参数」的片段原样回写进地址。
const PAGE_QUERY_KEYS = new Set(['url', 'line'])

interface QueryParseParams {
  url?: string
  line?: number
}

const parseQueryParams = (): QueryParseParams => {
  const out: QueryParseParams = {}
  const raw = (typeof window === 'undefined' ? '' : window.location.search).replace(/^\?/, '')
  if (!raw) return out

  // 只做 percent 解码，不把 + 当空格：站点地址里的 + 是字面量，转空格会 404
  const dec = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }

  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const val = eq === -1 ? '' : part.slice(eq + 1)

    if (!PAGE_QUERY_KEYS.has(key)) {
      // 属于播放页地址自己的 query 片段，原样接回去
      if (out.url) out.url += (out.url.includes('?') ? '&' : '?') + part
      continue
    }

    if (key === 'url') out.url = dec(val).trim()
    else if (key === 'line') {
      const n = Number.parseInt(dec(val), 10)
      if (Number.isFinite(n)) out.line = n
    }
  }
  return out
}

// 用原生 replaceState 而非 router.replace：本页只读 window.location.search，
// 不经 vue-router，避免 query 变化触发路由重解析，也不污染后退栈
const syncUrlToQuery = () => {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()
  const u = inputUrl.value.trim()
  if (u) params.set('url', u)
  // 线路序号跟着实际解析的那条走，刷新/分享后能落回同一条线路。
  // 必须校验结果属于当前这个地址——否则解析失败或换了片子时，
  // 会把上一次残留的线路号写进新地址，分享出去直接跳到一条不相干的线路
  if (result.value && result.value.pageUrl === u && result.value.activeLineIndex >= 0) {
    params.set('line', String(result.value.activeLineIndex))
  }
  const qs = params.toString()
  // 必须写全 window.：本组件有个叫 history 的 ref（解析历史），会遮蔽全局 history
  window.history.replaceState(window.history.state, '', qs ? `${location.pathname}?${qs}` : location.pathname)
}

const copyPageLink = async () => {
  await navigator.clipboard.writeText(location.href)
  toast.add({ title: '已复制本页链接', color: 'green' })
}

// 超过这个长度就不往 query 里塞了，改走交接槽。
// 短列表仍走 query，因为那样的链接可以直接复制给别人；交接槽是本机 localStorage，分享不了。
const MAX_QUERY_LEN = 1800

// 播放器持有的长列表交接槽（见 video-player.vue 的 HANDOFF_KEY）
const HANDOFF_KEY = 'video-player-handoff'

const playAll = (startIndex = 0) => {
  const eps = currentLine.value?.episodes || []
  // 播放列表只装解析成功的，索引要按过滤后的位置重新算
  const playable = eps.filter(e => e.videoUrl)
  if (!playable.length) return
  const clicked = eps[startIndex]
  const idx = Math.max(0, playable.findIndex(e => e === clicked))
  const urls = playable.map(e => e.videoUrl!) as string[]

  const params = new URLSearchParams()

  if (urls.join('|').length > MAX_QUERY_LEN) {
    // 几十集拼进 query 会顶爆地址栏，以前是截成 31 集的窗口——等于偷偷丢集数。
    // 改成整份写进交接槽，一集不少
    try {
      localStorage.setItem(HANDOFF_KEY, JSON.stringify({ urls, index: idx, at: Date.now() }))
      params.set('handoff', '1')
    } catch (e) {
      // localStorage 满了/被禁 → 退回 query，此时只能带得下多少算多少
      console.error('写入播放列表交接槽失败，退回 query 传递:', e)
      params.set('urls', urls.slice(0, 31).join('|'))
      params.set('index', String(Math.min(idx, 30)))
      toast.add({ title: '浏览器存储不可用，本次只带 31 集', color: 'orange' })
    }
  } else {
    params.set('urls', urls.join('|'))
    params.set('index', String(idx))
  }

  // 只在规则显式声明时才带 referer：写死策略会置 manualStrategyOverride，
  // 把播放器的自动可达性探测整个关掉，通常反而更慢
  if (result.value?.referer) params.set('referer', result.value.referer)

  navigateTo('/video-player?' + params.toString())
}

const copyOne = async (url: string) => {
  await navigator.clipboard.writeText(url)
  toast.add({ title: '已复制', color: 'green' })
}

const copyAll = async () => {
  const text = resolvedEpisodes.value.map(e => e.videoUrl).join('\n')
  if (!text) return
  await navigator.clipboard.writeText(text)
  toast.add({ title: `已复制 ${resolvedEpisodes.value.length} 条地址`, color: 'green' })
}

const clearAllHistory = () => {
  clearHistory()
  parseHistory.value = []
}

onMounted(() => {
  userRules.value = loadUserParseRules()
  // 支持 /video-parse?url=…&line=N 直接带地址进来自动解析
  const q = parseQueryParams()
  if (q.url) {
    inputUrl.value = q.url
    startResolve(q.line)
  }
})
</script>
