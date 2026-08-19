/**
 * 按片名搜片：各站**并发**搜、各自落地各自渲染。
 *
 * 为什么不用 Promise.all 收口：各站快慢差好几秒（实测 ylsp ~0.6s、ncat 要先算一轮工作量证明），
 * 设个栅栏等于按最慢的那个算，快的三站明明已经回来了还得干等。这里每站各自更新自己那份状态，
 * 界面上先回来的先显示。
 *
 * 反爬（ncat 的 cdndefend）复用解析那一套：服务端只给挑战常量，nonce 在浏览器算。
 * 算出来的令牌**按 host 存在模块级 Map 里**，跨站点、跨搜索、跨到解析页都能复用——
 * 一次会话只算一遍（一遍约 6.5 万次 SHA1）。
 */
import type { SearchItem, SiteSearchResult } from './videoSearchRules'
import { SEARCH_RULES, buildSiteSearchUrl } from './videoSearchRules'

export type SiteSearchStatus =
  | 'idle'       // 还没搜
  | 'searching'
  | 'done'       // 有结果或确认没结果（items 长度区分）
  | 'error'      // 抓不到/规则失效，可重试
  | 'blocked'    // 服务端被人机校验挡住，只能去源站搜
  | 'manual'     // 规则表就写明了「这个站只能在源站搜」，压根不发请求

export interface SiteSearchState {
  siteId: string
  name: string
  homepage: string
  status: SiteSearchStatus
  items: SearchItem[]
  /** 站点自报的总数，用来提示「只列出了第一页」 */
  total?: number
  /** 当前看的是第几页（从 1 起）。翻页是**按站**的：各站的页码互不相干 */
  page: number
  /** 还有下一页（服务端按分页条实测，见 SearchRule.nextPageRe） */
  hasMore?: boolean
  error?: string
  /** 「在源站搜」按钮的落点（blocked/manual/空结果时都要有） */
  siteSearchUrl?: string
  /** manual/blocked 时说清为什么，别让用户以为是我们坏了 */
  reason?: string
  /** 工作量证明进度，只在 searching 时有意义 */
  powTried?: number
}

/** 反爬令牌，按 host 存。解析链路有它自己那份（usePowCookie），这里不去打通——两边都只是缓存，各自算一次的代价可接受 */
const powTokens = new Map<string, string>()

/**
 * 结果缓存：同一关键词切回来不重搜。键含站点，因为「重试本站」只该刷新那一站；
 * 也含页码——翻回上一页是常态（「刚那张海报在第几页来着」），不该再发一次请求。
 */
const memCache = new Map<string, SiteSearchResult>()
const cacheKeyOf = (siteId: string, kw: string, page: number) => `${siteId}|${kw}|${page}`

const CACHE_KEY = 'video-search-last-result'
const CACHE_TTL = 60 * 60 * 1000

interface CachedSearch { kw: string; at: number; states: SiteSearchState[] }

const hostOfUrl = (url: string) => { try { return new URL(url).host } catch { return url } }

/** 规则表 → 初始状态（manual 的站点一开始就摆明态度，不参与请求） */
function initialStates(): SiteSearchState[] {
  return SEARCH_RULES.map(r => ({
    siteId: r.siteId,
    name: r.name,
    homepage: r.homepage,
    status: r.manual ? 'manual' : 'idle',
    items: [],
    page: 1,
    reason: r.manual?.reason,
    siteSearchUrl: r.manual?.searchUrl,
  }))
}

export function useVideoSearch() {
  const keyword = ref('')
  const states = ref<SiteSearchState[]>(initialStates())
  const searching = computed(() => states.value.some(s => s.status === 'searching'))
  const totalFound = computed(() => states.value.reduce((n, s) => n + s.items.length, 0))

  const stateOf = (siteId: string) => states.value.find(s => s.siteId === siteId)!

  /**
   * 「去源站搜」的地址跟着关键词走。**每一轮搜索开始时先按新词整体重写一遍**，
   * 不能只在结果回来时更新：搜索中和搜索失败这两种状态下压根没有新结果，
   * 留着上一轮的地址就是「输入框写着这个词、按钮却指向上一个词」（踩过）。
   * 拼不出来的（ncat 要服务端现抠的 t）先退回首页，等结果回来再换成服务端给的。
   */
  const applySiteSearchUrls = (kw: string) => {
    for (const rule of SEARCH_RULES) {
      stateOf(rule.siteId).siteSearchUrl = buildSiteSearchUrl(rule, kw) ?? rule.homepage
    }
  }

  /** 搜一个站。走完两步式 PoW，结果写回它自己那份状态，不碰别人 */
  const searchSite = async (siteId: string, kw: string, useCache = true, page = 1) => {
    const rule = SEARCH_RULES.find(r => r.siteId === siteId)
    if (!rule || rule.manual) return

    const st = stateOf(siteId)
    const cacheKey = cacheKeyOf(siteId, kw, page)
    if (useCache) {
      const hit = memCache.get(cacheKey)
      if (hit) { applyResult(st, hit, kw); return }
    }

    st.status = 'searching'
    st.items = []
    // 页码先写上：骨架屏那一行要说清「正在翻到第几页」，不然翻页期间界面上看不出发生了什么
    st.page = page
    st.hasMore = undefined
    st.siteSearchUrl = buildSiteSearchUrl(rule, kw) ?? rule.homepage
    st.error = undefined
    st.powTried = undefined

    const host = hostOfUrl(rule.homepage)
    const call = (cookie: string) => $fetch<SiteSearchResult & { needPow?: boolean; c?: string; n1?: number; target?: [number, number] }>('/api/search', {
      query: { site: siteId, kw, step: cookie ? 'extract' : 'challenge', ...(page > 1 ? { page } : {}), ...(cookie ? { cookie } : {}) },
    })

    try {
      let res = await call(powTokens.get(host) ?? '')
      if (res?.needPow) {
        const pow = await solvePow(res.c!, res.n1!, res.target!, { onProgress: n => { st.powTried = n } })
        powTokens.set(host, pow.cookie)
        res = await call(pow.cookie)
      }
      memCache.set(cacheKey, res as SiteSearchResult)
      applyResult(st, res as SiteSearchResult, kw)
    } catch (e: any) {
      // 409 = 服务端说令牌没过：丢掉重来一轮（只重来一次，避免死循环）
      if ((e?.statusCode || e?.response?.status) === 409 && powTokens.has(host)) {
        powTokens.delete(host)
        return searchSite(siteId, kw, false, page)
      }
      st.status = 'error'
      st.error = e?.statusMessage || e?.data?.statusMessage || e?.message || '搜索失败'
      st.powTried = undefined
    }
  }

  const applyResult = (st: SiteSearchState, res: SiteSearchResult, kw: string) => {
    const rule = SEARCH_RULES.find(r => r.siteId === st.siteId)
    st.items = res.items ?? []
    st.total = res.total
    st.page = res.page ?? 1
    st.hasMore = res.hasMore
    // 前端拼得出「带关键词的页面地址」就用前端的：服务端返回的那个是它自己抓的地址，
    // 对 kpkuang 这类站点是接口 URL（点过去一坨 JSON），只有 ncat 那种要令牌的才非它不可
    st.siteSearchUrl = (rule && buildSiteSearchUrl(rule, kw)) ?? res.siteSearchUrl ?? st.siteSearchUrl
    st.status = res.blocked ? 'blocked' : 'done'
    st.powTried = undefined
    if (res.blocked === 'cloudflare') {
      st.reason = '该站的搜索页有 Cloudflare 人机校验，服务端过不去（它的详情页、播放页是正常的）。'
    }
  }

  /** 搜全部站点。同时发，谁先回来谁先渲染 */
  const search = (kw: string) => {
    const q = kw.trim()
    if (!q) return
    keyword.value = q
    applySiteSearchUrls(q)
    for (const rule of SEARCH_RULES) {
      if (rule.manual) continue
      void searchSite(rule.siteId, q)
    }
  }

  /** 只重搜一个站（tab 里那颗「重试」）。绕开缓存，否则重试等于什么都没做 */
  const retrySite = (siteId: string) => {
    if (!keyword.value) return
    const page = stateOf(siteId).page || 1
    memCache.delete(cacheKeyOf(siteId, keyword.value, page))
    void searchSite(siteId, keyword.value, false, page)
  }

  /**
   * 翻到某一页（只动这一个站）。**页码不进地址栏**：地址栏那份是「搜了什么」，
   * 而各站各有各的页码，写进去要么只写一个站（另外几个站的页码就成了谎话），
   * 要么拼成一串没人看得懂的东西。翻页是当下的浏览动作，刷新回到第 1 页正合适。
   */
  const goPage = (siteId: string, page: number) => {
    if (!keyword.value || page < 1) return
    void searchSite(siteId, keyword.value, true, page)
  }

  // ── 上次结果的缓存 ──
  // 点一条结果是**新标签**打开解析页，但用户也可能在本标签里点返回/刷新。
  // 存一份下来，回到本页直接摆回去，一个请求都不发（同 video-parse-last-result 的动机）。
  const saveCache = () => {
    if (!keyword.value) return
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        kw: keyword.value, at: Date.now(), states: states.value,
      } satisfies CachedSearch))
    } catch { /* 超配额就算了，缓存本来就是可选的 */ }
  }

  /** 命中缓存返回 true。只认同一个关键词——换了词当然要重搜 */
  const restoreCache = (kw?: string): boolean => {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return false
      const c = JSON.parse(raw) as CachedSearch
      if (!c?.kw || !c.at || Date.now() - c.at > CACHE_TTL) return false
      if (kw && kw !== c.kw) return false
      keyword.value = c.kw
      // 状态表按当前规则表重建：规则可能增删过，直接把旧数组摆上来会漏站/多站
      states.value = initialStates().map(s => {
        const old = c.states.find(x => x.siteId === s.siteId)
        // 上次没搜完的（searching/idle）不复原，让它显示成没搜过
        // page 兜一道 1：这份缓存可能是加翻页之前写下的，那时没有这个字段
        return old && (old.status === 'done' || old.status === 'blocked' || old.status === 'error')
          ? { ...s, ...old, page: old.page || 1, powTried: undefined }
          : s
      })
      applySiteSearchUrls(c.kw)
      // 内存缓存也灌一份，这样「切 tab / 重新点搜索」同样不发请求
      for (const s of states.value) {
        if (s.status === 'done') {
          memCache.set(cacheKeyOf(s.siteId, c.kw, s.page || 1), {
            siteId: s.siteId, items: s.items, total: s.total, page: s.page, hasMore: s.hasMore, siteSearchUrl: s.siteSearchUrl,
          })
        }
      }
      return true
    } catch { return false }
  }

  /**
   * 回到「还没搜过」。给「点导航重新进本页」用——那种情况下组件不会重新挂载
   * （同一条路由），不显式清就会带着上一次的关键词和整屏结果。
   * 只清本次会话的展示状态，不动 memCache/localStorage：那两份是「搜过什么」的记录，
   * 用户下次搜同一个词还要靠它们免掉一轮请求。
   */
  const reset = () => {
    keyword.value = ''
    states.value = initialStates()
  }

  return { keyword, states, searching, totalFound, search, retrySite, goPage, saveCache, restoreCache, reset }
}
