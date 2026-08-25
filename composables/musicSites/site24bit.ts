/**
 * 24bit.net 适配层：**唯一**认识这个站点的地方。
 *
 * ## 分层是不对称的，这是实测出来的，不是疏忽
 *
 *   搜索      浏览器 ──GET───> 我们的 /api/music/search     （站点侧拦跨站请求 → 必须中转）
 *   取址      浏览器 ──GET───> 我们的 /api/music/resolve    （详情页 HTML 无 ACAO → 必须中转）
 *   播放/下载 浏览器 ──GET───> 酷我 / 网易云 CDN            （`<audio>` 直连；下载走 /api/proxy）
 *
 * 搜索原本打算前端直连（站点的搜索接口确实给了 `ACAO: *`，预检也过），实测却发不出去：
 * 从我们页面跨域 POST 全是 `net::ERR_FAILED`，连 `mode:'no-cors'` 的 GET 都报
 * `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`，而本项目并没有设 COEP/COOP。
 * 拦截来自站点侧，不是我们能改的。详见 `server/api/music/search.ts` 的文件注释。
 */
import type { MusicResolved, MusicSearchRow, MusicSite } from './types'

/**
 * 详情页的两个前缀 —— **它们是两个音源，不是搜索接口的映射**。
 *
 * 一开始误以为 One→`c`、Two→`b`，实测推翻：同一个 id 在两个前缀下都可能有效，
 * 拿到的是不同音源的不同文件：
 *   · `/music/b/` → 酷我 `kw-*.kuwo.cn`，标「无损音质」，20–52MB
 *   · `/music/c/` → 网易云 `*.music.126.net`，标「高清环绕声」，45–115MB
 *
 * 默认先取 `b`：体积小五倍，起播快、下载快、手机流量友好，而 flac 无损对绝大多数场景够用。
 * 取不到再退 `c`。**一首歌最多两发** —— 多试一个前缀就多一发请求，而这个站会限流。
 *
 * ## 为什么不预先探测「这首歌有哪些档可用」
 *
 * 那需要对每首歌把两个前缀都请求一遍 —— 一页 30 首就是 60 发，**必被限流**
 * （限流还是静默的：站点照常回 200，只是页面里不再有曲目数据）。
 * 所以两个档一律都列出来，点了才去取址；那个档没有资源时提示换另一个。
 * 多点一次的代价，远小于每次搜索都把站点惹毛。
 */
export const SITE_24BIT: MusicSite = {
  id: '24bit',
  name: '24bit',
  tagline: '无损 flac · 体积大、音质最好',

  /**
   * 两个搜索来源。它们是**两个不同的库**，同名不同版本很常见（现场版、不同专辑收录），
   * 所以结果不做去重合并 —— 合并会把用户想要的那一版抹掉。
   *
   * 这里只留 id 和展示名：真正的接口名在 `server/api/music/search.ts` 的白名单里，
   * 前端不必知道（两处各写一份必然漂移）。
   */
  sources: [
    { id: 'one', name: '音源一' },
    { id: 'two', name: '音源二' },
  ],

  /**
   * 音质档就是上面那两个详情页前缀。界面上让用户直接点档位来播，而不是我们替他猜一个。
   *
   * `label` 用的是**站点自己在详情页 `quality` 字段里的说法**（实测值），不是我们编的规格参数。
   * 取址成功后会用详情页返回的真实 `quality` 覆盖显示。
   */
  tiers: [
    { tier: 'b', label: '无损音质', hint: '体积小，约 20–50MB', color: 'primary' },
    { tier: 'c', label: '高清环绕声', hint: '体积大，约 45–115MB', color: 'blue' },
  ],

  /** 站点每页固定 30 条。它不报总数，只能按「这一页给满了」推断还有下一页 */
  pageSize: 30,

  async search(source, kw, page, signal): Promise<MusicSearchRow[]> {
    const res = await $fetch<{ items: Omit<MusicSearchRow, 'site'>[] }>('/api/music/search', {
      query: { source, kw, page },
      // 用户填了自己的登录态就带上（配额另算）。没填就是空对象，照常匿名请求
      headers: useMusic24bitAuth().authHeaders(),
      signal,
    })
    return (res?.items ?? []).map(r => ({ ...r, site: '24bit' as const }))
  },

  resolve(id, tier, signal): Promise<MusicResolved> {
    // 详情页 HTML 没有 ACAO，浏览器跨域取不到 → 这一段必须经服务端
    return $fetch<MusicResolved>('/api/music/resolve', {
      query: { id, src: tier },
      // 凭证走请求头不走 query —— query 会进日志、浏览器历史和 Referer
      headers: useMusic24bitAuth().authHeaders(),
      signal,
    })
  },

  /**
   * 这个站**按天按 IP 限量**，用完之后照常回 200、只是不再给地址（服务端认出正文里那句
   * 「今日访问已达限额」后回 429）。有 `quotaHint` 就意味着闸门要为它准备「彻底停手」这条路。
   */
  quotaHint: '音乐站今日访问配额已用完（该站对匿名访问按天限量），明天再来，或到 24bit.net 登录后使用。',
  loginUrl: 'https://www.24bit.net/login',
}
