/**
 * 按歌名/歌手搜索：**所有站点的所有泳道一起并发发**，谁先回来谁先渲染。
 *
 * 不设栅栏（不用 `Promise.all` 收口）的理由同 `useVideoSearch`：一个慢的会把快的一起拖住，
 * 而它们本来就是互不相干的库。
 *
 * ## 两级结构：站点 → 泳道
 *
 * 对外给的是**按站点分的段**（`sections`），因为两个站点的音质差一档、
 * 用户是要拿这个做选择的。段内部还可能有多条泳道（24bit 有两个不同的库），
 * 那一层对用户没有意义 —— **段内交替混排 + 按 id 去重**，混完就不必再提泳道。
 *
 * **跨站点绝不去重**：同一首歌在 24bit 是无损、在 fangpi 是 128K MP3，
 * 那正是用户要在两段之间比较的东西，去重等于把选择权拿走。
 */
import type { MusicSearchRow, MusicSite, MusicSiteId } from './musicSites/types'
import { MUSIC_SITES } from './musicSites'

export type MusicSearchStatus = 'idle' | 'searching' | 'done' | 'error'

/** 一条泳道的状态。界面不直接看它，看的是下面按站点聚合出来的 `sections` */
interface LaneState {
  site: MusicSiteId
  source: string
  status: MusicSearchStatus
  rows: MusicSearchRow[]
  /** 已经取到第几页。「加载更多」在它基础上 +1 */
  page: number
  hasMore: boolean
  error?: string
}

/** 界面渲染的单位：一个站点一段 */
export interface MusicSection {
  site: MusicSite
  /** 段内各泳道交替混排后的结果 */
  rows: MusicSearchRow[]
  searching: boolean
  hasMore: boolean
  /** **全部**泳道都失败才算这一段失败：只挂一条时另一条的结果照常能用 */
  failed: boolean
  error?: string
  /** 搜过了但这一段一条都没有 —— 要单独认出来，好说「这个站没有」而不是干瞪空白 */
  empty: boolean
}

/**
 * 结果缓存：切回来不重搜。键含站点、泳道和页码 —— 「加载更多」之后再搜同一个词，
 * 前几页不该再发一遍请求（每一发都在消耗站点的耐心，见取址闸门的说明）。
 */
const memCache = new Map<string, MusicSearchRow[]>()

/**
 * 单条泳道的搜索超时。
 *
 * 服务端那一跳本来就可能慢（`musicFetch` 先试代理、撞 CF 墙再退直连），所以给得比较宽；
 * 但**必须有个数**：`$fetch` 默认永不超时，一挂就是「加载更多」那颗按钮转圈转到永远。
 */
const SEARCH_TIMEOUT_MS = 20000

const laneKey = (site: MusicSiteId, source: string) => `${site}/${source}`
const cacheKeyOf = (site: MusicSiteId, source: string, kw: string, page: number) =>
  `${site}|${source}|${kw}|${page}`

/**
 * 上次搜索结果的持久化缓存（同 `useVideoSearch` 的 `CACHE_KEY`/`restoreCache`）：
 * 带着 `?kw=` 刷新页面、或点浏览器前进/后退回到这个词时，直接把上次的结果摆回去，
 * 一个请求都不发。**几分钟就够**——不像视频那边给到 1 小时：音乐搜索结果几乎不随时间变
 * （不会像影视那样今天缺资源明天补上），给太长反而是「明明想搜新结果却看到旧的」。
 */
const CACHE_KEY = 'music-search-last-result'
const CACHE_TTL = 5 * 60 * 1000

interface CachedSearch { kw: string; at: number; lanes: LaneState[] }

function initialLanes(): LaneState[] {
  return MUSIC_SITES.flatMap(site =>
    site.sources.map(src => ({
      site: site.id,
      source: src.id,
      status: 'idle' as const,
      rows: [],
      page: 0,
      hasMore: false,
    })),
  )
}

export function useMusicSearch() {
  const keyword = ref('')
  const lanes = ref<LaneState[]>(initialLanes())

  const lanesOf = (site: MusicSiteId) => lanes.value.filter(l => l.site === site)

  /**
   * 按站点聚合成段。
   *
   * **交替混排而不是首尾相接**：24bit 那两个库谁的结果更贴切事先不知道，
   * 顺次拼接会让第二个库的东西全被压到 30 条以后，等于白搜一次。
   */
  const sections = computed<MusicSection[]>(() => MUSIC_SITES.map((site) => {
    const own = lanesOf(site.id)
    const lists = own.map(l => l.rows)

    const rows: MusicSearchRow[] = []
    const seen = new Set<string>()
    const max = Math.max(0, ...lists.map(l => l.length))
    for (let i = 0; i < max; i++) {
      for (const list of lists) {
        const row = list[i]
        // 同一个 id 在同一个站点的两个库里都出现时只留一条（留两条看着像界面出了 bug）
        if (row && !seen.has(row.id)) { seen.add(row.id); rows.push(row) }
      }
    }

    const searching = own.some(l => l.status === 'searching')
    return {
      site,
      rows,
      searching,
      hasMore: own.some(l => l.hasMore),
      failed: own.length > 0 && own.every(l => l.status === 'error'),
      error: own.find(l => l.status === 'error')?.error,
      empty: !searching && own.every(l => l.status === 'done') && rows.length === 0,
    }
  }))

  const searching = computed(() => lanes.value.some(l => l.status === 'searching'))
  const totalFound = computed(() => sections.value.reduce((n, s) => n + s.rows.length, 0))
  /** 所有站点都搜完了且一条都没有 */
  const emptyResult = computed(() =>
    !!keyword.value && !searching.value && sections.value.every(s => s.empty),
  )

  /** 每条泳道各自的中止控制器：连着改词时，旧的那轮回来不能把新的盖掉 */
  const aborters = new Map<string, AbortController>()

  /**
   * 取一页。`append=true` 是「加载更多」，false 是新搜索。
   * 音乐列表的惯例与视频不同：翻页**追加**而不是整页替换，用户往下滚就是了。
   */
  const fetchPage = async (lane: LaneState, kw: string, page: number, append: boolean) => {
    const site = MUSIC_SITES.find(s => s.id === lane.site)
    if (!site) return

    const lk = laneKey(lane.site, lane.source)
    aborters.get(lk)?.abort()
    const ctrl = new AbortController()
    aborters.set(lk, ctrl)

    /**
     * 这一轮还是这条泳道**当前**那一轮吗。
     *
     * 收尾时的判据只能是这个，**不能用 `ctrl.signal.aborted`**：那样问的是「我被中止了吗」，
     * 而中止有两种完全不同的来路 ——
     *   · 被**更新的一轮**取代（那一轮已经把 status 置成 searching，会自己收尾）→ 这轮该闷声退场
     *   · 自己**超时**或整页卸载（**没有后继**）→ 这轮必须把 status 收掉
     * 混成一个判断的后果是后者也闷声退场，`status` 就永久停在 `'searching'`
     * ——界面上「加载更多」那颗按钮 `:loading` 恒真、转圈转到天荒地老，还因为 loading
     * 自带 disabled 而点不动，看着就是「一直在加载更多」。
     */
    const isCurrent = () => aborters.get(lk) === ctrl

    /*
     * 搜索必须有超时。`$fetch` 默认**永不超时**，而服务端那一跳可能很久
     * （`musicFetch` 会先试代理、撞 CF 墙再退直连），24bit 那个域名本身还偶发连不上
     * （CLAUDE.md：同一请求前一次 200、后一次 ConnectTimeout）。
     * 没有闹钟的话这条泳道就一直挂着 —— 而「转圈转不停」比「报个错给个重试」难处理得多。
     */
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, SEARCH_TIMEOUT_MS)

    lane.status = 'searching'
    lane.error = undefined
    if (!append) { lane.rows = []; lane.page = 0; lane.hasMore = false }

    /** 站点不分页时永远没有下一页（`pageSize: 0`），别画一颗按了没反应的「加载更多」 */
    const moreOf = (got: number) => site.pageSize > 0 && got >= site.pageSize

    const ck = cacheKeyOf(lane.site, lane.source, kw, page)
    const cached = memCache.get(ck)
    if (cached) {
      clearTimeout(timer)
      lane.rows = append ? [...lane.rows, ...cached] : cached
      lane.page = page
      lane.hasMore = moreOf(cached.length)
      lane.status = 'done'
      return
    }

    try {
      const rows = await site.search(lane.source, kw, page, ctrl.signal)
      // 已经被更新的一轮取代 → 结果作废，也别碰 status（那一轮会自己收尾）
      if (!isCurrent()) return
      memCache.set(ck, rows)
      lane.rows = append ? [...lane.rows, ...rows] : rows
      lane.page = page
      // 站点都不报总数，只能按「给满了一页」推断。最后一页恰好给满时会多请求一次
      // 并得到空数组，代价可接受
      lane.hasMore = moreOf(rows.length)
      lane.status = 'done'
    } catch (e: any) {
      if (!isCurrent()) return
      /*
       * 走到这儿说明**没有后继那一轮**，所以这一轮必须自己把 status 收掉，
       * 一个 `return` 都不能有 —— 留在 `'searching'` 就是那颗永远转圈的「加载更多」。
       */
      lane.status = 'error'
      lane.error = timedOut
        ? `这个音乐源 ${SEARCH_TIMEOUT_MS / 1000}s 没有响应，点重试再试一次`
        : (e?.data?.statusMessage || e?.statusMessage || e?.message || '搜索失败')
    } finally {
      clearTimeout(timer)
    }
  }

  /** 搜。所有站点的所有泳道同时发 */
  const search = (kw: string) => {
    const q = kw.trim()
    if (!q) return
    keyword.value = q
    for (const lane of lanes.value) void fetchPage(lane, q, 1, false)
  }

  /** 「加载更多」按**站点**走：另一个站点的页码与它无关 */
  const loadMore = (site: MusicSiteId) => {
    if (!keyword.value) return
    for (const lane of lanesOf(site)) {
      if (lane.status === 'searching' || !lane.hasMore) continue
      void fetchPage(lane, keyword.value, lane.page + 1, true)
    }
  }

  const retry = (site: MusicSiteId) => {
    if (!keyword.value) return
    for (const lane of lanesOf(site)) {
      const page = Math.max(1, lane.page)
      // 绕开缓存，否则「重试」等于什么都没做
      memCache.delete(cacheKeyOf(lane.site, lane.source, keyword.value, page))
      void fetchPage(lane, keyword.value, page, false)
    }
  }

  const reset = () => {
    for (const c of aborters.values()) c.abort()
    aborters.clear()
    keyword.value = ''
    lanes.value = initialLanes()
  }

  // ── 上次结果的缓存（几分钟内免请求，见上面 CACHE_TTL 的注释） ──
  const saveCache = () => {
    if (!keyword.value) return
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        kw: keyword.value, at: Date.now(), lanes: lanes.value,
      } satisfies CachedSearch))
    } catch { /* 超配额就算了，缓存本来就是可选的 */ }
  }

  /** 命中缓存返回 true。只认同一个关键词、且要在 TTL 内 —— 换了词或缓存过期当然要重搜 */
  const restoreCache = (kw?: string): boolean => {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return false
      const c = JSON.parse(raw) as CachedSearch
      if (!c?.kw || !c.at || Date.now() - c.at > CACHE_TTL) return false
      if (kw && kw !== c.kw) return false
      keyword.value = c.kw
      // 泳道表按当前注册表重建：站点/泳道可能增删过，直接把旧数组摆上来会漏泳道/多泳道
      lanes.value = initialLanes().map((l) => {
        const old = c.lanes.find(x => x.site === l.site && x.source === l.source)
        // 上次没搜完的（searching/idle/error）不复原，让它显示成没搜过，交给下面的 search 兜底
        return old && old.status === 'done' ? { ...l, ...old } : l
      })
      // 内存缓存也灌一份，这样「加载更多」翻回当前这页同样不发请求
      for (const l of lanes.value) {
        if (l.status === 'done') memCache.set(cacheKeyOf(l.site, l.source, c.kw, l.page || 1), l.rows)
      }
      return true
    } catch { return false }
  }

  /** 命中缓存就直接摆结果，否则照常发请求 */
  const searchOrRestore = (kw: string) => {
    const q = kw.trim()
    if (!q) return
    if (restoreCache(q)) return
    search(q)
  }

  // 结果有变化（含加载更多、重试）就存一份，回来才不用重搜
  watch(lanes, saveCache, { deep: true })

  onScopeDispose(() => {
    for (const c of aborters.values()) c.abort()
  })

  return {
    keyword, sections, searching, totalFound, emptyResult,
    search, loadMore, retry, reset, searchOrRestore,
  }
}
