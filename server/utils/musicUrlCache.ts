/**
 * 播放地址的服务端缓存。**存在的唯一理由是省配额。**
 *
 * 站点对匿名访问有**每日配额**（用完后照常回 200，只是页面里换成
 * 「今日访问已达限额」，见 musicFetch.ts 的 isQuotaExhausted）。
 * 而配额按 IP 算，我们所有用户共用服务端这一个出口 IP —— 也就是说
 * **一个人取过的歌，对所有人都不必再取**。这一层比前端缓存值钱得多。
 *
 * ## 有效期不是拍脑袋定的，是从地址里读出来的
 *
 * 网易云那条链的路径第一段就是过期时刻：
 *   `https://m801.music.126.net/20260826003904/<hash>/jdymusic/obj/….flac?vuutv=…`
 *                               └ 2026-08-26 00:39:04
 * 实测它比签发时刻晚约 20 分钟。能读出来就用真值（再留 60s 安全余量），
 * 读不出来（酷我那条链格式不同）才退回保守的 15 分钟。
 *
 * ## 这是「尽力而为」的缓存，不能当作保证
 *
 * Nitro preset 是 cloudflare-pages，模块级 Map 只在**当前 Worker 实例**存活期间有效，
 * 实例回收后就没了。它能省下多少配额取决于实例复用率，因此：
 *   · 命中是白赚，不命中是常态 —— 调用方不能依赖它
 *   · 绝不能因为「缓存里没有」就判定出了错
 */

interface CachedUrl {
  url: string
  format?: string
  sizeText?: string
  quality?: string
  cover?: string
  name?: string
  artist?: string
  album?: string
  /**
   * 歌词原文。24bit 那边一直在运行时往这儿塞（只是类型里漏了，靠「变量不做多余属性检查」
   * 蒙过去的），fangpi 更是把内嵌歌词当主要收获，所以补进类型 ——
   * 漏了它，缓存命中的那些曲目会莫名其妙地没有词。
   */
  lrc?: string
  /** 时长（秒）。只有 fangpi 给（它详情页里有 `03:35` 这种可读时长） */
  duration?: number
}

interface Entry {
  data: CachedUrl
  expiresAt: number
}

/** 条数上限。一首歌一条，几百条就够覆盖一次会话，再多只是白占 Worker 内存 */
const MAX_ENTRIES = 500
/** 读不出签名时的保守有效期。比实测的 20 分钟短，宁可多取一次也别发出死链 */
const FALLBACK_TTL = 15 * 60 * 1000
/** 安全余量：地址在到期前一分钟就不再发出去，免得用户点下去正好赶上作废 */
const SAFETY_MS = 60 * 1000

const store = new Map<string, Entry>()

const keyOf = (id: string, prefix: string) => `${prefix}:${id}`

/**
 * 从地址里解析过期时刻。
 *
 * 认的是路径段里独立的 14 位数字（`YYYYMMDDHHMMSS`）。**必须是独立的一段**，
 * 不能在整条 URL 上乱找 14 位数字 —— 签名串里全是数字和字母，随便一截就能凑出 14 位，
 * 那样解出来的是个荒唐的时间，反而比不解析更糟（可能算出几十年后，等于永不过期）。
 */
function parseExpiry(url: string): number | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }

  for (const seg of path.split('/')) {
    if (!/^\d{14}$/.test(seg)) continue
    const y = +seg.slice(0, 4)
    const mo = +seg.slice(4, 6)
    const d = +seg.slice(6, 8)
    const h = +seg.slice(8, 10)
    const mi = +seg.slice(10, 12)
    const s = +seg.slice(12, 14)
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) continue

    /*
     * 时间戳**没有时区标注**。实测它对应的是北京时间（UTC+8）：
     * 抓到 `20260826003904` 时响应头的 date 是 `Tue, 25 Aug 2026 16:09:14 GMT`
     * ——UTC 16:09 = 北京 00:09，而签名写的是 00:39，正好晚 30 分钟以内。
     * 按 UTC 解析会凭空多算 8 小时，缓存就永远不过期了，发出去全是死链。
     */
    const ts = Date.UTC(y, mo - 1, d, h - 8, mi, s)
    if (!Number.isFinite(ts)) continue

    // 解出来的时间必须落在「现在之后、但不离谱地远」的窗口里，否则当作没解出来。
    // 24 小时是个宽松上限：真实值约 20 分钟，留足余量应对站点调整策略
    const delta = ts - Date.now()
    if (delta <= 0 || delta > 24 * 60 * 60 * 1000) continue
    return ts
  }
  return null
}

/** 命中且没过期才返回。过期的顺手删掉，免得越攒越多 */
export function readUrlCache(id: string, prefix: string): CachedUrl | null {
  const k = keyOf(id, prefix)
  const hit = store.get(k)
  if (!hit) return null
  if (Date.now() >= hit.expiresAt) {
    store.delete(k)
    return null
  }
  // 命中即刷新插入顺序，让 LRU 淘汰真正冷的那些
  store.delete(k)
  store.set(k, hit)
  return hit.data
}

export function writeUrlCache(id: string, prefix: string, data: CachedUrl): void {
  const expiry = parseExpiry(data.url)
  const expiresAt = expiry ? expiry - SAFETY_MS : Date.now() + FALLBACK_TTL
  // 已经快过期的地址不值得存：存进去下一个人拿到就是死链，白白让他以为功能坏了
  if (expiresAt <= Date.now()) return

  store.set(keyOf(id, prefix), { data, expiresAt })

  // Map 的迭代顺序就是插入顺序，最旧的在最前
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}
