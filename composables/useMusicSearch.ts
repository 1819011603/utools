/**
 * 按歌名/歌手搜索：两个音源**并发**搜、各自落地各自渲染。
 *
 * 不设栅栏（不用 Promise.all 收口）的理由同 useVideoSearch：一个慢的会把快的一起拖住，
 * 而它们本来就是两个互不相干的库。
 *
 * **两个音源的结果不做去重合并**：One/Two 是两个不同的库，同一首歌在两边常常是不同的
 * 版本/母带（现场版、不同专辑收录），合并只会把用户想要的那一版抹掉。
 */
import type { MusicSearchRow, MusicSourceId } from './music24bit'
import { MUSIC_SOURCES, PAGE_SIZE, search24bit } from './music24bit'

export type MusicSearchStatus = 'idle' | 'searching' | 'done' | 'error'

export interface MusicSourceState {
  id: MusicSourceId
  name: string
  status: MusicSearchStatus
  rows: MusicSearchRow[]
  /** 已经取到第几页。「加载更多」在它基础上 +1 */
  page: number
  /** 还有下一页。站点不报总数，只能按「这一页给满了 30 条」推断 */
  hasMore: boolean
  error?: string
}

/**
 * 结果缓存：切回来不重搜。键含音源和页码 —— 「加载更多」之后再搜同一个词，
 * 前几页不该再发一遍请求（每一发都在消耗站点的耐心，见取址闸门的说明）。
 */
const memCache = new Map<string, MusicSearchRow[]>()
const cacheKeyOf = (src: MusicSourceId, kw: string, page: number) => `${src}|${kw}|${page}`

function initialStates(): MusicSourceState[] {
  return MUSIC_SOURCES.map(s => ({
    id: s.id, name: s.name, status: 'idle' as const, rows: [], page: 0, hasMore: false,
  }))
}

export function useMusicSearch() {
  const keyword = ref('')
  const states = ref<MusicSourceState[]>(initialStates())
  const searching = computed(() => states.value.some(s => s.status === 'searching'))
  const totalFound = computed(() => states.value.reduce((n, s) => n + s.rows.length, 0))
  /** 搜过了但两边都是空 —— 这个状态要单独认出来，好说「换个关键词」而不是干瞪一片空白 */
  const emptyResult = computed(() =>
    !!keyword.value && !searching.value
    && states.value.every(s => s.status === 'done' && !s.rows.length),
  )

  const stateOf = (id: MusicSourceId) => states.value.find(s => s.id === id)!

  /** 每个音源各自的中止控制器：连着改词时，旧的那轮回来不能把新的盖掉 */
  const aborters = new Map<MusicSourceId, AbortController>()

  /**
   * 取一页。`append=true` 是「加载更多」，false 是新搜索。
   * 音乐列表的惯例与视频不同：翻页**追加**而不是整页替换，用户往下滚就是了。
   */
  const fetchPage = async (id: MusicSourceId, kw: string, page: number, append: boolean) => {
    const st = stateOf(id)

    aborters.get(id)?.abort()
    const ctrl = new AbortController()
    aborters.set(id, ctrl)

    st.status = 'searching'
    st.error = undefined
    if (!append) { st.rows = []; st.page = 0; st.hasMore = false }

    const ck = cacheKeyOf(id, kw, page)
    const cached = memCache.get(ck)
    if (cached) {
      st.rows = append ? [...st.rows, ...cached] : cached
      st.page = page
      st.hasMore = cached.length >= PAGE_SIZE
      st.status = 'done'
      return
    }

    try {
      const rows = await search24bit(id, kw, page, ctrl.signal)
      // 这一轮已经被新的搜索取代了 → 结果作废，别覆盖新状态
      if (ctrl.signal.aborted) return
      memCache.set(ck, rows)
      st.rows = append ? [...st.rows, ...rows] : rows
      st.page = page
      // 站点不报总数，只能按「给满了一页」推断还有下一页。
      // 最后一页恰好是 30 条时会多请求一次并得到空数组，代价可接受
      st.hasMore = rows.length >= PAGE_SIZE
      st.status = 'done'
    } catch (e: any) {
      if (ctrl.signal.aborted || e?.name === 'AbortError') return
      st.status = 'error'
      st.error = e?.message || '搜索失败'
    }
  }

  /** 搜。两个音源同时发，谁先回来谁先渲染 */
  const search = (kw: string) => {
    const q = kw.trim()
    if (!q) return
    keyword.value = q
    for (const s of MUSIC_SOURCES) void fetchPage(s.id, q, 1, false)
  }

  /** 「加载更多」—— 只动这一个音源，两边的页码互不相干 */
  const loadMore = (id: MusicSourceId) => {
    const st = stateOf(id)
    if (!keyword.value || st.status === 'searching' || !st.hasMore) return
    void fetchPage(id, keyword.value, st.page + 1, true)
  }

  const retry = (id: MusicSourceId) => {
    const st = stateOf(id)
    if (!keyword.value) return
    // 绕开缓存，否则「重试」等于什么都没做
    memCache.delete(cacheKeyOf(id, keyword.value, Math.max(1, st.page)))
    void fetchPage(id, keyword.value, Math.max(1, st.page), false)
  }

  const reset = () => {
    for (const c of aborters.values()) c.abort()
    aborters.clear()
    keyword.value = ''
    states.value = initialStates()
  }

  onScopeDispose(() => {
    for (const c of aborters.values()) c.abort()
  })

  return { keyword, states, searching, totalFound, emptyResult, search, loadMore, retry, reset }
}
