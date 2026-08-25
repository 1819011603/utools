/**
 * 24bit.net 适配层：**唯一**认识这个站点的地方。
 *
 * 播放器（composables/musicPlayer/）只认 `Track`，它不知道 `/music/b/`、
 * `searchOnlineMusicOne` 这些东西的存在 —— 换个数据源只加一个这样的文件即可。
 *
 * ## 分层是不对称的，这是实测出来的，不是疏忽
 *
 *   搜索      浏览器 ──POST──> 24bit /api/player/search…   （`ACAO: *`，预检 204 → 直连）
 *   取址      浏览器 ──GET───> 我们的 /api/music/resolve    （详情页 HTML 无 ACAO → 必须中转）
 *   播放/下载 浏览器 ──GET───> 酷我 / 网易云 CDN            （`ACAO: *` + 允许 Range → 直连）
 *
 * 搜索之所以不一起走服务端：它跨域本来就通，多绕一跳只是白吃 CF Pages 的请求配额。
 */
import type { Track } from './musicPlayer/types'

/**
 * 两个搜索来源。它们是**两个不同的库**，同名不同版本很常见（现场版、不同专辑收录），
 * 所以结果分开展示、不做去重合并 —— 合并会把用户想要的那一版抹掉。
 *
 * 这里只留 id 和展示名：真正的接口名在 `server/api/music/search.ts` 的白名单里，
 * 前端不必知道（两处各写一份必然漂移）。
 */
export const MUSIC_SOURCES = [
  { id: 'one', name: '音源一' },
  { id: 'two', name: '音源二' },
] as const

export type MusicSourceId = (typeof MUSIC_SOURCES)[number]['id']

/**
 * 详情页的两个前缀 —— **它们是两个音源，不是搜索接口的映射**。
 *
 * 一开始误以为 One→`c`、Two→`b`，实测推翻：同一个 id 在两个前缀下都可能有效，
 * 拿到的是不同音源的不同文件：
 *   · `/music/b/` → 酷我 `kw-*.kuwo.cn`，标「无损音质」，20–52MB
 *   · `/music/c/` → 网易云 `*.music.126.net`，标「高清环绕声」，45–115MB
 *
 * 默认先取 `b`：体积小五倍，起播快、下载快、手机流量友好，而 flac 无损对绝大多数场景够用。
 * 取不到再退 `c`。**一首歌最多两发**——多试一个前缀就多一发请求，而这个站会限流。
 */
export const DETAIL_PREFIXES = ['b', 'c'] as const
export type DetailPrefix = (typeof DETAIL_PREFIXES)[number]

/**
 * 搜索结果的一条。字段名沿用站点自己的说法，减少一层翻译。
 *
 * **没有 cover**：站点搜索结果里那个 cover 是占位图（同一次搜索里所有条目完全相同），
 * 服务端已经把它滤掉了。真封面只有取址成功后从详情页拿得到。
 */
export interface MusicSearchRow {
  id: string
  name: string
  player: string
  album: string
}

/** 取址定位信息。播放器把它当不透明数据原样传回给 resolver */
export interface Music24bitLocator {
  id: string
  /** 上次成功的前缀。命中过就下次直接从它开始，省掉一发失败请求 */
  preferred?: DetailPrefix
}

/**
 * 搜一页。经我们自己的 `/api/music/search` 中转，**不直连站点**。
 *
 * 原本打算前端直连（站点的搜索接口确实给了 `ACAO: *`，预检也过），实测却发不出去：
 * 从我们页面跨域 POST 全是 `net::ERR_FAILED`，连 `mode:'no-cors'` 的 GET 都报
 * `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`，而本项目并没有设 COEP/COOP。
 * 拦截来自站点侧，不是我们能改的。详见 `server/api/music/search.ts` 的文件注释。
 *
 * 双重编码那件事现在由服务端做（它才是真正发请求的一方），这里只传原文关键词。
 */
export async function search24bit(
  source: MusicSourceId,
  keyword: string,
  page = 1,
  signal?: AbortSignal,
): Promise<MusicSearchRow[]> {
  const res = await $fetch<{ items: MusicSearchRow[] }>('/api/music/search', {
    query: { source, kw: keyword, page },
    signal,
  })
  return res?.items ?? []
}

/**
 * 搜索结果 → 播放器认的 Track。
 *
 * **key 用 `24bit:<id>`，不用地址**：地址带时效签名、约 20 分钟一换，
 * 拿它当键会让队列去重、收藏比对、下载排队三处同时失灵。
 *
 * 封面**不取搜索结果里的那个**：实测它是 segmentfault 图床的占位图，
 * 同一次搜索里所有条目完全相同，摆出来只会让整页看起来像同一首歌。
 * 真封面只有详情页的 `itemMusic.cover` 有，取址成功后会回填。
 */
export function rowToTrack(row: MusicSearchRow, tier?: DetailPrefix): Track {
  return {
    key: `24bit:${row.id}`,
    name: row.name,
    artist: row.player,
    album: row.album,
    resolver: '24bit',
    // 用户点了哪个音质档就从哪个开始试；没指定时闸门按默认顺序（b → c）
    locator: { id: row.id, preferred: tier } satisfies Music24bitLocator,
  }
}

/** 页面上「加载更多」= page 递增（站点每页固定 30 条） */
export const PAGE_SIZE = 30

/**
 * 音质档位。**这两个档就是详情页的两个前缀**（见 DETAIL_PREFIXES），
 * 界面上让用户直接点档位来播，而不是我们替他猜一个。
 *
 * ## 为什么不预先探测「这首歌有哪些档可用」
 *
 * 那需要对每首歌把两个前缀都请求一遍 —— 一页 30 首就是 60 发，**必被限流**
 * （限流还是静默的：站点照常回 200，只是页面里不再有曲目数据）。
 * 所以两个档一律都列出来，点了才去取址；那个档没有资源时提示换另一个。
 * 多点一次的代价，远小于每次搜索都把站点惹毛。
 *
 * `label` 用的是**站点自己在详情页 `quality` 字段里的说法**（实测值），
 * 不是我们编的规格参数 —— 编一个「24bit 96kHz」出来而实际文件不是那个规格，
 * 比不写更糟。取址成功后会用详情页返回的真实 `quality` 覆盖显示。
 */
export const QUALITY_TIERS = [
  { tier: 'b' as DetailPrefix, label: '无损音质', hint: '体积小，约 20–50MB', color: 'primary' as const },
  { tier: 'c' as DetailPrefix, label: '高清环绕声', hint: '体积大，约 45–115MB', color: 'blue' as const },
]
