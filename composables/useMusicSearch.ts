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

const laneKey = (site: MusicSiteId, source: string) => `${site}/${source}`
const cacheKeyOf = (site: MusicSiteId, source: string, kw: string, page: number) =>
  `${site}|${source}|${kw}|${page}`

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

    lane.status = 'searching'
    lane.error = undefined
    if (!append) { lane.rows = []; lane.page = 0; lane.hasMore = false }

    /** 站点不分页时永远没有下一页（`pageSize: 0`），别画一颗按了没反应的「加载更多」 */
    const moreOf = (got: number) => site.pageSize > 0 && got >= site.pageSize

    const ck = cacheKeyOf(lane.site, lane.source, kw, page)
    const cached = memCache.get(ck)
    if (cached) {
      lane.rows = append ? [...lane.rows, ...cached] : cached
      lane.page = page
      lane.hasMore = moreOf(cached.length)
      lane.status = 'done'
      return
    }

    try {
      const rows = await site.search(lane.source, kw, page, ctrl.signal)
      // 这一轮已经被新的搜索取代了 → 结果作废，别覆盖新状态
      if (ctrl.signal.aborted) return
      memCache.set(ck, rows)
      lane.rows = append ? [...lane.rows, ...rows] : rows
      lane.page = page
      // 站点都不报总数，只能按「给满了一页」推断。最后一页恰好给满时会多请求一次
      // 并得到空数组，代价可接受
      lane.hasMore = moreOf(rows.length)
      lane.status = 'done'
    } catch (e: any) {
      if (ctrl.signal.aborted || e?.name === 'AbortError') return
      lane.status = 'error'
      lane.error = e?.data?.statusMessage || e?.statusMessage || e?.message || '搜索失败'
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

  onScopeDispose(() => {
    for (const c of aborters.values()) c.abort()
  })

  return { keyword, sections, searching, totalFound, emptyResult, search, loadMore, retry, reset }
}
