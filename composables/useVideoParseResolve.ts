import type { WatchRecord } from '~/composables/useWatchHistory'
// 普通导出显式 import（不是 use* 组合式，靠自动导入会被数组常量那个坑吃掉，见 CLAUDE.md）
import { onSyncApplied } from '~/composables/cloudSyncLocal'
import type { ParseResult, ParseRule } from '~/composables/videoParseRules'

/**
 * 解析页的核心状态与解析流程：输入、规则匹配、线路/集数派生、解析历史存储、
 * 结果缓存与 URL 参数双向同步。其余组合式（播放前确认、内嵌播放器、历史展示）
 * 都以本函数的返回对象为共享上下文。
 */
export function useVideoParseResolve() {
  const toast = useToast()

  const inputUrl = ref('')
  const busy = ref(false)
  const stage = ref('')
  const error = ref('')
  const result = ref<ParseResult | null>(null)

  // 期望迭代约 65536 次；进度条只是给个「在动」的感觉，超过就压在 95%
  const powTried = ref(0)
  const powPercent = computed(() => Math.min(95, Math.round((powTried.value / 65536) * 100)))

  // 解出的 cookie 在本次会话内复用（实测同站不同影片页共用同一挑战常量，只有第一次要算 PoW），
  // 缓存与「令牌被拒就重算一轮」都收在 usePowCookie 里——播放器的按需取址也要用同一份，
  // 各页留一份必然漂移
  const lastParsedUrl = ref('')

  const userRules = ref<ParseRule[]>([])
  // 清单从规则表现算，不硬编码站名：加站点只需改 videoParseRules.ts 的两张表，这里自动跟上
  const supportedSites = computed(() => listParseSites(userRules.value))
  const matchedRule = computed(() => {
    const u = inputUrl.value.trim()
    if (!u) return null
    return matchParseSite(u, userRules.value)
  })

  /**
   * 历史条目的站点标签。走 `matchParseSite`（跟输入框那个徽标同一个来源，站名只该有一处），
   * 认不出就退回裸域名——历史能存 2000 条、跨很久，期间规则可能被删掉或改了 pattern，
   * 那时显示域名也比显示空白有用。`known` 只用来决定徽标颜色。
   */
  const historySite = (url: string): { label: string; known: boolean } => {
    const hit = matchParseSite(url, userRules.value)
    if (hit) return { label: hit.name, known: true }
    try { return { label: new URL(url).hostname.replace(/^www\./, ''), known: false } } catch { return { label: '未知来源', known: false } }
  }

  // ── 续看 ──
  // 记录按剧名存（换站、换线路也能续上），见 composables/useWatchHistory.ts
  const { findWatch, forgetWatch } = useWatchHistory()
  const resumeWatch = ref<WatchRecord | null>(null)

  // 云端的追剧进度到货了就重查一次：同步是异步的，多半比解析晚回来，
  // 不重查的话另一台设备追到的集数拉回来了、这条提示上还写着本机那份旧值
  const offWatchSync = onSyncApplied('video-watch', () => {
    const r = result.value
    if (r) resumeWatch.value = findWatch({ title: r.title, pageUrl: r.pageUrl })
  })
  onBeforeUnmount(() => offWatchSync())
  /** 用户在本次解析里点了「不用了」——只压这一次，不删记录（他可能只是想先看别的集） */
  const resumeDismissed = ref(false)

  // ── 收藏 ──
  // 与播放器侧边抽屉共用同一份清单（`video-favorites`，按剧名存、跟着账号同步）。
  // 存的是「怎么再找到这部剧」：来源页 + 线路 + 封面，**一个播放地址都不存**（带签名，存下来就是死链）
  const { isFav, toggleFav } = useFavorites()
  const faved = ref(false)
  const favRef = () => ({ title: result.value?.title, pageUrl: result.value?.pageUrl })
  // 解析出新结果（或换了线路）就重算一次：这颗按钮的状态是「这部剧收了没」
  watch(result, () => { faved.value = isFav(favRef()) })

  const currentLine = computed(() => result.value?.lines[result.value.activeLineIndex] ?? null)
  const resolvedEpisodes = computed(() => (currentLine.value?.episodes || []).filter(e => e.videoUrl))
  const resolvedCount = computed(() => resolvedEpisodes.value.length)

  // 按需取址的站点：站点限流，不许一次把整季取完，所以这里只取了当前这一集，
  // 其余集在播放器里播到哪集才取哪集。界面上要按「全部可播」来呈现，不能按已解析数算
  const isLazy = computed(() => !!result.value?.clientTask?.lazy)
  const playableCount = computed(() =>
    isLazy.value ? (currentLine.value?.episodes.length ?? 0) : resolvedCount.value,
  )
  // 「可达性检测」测哪一集：第一条已经解析出真实地址的。
  // 按需取址的站点也有一条（解析页只取当前这一集），内嵌 / 不给直链的线路则一条都没有 → 整块不显示
  const checkTarget = computed(() => {
    const eps = currentLine.value?.episodes || []
    const i = eps.findIndex(e => e.videoUrl)
    return i < 0 ? null : { url: eps[i]!.videoUrl!, title: eps[i]!.title || `第 ${i + 1} 集` }
  })

  const hasSignedUrl = computed(() =>
    // Expires/Signature 是 S3 风格预签名地址的标志（4kvm 的部分集数走网盘直链就是这种）
    resolvedEpisodes.value.some(e => /[?&](sign|signature|timestamp|token|auth_key|expires)=/i.test(e.videoUrl || '')),
  )

  // ── 内嵌线路的地址状态 ──
  // 由 startResolve / restoreFromCache 写入，供内嵌播放器（useVideoParseEmbed）读取
  const embedSrc = ref('')
  const embedIndex = ref(-1)     // 内嵌播的是第几集，-1 = 还没点

  // 已探明不给直链的线路（本次解析内记忆），置灰避免用户反复去点
  const deadLines = ref(new Set<number>())

  // 解析历史要「永久保存」：条数上限从默认 50 提到 2000（一条只有 ~120 字节，2000 条也就 240KB，
  // 对着 256MB 的总量护栏毫无压力）。不做成完全不封顶——那样迟早会有人的历史攒到几万条，
  // 光渲染就卡，而这条列表的实际用途是「翻回最近看过的片子」。
  // 真正决定它能活多久的不是这个数字，而是 storagePersisted（见 useHistory 的 requestPersistentStorage）。
  const { addToHistory, getHistory, clearHistory, storagePersisted, refreshPersistedState }
    = useHistory<{ url: string; title?: string }>('video-parse', { maxItems: 2000 })
  const parseHistory = ref(getHistory())

  const startResolve = async (line?: number) => {
    const url = inputUrl.value.trim()
    if (!url || busy.value) return

    busy.value = true
    error.value = ''
    powTried.value = 0
    stage.value = '正在获取页面…'

    try {
      // 工作量证明 + 分批续拉都在 useResolvePlaylist 里，与播放器的「刷新链接」共用同一套
      const { result: res } = await resolvePlaylist({
        pageUrl: url,
        line,
        rules: userRules.value,
        onStage: t => { stage.value = t },
        onPow: n => { powTried.value = n },
      })
      result.value = res

      // 传进来的是**详情页**时（搜索结果、或用户自己粘的），服务端会换成第 1 集的播放页，
      // 这里把输入框跟着改过去。不改的话 syncUrlToQuery 里那道「结果属不属于当前地址」的校验
      // 不成立，`line` 永远写不进地址栏，分享出去就丢了线路；结果缓存也会按详情页存，
      // 下次带 line 回来对不上、白解析一轮
      if (res.pageUrl && res.pageUrl !== url) inputUrl.value = res.pageUrl

      // 内嵌播放器归位：换线路/换片子后 iframe 还停在上一条线路的那一集，
      // 而下面的集名早就换了，对不上。服务端探测到的那一集就是起点。
      // 「限制广告」不复位：它是用户的偏好，不是某条线路的临时状态
      embedSrc.value = res.embedUrl || ''
      embedIndex.value = res.embedUrl
        ? (res.lines[res.activeLineIndex]?.episodes.findIndex(e => e.embedUrl === res.embedUrl) ?? -1)
        : -1

      if (res.remaining > 0) {
        const total = res.lines[res.activeLineIndex]?.episodes.length ?? 0
        toast.add({ title: `已解析 ${res.batchTo}/${total} 集`, description: '剩余集数过多，已停在安全上限', color: 'orange' })
      }

      // 换了片子就把上一部的死线路记录清掉（线路序号只在同一部片子里有意义）
      if (res.pageUrl !== lastParsedUrl.value) {
        deadLines.value = new Set()
        lastParsedUrl.value = res.pageUrl
      }
      if (res.lineUnsupported) deadLines.value.add(res.activeLineIndex)

      // 查一次续看记录：按剧名优先，退回播放页地址（换站也能续上）
      resumeDismissed.value = false
      resumeWatch.value = findWatch({ title: res.title, pageUrl: res.pageUrl })

      addToHistory({ url, title: res.title })
      parseHistory.value = getHistory()
      syncUrlToQuery()   // 地址栏跟着当前地址+线路走，随时可复制分享
      saveResultCache()  // 从播放器返回时直接摆回来，省掉一次几秒的重解析
    } catch (e: any) {
      // 409（令牌失效）已由 resolvePlaylist 内部重算一轮，到这里说明重算也没过
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
  /**
   * 上一次解析结果的缓存。
   *
   * 从播放器按浏览器返回键回到本页时，页面是整个重新挂载的，`?url=&line=N` 虽然还在，
   * 但要重新跑一遍解析——慢的站点好几秒，nbmovie 系还会被限流。而用户回来通常只是想换条线路，
   * 那份线路表上一秒还在手里。于是原样存下来，回来直接摆回去。
   *
   * TTL 1 小时。比探测结果那些（30 分钟）长一倍：这里存的只是线路×集数表，
   * 就算里面的作业单令牌过期了，播放器也会拿 playlistSource 重解析一次拿新的，
   * 代价只是一次请求；而缓存失效的代价是每次返回都白等一轮解析。过期或对不上就照常重新解析。
   */
  const RESULT_CACHE_KEY = 'video-parse-last-result'
  const RESULT_CACHE_TTL = 60 * 60 * 1000

  interface CachedParse { url: string; line: number; result: ParseResult; at: number }

  const saveResultCache = () => {
    if (!result.value) return
    try {
      localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify({
        url: inputUrl.value.trim(),
        line: result.value.activeLineIndex,
        result: result.value,
        at: Date.now(),
      } satisfies CachedParse))
    } catch { /* 超配额就算了，缓存本来就是可选的 */ }
  }

  const readResultCache = (): CachedParse | null => {
    try {
      const raw = localStorage.getItem(RESULT_CACHE_KEY)
      if (!raw) return null
      const p = JSON.parse(raw) as CachedParse
      if (!p?.result?.lines?.length || !p.url || !p.at) return null
      if (Date.now() - p.at > RESULT_CACHE_TTL) return null
      return p
    } catch { return null }
  }

  /** 把缓存里的结果摆回界面（等价于解析成功后的那几步，但不发请求） */
  const restoreFromCache = (c: CachedParse) => {
    inputUrl.value = c.url
    result.value = c.result
    lastParsedUrl.value = c.result.pageUrl
    embedSrc.value = c.result.embedUrl || ''
    embedIndex.value = c.result.embedUrl
      ? (c.result.lines[c.result.activeLineIndex]?.episodes.findIndex(e => e.embedUrl === c.result.embedUrl) ?? -1)
      : -1
  }

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

  onMounted(() => {
    userRules.value = loadUserParseRules()
    // 只查不求：`persisted()` 是纯查询，不会弹权限窗（真正的请求在写入历史时才发，见 useHistory）
    void refreshPersistedState()
    // 支持 /video-parse?url=…&line=N 直接带地址进来自动解析
    const q = parseQueryParams()
    const cached = readResultCache()
    // 命中缓存就不发请求：从播放器点返回回来时走的正是这条路（同一地址、同一线路），
    // 用户多半只是想换条线路，没必要再等一遍解析
    const hit = cached && (!q.url || (cached.url === q.url && (q.line === undefined || q.line === cached.line)))

    if (hit) {
      restoreFromCache(cached!)
      if (!q.url) syncUrlToQuery()   // 直接进来的（地址栏没参数）补上，刷新还能落回同一份
    } else if (q.url) {
      inputUrl.value = q.url
      startResolve(q.line)
    }
  })

  return {
    inputUrl, busy, stage, error, result,
    powTried, powPercent, lastParsedUrl,
    userRules, supportedSites, matchedRule, historySite,
    findWatch, forgetWatch, resumeWatch, resumeDismissed,
    isFav, toggleFav, faved,
    currentLine, resolvedEpisodes, resolvedCount, isLazy, playableCount, checkTarget, hasSignedUrl,
    embedSrc, embedIndex, deadLines,
    addToHistory, getHistory, clearHistory, storagePersisted, refreshPersistedState, parseHistory,
    startResolve, saveResultCache, readResultCache, restoreFromCache,
    parseQueryParams, syncUrlToQuery,
  }
}
