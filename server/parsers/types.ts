/**
 * 播放页解析的策略接口。
 *
 * 一个站点 = 一个 SiteParser。resolve.ts 只负责「匹配 → 抓页 → 过反爬 → 交给策略」，
 * 站点差异全部收在策略里，接新站不用改接口层。
 *
 * 两种策略来源：
 *   · 能用正则描述的站点 → 在 videoParseRules.ts 加一条规则，createHtmlParser 自动包成策略
 *   · 需要写代码的站点   → 在 server/parsers/sites/ 加一个 .ts，在 index.ts 注册
 */
import type { ChallengeKind, ParseResult, PowChallenge } from '../../composables/videoParseRules'

export interface FetchedPage {
  status: number
  body: string
  /** 有的反爬只在响应头上留痕（Cloudflare 的 `cf-mitigated: challenge`），body 里看不出来 */
  headers?: Headers
}

export interface ParserContext {
  /** 传入的播放页地址（某一集） */
  pageUrl: string
  host: string
  /** 指定解析哪条线路（0 基）；未指定则由策略自己决定 */
  line?: number
  /** 分批解析的起点，不支持分批的策略忽略即可 */
  offset: number
  /**
   * 只取 pageUrl 这一集的地址，别解析选集、别抓任何子页面。
   * 按需取址的站点（ParseRule.lazy）在播放器里切集时走这条路，一次只花一个请求。
   */
  only?: boolean
  /** 已过反爬的 cookie，抓子页面时要带上 */
  cookie?: string
  /** 带 UA / cookie / 放宽 TLS 的抓页函数 */
  fetchPage: (url: string, cookie?: string) => Promise<FetchedPage>
}

/**
 * 反爬握手。挑战本身在浏览器算（CF Workers 的 CPU 预算跑不动暴力搜索），
 * 这里只负责「认出挑战页」和「把常量抠出来」。
 */
export interface ChallengeHandler {
  kind: ChallengeKind
  /** 用页面内容判定而非状态码——站点改状态码时不会整个失效 */
  detect: (body: string) => boolean
  /** 抠不出常量返回 null，上层会明确报错，而不是拿挑战页去跑正则得到空结果 */
  build: (body: string) => Omit<PowChallenge, 'needPow' | 'kind'> | null
  /** 把前端算出的 token 拼成请求 cookie */
  toCookie: (token: string) => string
}

export interface SiteParser {
  id: string
  name: string
  /** 与 videoSiteRules 同语义：`/正则/` 按正则匹配整个 URL，否则按 host 子串 */
  pattern: string
  challenge?: ChallengeHandler
  /**
   * 传入的是「详情页」（只有简介和选集入口、没有播放地址）时，从它的 HTML 里抠出
   * 第 1 集播放页的绝对地址；不是详情页就返回 null。
   *
   * 搜索结果给的多半是详情页，用户手动粘的也可能是。换这一跳之后下游只见播放页。
   */
  detailPlayUrl?: (ctx: Pick<ParserContext, 'pageUrl' | 'host'>, html: string) => string | null
  parse: (ctx: ParserContext, html: string) => Promise<ParseResult>
}
