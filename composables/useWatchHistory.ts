/**
 * 看到第几集（按**剧**记，不是按地址记）。
 *
 * 治的是这么一件事：今天看到第 10 集，明天重新搜一遍、重新解析，页面上一切从第 1 集开始，
 * 而「上次看到哪」这个信息只存在于播放器自己的状态里（`video-player-state`），
 * 解析页压根看不到 —— 用户得自己回忆集数，或者一集一集点过去试。
 *
 * 为什么不复用播放器那份按 URL 存的 `savedProgress`：
 *   · 它的键是**视频地址**（或按需取址的占位地址），换个站、换条线路就全对不上；
 *   · 它记的是「这一集播到第几秒」，回答不了「这部剧我看到第几集」——
 *     后者要的是整部剧一条记录，而不是几十条分散的秒数。
 * 所以这里另存一份**剧级**记录，只有一行有用的信息：最后看的是第几集。
 *
 * 键优先用剧名：同一部剧在不同站点、不同线路的地址完全不同，但名字是一样的，
 * 这样「在 A 站看到 10 集、换 B 站接着看」也能续上。没有剧名（手工贴地址进来的列表）
 * 才退回播放页地址。
 */
export interface WatchRecord {
  /** 剧名（有就有，没有则空串） */
  title: string
  /** 源站播放页地址：用来在解析页按地址兜底匹配，也用来「继续观看」时重新解析 */
  pageUrl?: string
  line?: number
  lineName?: string
  /** 最后看的那一集（下标） */
  index: number
  /** 那一集的名字。集数会因源站加塞而挪位，名字才是身份（同 URL 参数直链里的 ep） */
  epName?: string
  /** 当时这条线路一共多少集，用来显示「10/78」 */
  total?: number
  /**
   * 封面图（解析结果里的 `og:image`）。存**地址**而不是缩略图数据：这份记录要整份上云，
   * 塞 base64 缩略图会让一条记录从几百字节涨到几十 KB，200 部就顶到 D1 的单行上限。
   * 图挂了就退回占位块，不影响这条记录本身的用处。
   */
  cover?: string
  /**
   * 这一集播到第几秒 / 这一集总长。**跨设备续播全靠它**——播放器那份按 URL 存的
   * `savedProgress` 不上云（键是带签名的地址，换台设备对不上），换设备打开只能靠这两个数字
   * 直接跳到「第 10 集 12:34」。也用来在列表里画那行「第1集 · 0:09 · 1%」。
   */
  time?: number
  duration?: number
}

// 云同步的记事本（删一部剧要记墓碑，否则另一台设备会把它推回来）
import { markDirty, recordDelete } from './cloudSyncLocal'

const KEY = 'video-watch-history'
/** 记录上限：按剧计，200 部足够，超了淘汰最久没看的 */
const MAX_SHOWS = 200

type Store = Record<string, WatchRecord>

/** 剧名归一化：去掉空白和常见的季/清晰度后缀差异，避免同一部剧因为标题小改动而分成两条 */
export const normTitle = (t: string) => t.trim().replace(/\s+/g, '').toLowerCase()

/**
 * 「这是哪部剧」的唯一口径：剧名优先，没剧名退回播放页地址，两者都没有就是空串（= 不归属任何剧）。
 *
 * **导出是为了让按剧存的设置（`useShowPrefs`）用同一把钥匙**：两处各写一套归一化的话，
 * 迟早出现「续看记在这部剧上、倍速记在另一部上」——同一个剧名算出两个键，
 * 而且只在标题里多一个空格这种场合才发作，肉眼完全看不出来。
 */
export const showKeyOf = (r: { title?: string; pageUrl?: string }) =>
  r.title?.trim() ? 't:' + normTitle(r.title) : (r.pageUrl ? 'u:' + r.pageUrl : '')

const load = (): Store => {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store } catch { return {} }
}

const save = (s: Store) => {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 配额满了就算了，这是锦上添花的数据 */ }
  markDirty('video-watch')
}

export function useWatchHistory() {
  /**
   * 记一次观看。**同一部剧只有一条记录**，永远覆盖成最新的那一集。
   *
   * 注意不要求 index 单调递增：用户往回看第 3 集，那「上次看到」就该是第 3 集
   * ——记录的语义是「最后看的」，不是「看过的最大集数」（后者在跳着看时会一路虚高）。
   */
  const recordWatch = (r: Omit<WatchRecord, 'at'>) => {
    const k = showKeyOf(r)
    if (!k) return
    const s = load()
    // 封面「只补不删」：换条线路解析时那一页未必有 og:image，整条覆盖会把上次抠到的封面冲掉，
    // 表现是「列表里的图看着看着自己没了」。老记录（这个字段上线前存的）也靠这一句慢慢补齐
    s[k] = { ...r, cover: r.cover || s[k]?.cover, at: Date.now() }
    // 超量就按最久没看的淘汰
    const keys = Object.keys(s)
    if (keys.length > MAX_SHOWS) {
      keys.sort((a, b) => (s[a]!.at) - (s[b]!.at))
      for (const dead of keys.slice(0, keys.length - MAX_SHOWS)) delete s[dead]
    }
    save(s)
  }

  /** 查一部剧的记录：先按剧名，再按播放页地址兜底 */
  const findWatch = (q: { title?: string; pageUrl?: string }): WatchRecord | null => {
    const s = load()
    const byTitle = q.title?.trim() ? s['t:' + normTitle(q.title)] : undefined
    if (byTitle) return byTitle
    return (q.pageUrl ? s['u:' + q.pageUrl] : undefined) ?? null
  }

  const forgetWatch = (q: { title?: string; pageUrl?: string }) => {
    const s = load()
    const k = showKeyOf(q)
    delete s[k]
    if (k) recordDelete('video-watch', k)
    // 两种键都清：同一部剧可能先以地址记过（那次没解析出剧名），后来才有了剧名
    if (q.pageUrl) {
      delete s['u:' + q.pageUrl]
      recordDelete('video-watch', 'u:' + q.pageUrl)
    }
    save(s)
  }

  const allWatched = (): WatchRecord[] => Object.values(load()).sort((a, b) => b.at - a.at)

  return { recordWatch, findWatch, forgetWatch, allWatched }
}
