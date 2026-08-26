/**
 * 给没有封面的老记录**慢慢**把图补回来。
 *
 * 由来：封面是后加的字段，此前存下的记录全都没有图；抓不到 `og:image` 的站点也一样。
 * 但每条记录都留着源站播放页地址，事后回去取一次就有了。
 *
 * 三条纪律，缺一条就会变成「打开媒体库把源站打一遍」：
 *   · **串行 + 间隔**（一次一条，`GAP_MS`）。并发去抓等于给源站来一轮小型压测，
 *     慢的站还会连带把正在播的那一集的带宽抢掉；
 *   · **只在媒体库打开着的时候跑**（组件调 `start()`、关掉调 `stop()`）。
 *     用户在看片时后台偷偷抓一堆页面，收益为零、风险全在我们这边；
 *   · **抓不到就记下来，一天内不再试**（`video-cover-miss`）。有的站点压根没有 og:image、
 *     有的片子已经下架，不记的话每次打开都要把这些必然失败的再跑一遍。
 *
 * 补到就当场写回 localStorage 并刷新共享快照 —— 界面上那张占位块会自己变成封面。
 */
import { showKeyOf } from './useWatchHistory'

/** 两次抓取之间歇多久。慢到用户察觉不到，也慢到源站不会当成异常流量 */
const GAP_MS = 1200
/** 一次「打开媒体库」最多补多少条：几十条也就一分钟的事，再多说明该让用户自己去看片了 */
const MAX_PER_RUN = 40
const MISS_KEY = 'video-cover-miss'
const MISS_TTL = 24 * 3600 * 1000

type MissMap = Record<string, number>

const loadMiss = (): MissMap => {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(MISS_KEY) || '{}') as MissMap } catch { return {} }
}

const saveMiss = (m: MissMap) => {
  try { localStorage.setItem(MISS_KEY, JSON.stringify(m)) } catch { /* 满了就算了，大不了多试一次 */ }
}

let running = false
let stopped = false

export function useCoverBackfill() {
  const { history, favorites, reload } = useLibrary()
  const { patchWatchMeta } = useWatchHistory()
  const { patchFavMeta } = useFavorites()

  /** 待补清单：两份清单里缺图、有来源页、且最近没试过的。同一部剧只排一次 */
  const pending = () => {
    const miss = loadMiss()
    const now = Date.now()
    const seen = new Set<string>()
    const out: { key: string; pageUrl: string; title?: string }[] = []
    for (const r of [...history.value, ...favorites.value]) {
      if (r.cover || !r.pageUrl) continue
      const key = showKeyOf(r)
      if (!key || seen.has(key)) continue
      if (miss[key] && now - miss[key] < MISS_TTL) continue
      seen.add(key)
      out.push({ key, pageUrl: r.pageUrl, title: r.title })
    }
    return out.slice(0, MAX_PER_RUN)
  }

  const start = async () => {
    if (running || typeof window === 'undefined') return
    running = true
    stopped = false
    try {
      for (const item of pending()) {
        if (stopped) break
        let cover: string | undefined
        let cat: string | undefined
        try {
          const res = await $fetch<{ cover?: string; cat?: string }>('/api/cover', {
            query: { url: item.pageUrl },
          })
          cover = res?.cover
          cat = res?.cat
        } catch {
          // 抓不到就是抓不到（源站挂了、被墙、反爬）。跟「页面里没有 og:image」同样处理：
          // 记一笔别再试，界面上保持占位块
        }
        // 两份清单都补：同一部剧可能既在历史里也在收藏里，两条记录各存各的
        const q = { title: item.title, pageUrl: item.pageUrl }
        const a = cover || cat ? patchWatchMeta(q, { cover, cat }) : false
        const b = cover || cat ? patchFavMeta(q, { cover, cat }) : false
        if (a || b) reload()
        if (!cover) {
          const miss = loadMiss()
          miss[item.key] = Date.now()
          saveMiss(miss)
        }
        if (stopped) break
        await new Promise(r => setTimeout(r, GAP_MS))
      }
    } finally {
      running = false
    }
  }

  /** 媒体库关掉就停手：用户已经回去看片了 */
  const stop = () => { stopped = true }

  return { start, stop }
}
