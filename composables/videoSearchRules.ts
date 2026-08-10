/**
 * 搜索规则：从「片名关键词」拿到各站的搜索结果卡片（片名 + 封面 + 落点地址）。
 *
 * 与 videoParseRules.ts 的分工：
 *   · videoParseRules 管「从一个网页地址拿到视频地址」
 *   · 本文件管「从一个片名找到那个网页地址」
 * 两者靠 `siteId` 对齐（站名、首页在两边保持同一个说法）。
 *
 * **搜索规则独立于解析规则**：4kvm 在解析侧是代码型站点（CODED_PARSE_SITES）、其余在
 * BUILTIN_PARSE_RULES，但搜索这件事对它们完全一样——都是「拼个地址、抓页、跑几条正则」，
 * 所以这里只有一张平表，不区分那两类。
 *
 * 接新站/站点改版只改这张表，不用碰代码（server/parsers/searchRule.ts 是通用执行器）。
 */
import type { ChallengeKind } from './videoParseRules'

export interface SearchRule {
  /** 与解析站点表的 id 对齐（ncat / ylsp / netflixgc / kpkuang / nbmovie） */
  siteId: string
  /** tab 上的站名，与解析页的说法保持一致 */
  name: string
  /** 站点根：拼绝对地址、以及「在源站搜」按钮的落点 */
  homepage: string

  /**
   * 搜索地址模板。占位符：
   *   `%KW%`    percent 编码后的关键词
   *   `%TOKEN%` 现取的令牌（见 token）
   *   `%TS%`    当前毫秒时间戳（有的接口拿它防缓存，还会校验新鲜度）
   *   `%CB%`    随机的 JSONP 回调名
   * 相对地址会拼到 homepage 上。
   */
  url?: string

  /**
   * 请求要带的 Referer。留空 = 不带。
   * 有的接口靠它认「这是从站点页面发起的」（实测 kpkuang 的搜索接口不带就恒回空结果）。
   */
  referer?: string

  /**
   * 接口返回的是 JSON/JSONP 而不是 HTML 时，改用这套**纯声明**取值，不写代码。
   * 有它就忽略下面那批 HTML 正则。
   */
  json?: {
    /** 响应是 `cb({...})` 这种 JSONP 外壳，先剥掉 */
    jsonp?: boolean
    /** 判成功的字段（点分路径），值不为真就当这一发失败（可重试） */
    okPath?: string
    /** 真正的载荷是 base64 过的 JSON，藏在这个字段里（点分路径） */
    base64Path?: string
    /** 结果数组的路径（点分）；留空表示解出来的根就是数组 */
    listPath?: string
    /** 每条结果里各字段的取值路径（点分，相对单条） */
    fields: {
      id?: string
      title: string
      pic?: string
      note?: string
      cat?: string
      info?: string
    }
    /** 用 id 拼落点地址，`%ID%` 会被替换 */
    urlTemplate: string
    /**
     * 这一发失败时最多再试几次。
     * 实测 kpkuang 那个接口偶发回 `{"code":0,"js":""}`（同样的参数下一秒就正常），
     * 不重试的话界面上就是随机「搜不到」。
     */
    retries?: number
  }

  /**
   * 服务端过不去的站点：不发请求，tab 里直接说明 + 给源站入口。
   *
   * 实测 kpkuang 的 /vodsearch/ 恒回 403 + `cf-mitigated: challenge`（.org/.com 都一样），
   * Cloudflare 人机校验要浏览器指纹 + 与出口 IP 绑定的 cf_clearance，服务端拿不到；
   * 挑战页还带 `x-frame-options: SAMEORIGIN`，连内嵌 iframe 都注定是一片空白。
   * 它的 detail / play 页倒是照常 200，所以只有「搜」这一步不行 —— 用户在源站搜到之后
   * 把详情页地址粘回来即可（详情页现在能直接解析，见 ParseRule.detailRe）。
   */
  manual?: { reason: string; searchUrl: string }

  /**
   * 「去源站搜」按钮的落点模板（`%KW%`）。**只在 `url` 不是给人看的页面时才需要写**。
   *
   * 多数站点的 `url` 本身就是搜索页，按钮直接用它即可；但 kpkuang 的 `url` 指向
   * 另一个域名上的 JSONP 接口，点过去是一坨 JSON 而不是搜索结果页。
   * 早先这种情况退回站点首页，等于把用户辛苦打的关键词丢了——他得在源站再输一遍。
   */
  humanSearchUrl?: string

  /** 抓搜索页也要过的反爬握手，与解析共用同一套（ncat = cdndefend 工作量证明） */
  challenge?: ChallengeKind

  /**
   * 搜索要带的令牌：从站点某个页面上现抠（留空 url = 抓首页），按 host 缓存复用。
   *
   * 实测 ncat 的 `t` 不是签名，就是页面上搜索表单里的一个隐藏字段
   * （`<input name="t" value="…"/>`），全站同一个值、有效期以小时计，抓一次够用很久。
   */
  token?: { url?: string; re: string }

  /**
   * 一条结果卡片。**整段匹配即可，不必留捕获组**——下面那些字段正则跑在这一整段上。
   * 卡片之间要能靠首尾锚点切开，收不住的话（非贪婪匹配跨到下一张卡）第一条会吃掉整页。
   */
  itemRe?: string
  /** 卡片的落点：详情页或播放页地址，取第 1 个捕获组 */
  linkRe?: string
  /** 卡片直接给了播放页就优先用它，省掉「详情页 → 播放页」那一跳（实测三个 MacCMS 站都给） */
  playRe?: string
  titleRe?: string
  /** 封面。相对地址会被 absolutize；这些图多半带防盗链，前端一律 no-referrer 加载 */
  picRe?: string

  /**
   * 封面的相对地址要拼到**哪个域名**上。留空 = 站点自己（homepage）。
   *
   * 由来：有的站点页面里写的是 `/vod1/vod/cover/…jpg`，但那个路径在站点主域上是 403
   * （实测 ncat：带反爬 cookie、带 Referer、全套浏览器头照样被 openresty 拒），
   * 真正的图床是另一个域名，同一个路径直接 200。拿站点域名去拼就是一排破图。
   *
   * **域名不写死，现从站点自己的资源里抠**（同 ParseRule.playerOrigin 的思路）：
   * 站点换图床、或者按线路轮换时不用改代码。实测 ncat 把可用图床列在
   * `rdul.js` 的 `window.RDUL` 数组里，而那个 js 的地址就写在页面上。
   */
  picBase?: {
    /**
     * 先从搜索页 HTML 抠出「装着图床地址的资源」的 URL（取第 1 个捕获组）。
     * 留空 = 直接对页面 HTML 跑下面的 `re`。
     */
    fromRe?: string
    /** 在上一步取到的内容里抠图床地址，取第 1 个捕获组（多个候选时取第一个） */
    re: string
  }
  /** 「55集全」「已完结」这类角标 */
  noteRe?: string
  /** 「剧集」「电影」「短剧」 */
  catRe?: string
  /** 「2019/大陆/国产」这类一行简介 */
  infoRe?: string
  /** 「找到 86 部影片」里的数字，用来在 tab 上标「共 N 部，仅列前 M 条」 */
  totalRe?: string
}

export const SEARCH_RULES: SearchRule[] = [
  {
    siteId: 'nbmovie',
    name: '4k影视',
    homepage: 'https://4kvm.org',
    url: '/search?q=%KW%',
    // 卡片直接给 /play/<slug>，没有详情页这一层
    itemRe: '<div class="group relative">[\\s\\S]*?</a>\\s*</div>',
    playRe: 'href="(/play/[^"]+)"',
    // 片名在 <h3> 里，但 alt 属性上是同一个值且不含换行缩进，取 alt 更省事
    titleRe: 'alt="([^"]*)"',
    // 封面走百度图片代理，地址里的 & 是 &amp; 转义过的（executor 统一解实体）
    picRe: 'data-src="([^"]+)"',
    // 年份角标与 4k 角标共用一套 class，取第一个（年份在前）
    noteRe: 'rounded">\\s*([^<]*?)\\s*</div>',
    totalRe: '找到 <span[^>]*>(\\d+)</span> 个结果',
  },
  {
    siteId: 'ylsp',
    name: '永乐视频',
    homepage: 'https://www.ylsp.lv',
    // 关键词直接嵌在路径里，后面那串短横是 MacCMS 的空筛选位
    url: '/vodsearch/%KW%-------------/',
    // 卡片收在「详情」按钮上：每张卡恰好一个 play-btn-o，用它当尾锚不会跨卡
    itemRe: '<div class="module-card-item module-item">[\\s\\S]*?class="play-btn-o"[\\s\\S]*?</a>',
    playRe: 'href="(/play/[^"]+)"',
    linkRe: 'href="(/voddetail/[^"]+)"',
    titleRe: 'module-card-item-title"[\\s\\S]*?<strong>([^<]+)</strong>',
    picRe: 'data-original="([^"]+)"',
    noteRe: 'module-item-note">([^<]*)<',
    catRe: 'module-card-item-class">([^<]*)<',
    infoRe: 'module-info-item-content">([^<]*)<',
  },
  {
    siteId: 'netflixgc',
    name: '奈飞工厂',
    homepage: 'https://netflixgc.net',
    url: '/vodsearch/-------------.html?wd=%KW%',
    // 尾锚是卡片右下角那颗「播放」按钮（class="button"）
    itemRe: '<div class="vod-detail style-detail cor4 search-list">[\\s\\S]*?class="button"[\\s\\S]*?</a>',
    playRe: 'href="(/vodplay/[^"]+)"',
    linkRe: 'href="(/voddetail/[^"]+)"',
    titleRe: 'slide-info-title[^"]*">([^<]+)<',
    picRe: 'data-src="([^"]+)"',
    noteRe: 'slide-info-remarks cor5">([^<]*)<',
  },
  {
    siteId: 'ncat',
    name: '网飞猫',
    homepage: 'https://www.ncat22.com',
    url: '/search?t=%TOKEN%&k=%KW%',
    challenge: 'cdndefend',
    // 站点任意页面的搜索表单里都有这个隐藏字段，抓首页最稳
    token: { re: 'name="t" value="([^"]+)"' },
    // 卡片本身就是那个 <a>。尾锚必须写成「</a> 后面跟着下一张卡的开头或列表收尾」——
    // 只用前瞻会让非贪婪匹配停在卡片内部第一个 </div>（那是分类角标，离开头不到 100 字节），
    // 于是每张卡只剩个壳，片名封面全抠不到（踩过）
    itemRe: '<a href="/detail/[^"]+" class="search-result-item">[\\s\\S]*?</a>\\s*(?=<a href="/detail/|</div>)',
    // 只给详情页，靠 ParseRule.detailRe 那一跳换成播放页
    linkRe: 'href="(/detail/[^"]+)"',
    titleRe: 'title="([^"]+)"',
    picRe: 'data-original="([^"]+)"',
    // 页面里写的是 /vod1/…，但那个路径在 www.ncat22.com 上恒 403（openresty 直接拒，
    // 带反爬 cookie 也没用）。可用图床列在页面引的 rdul.js 里（window.RDUL 数组，
    // 实测第一条 vres.cyscyy.com 同路径直接 200），现抠现用，站点换域名不用改代码
    picBase: {
      fromRe: 'src="([^"]*rdul[^"]*\\.js[^"]*)"',
      re: '"(https?://[^"]+)"',
    },
    catRe: 'search-result-item-header">\\s*<div>([^<]*)<',
    totalRe: '找到<span[^>]*>\\s*(\\d+)\\s*</span>部影片',
  },
  {
    siteId: 'kpkuang',
    name: '看片狂人',
    homepage: 'https://www.kpkuang.org',
    /*
     * 不走它的 /vodsearch/ 页面 —— 那条路径挂着 Cloudflare 人机校验（实测 .org/.com 全是
     * 403 + cf-mitigated: challenge，而同一个客户端取 /voddetail//vodplay/ 都是 200，
     * 所以那是一条只打在搜索路径上的 WAF 规则，换 UA/TLS 指纹都没用）。
     *
     * 改用站点首页那颗搜索框自己调的接口：另一个域名、JSONP、没有 CF。
     * 拿到的是 vod id，拼成 /voddetail/<id>/ 交给解析侧的「详情页 → 第 1 集」那一跳。
     */
    url: 'https://kpdata.flixfiend.top/esearch/index?kw=%KW%&ts=%TS%&callback=%CB%&_=%TS%',
    // 「去源站搜」要落在给人看的那张页上。它挂着 CF 校验（所以我们服务端不走它），
    // 但用户自己的浏览器过得去——这正是这颗按钮存在的意义
    humanSearchUrl: '/vodsearch/-------------.html?wd=%KW%',
    // 不带 Referer 这个接口恒回空结果（它靠这个认「请求来自站点页面」）
    referer: 'https://www.kpkuang.org/',
    json: {
      jsonp: true,
      okPath: 'code',
      base64Path: 'js',
      fields: {
        id: 'id',
        title: 'data.vod_name',
        pic: 'data.vod_pic',
        note: 'data.vod_year',
        info: 'data.vod_area',
      },
      urlTemplate: 'https://www.kpkuang.org/voddetail/%ID%/',
      // 同样的参数偶发回 {"code":0,"js":""}，下一秒就正常。不重试的话界面上是随机「搜不到」
      retries: 2,
    },
  },
]

export function findSearchRule(siteId: string): SearchRule | null {
  return SEARCH_RULES.find(r => r.siteId === siteId) ?? null
}

/**
 * 把模板里的占位符填上。关键词一律 percent 编码（路径与 query 两种位置都安全）。
 * `%TS%`/`%CB%` 每次现生成：有的接口校验时间戳新鲜度，复用旧值会被判为重放而回空。
 */
/**
 * 「去源站搜」「在源站看全部」这两颗按钮的落点，**每次搜索都要重算**。
 *
 * 早先这个地址只在服务端返回里带回来，于是有两种情况会给出错的链接：
 * ① 新一轮搜索还在跑（或直接失败）时，界面上留着**上一个关键词**的地址——
 *   用户搜了「我是谁」，点过去却是上次那个词的结果页，看着像我们把搜索词记串了；
 * ② `url` 是接口而不是页面的站点（kpkuang 的 JSONP），点过去是一坨 JSON。
 *
 * 拿不到「带关键词的页面地址」时返回 null，让调用方退回服务端给的值或站点首页——
 * 典型是 ncat：它的搜索页要带一个现抠的 `t`，只有服务端手上有。
 */
export function buildSiteSearchUrl(rule: SearchRule, kw: string): string | null {
  if (rule.manual) return buildSearchUrl(rule.manual.searchUrl, kw)

  const tpl = rule.humanSearchUrl ?? rule.url
  // %TOKEN% 得靠服务端现抠，前端拼不出来（拼了也是个少参数的死链）
  if (!tpl || tpl.includes('%TOKEN%')) return null

  const base = rule.homepage.replace(/\/+$/, '')
  const abs = /^https?:/i.test(tpl) ? tpl : base + tpl
  // 跨到别的域名 = 那是接口不是页面，当不得「去源站搜」的落点
  if (!abs.startsWith(base + '/') && abs !== base) return null
  return buildSearchUrl(abs, kw)
}

export function buildSearchUrl(template: string, kw: string, token = ''): string {
  return template
    .replace(/%KW%/g, encodeURIComponent(kw))
    .replace(/%TOKEN%/g, encodeURIComponent(token))
    .replace(/%TS%/g, String(Date.now()))
    .replace(/%CB%/g, 'jQuery' + Math.floor(Math.random() * 1e10))
}

// ── 接口返回的数据形状（前后端共用）──

export interface SearchItem {
  title: string
  /** 点一下要去解析的地址：卡片给了播放页就是它，否则是详情页 */
  url: string
  detailUrl?: string
  playUrl?: string
  pic?: string
  /** 「55集全」「已完结」 */
  note?: string
  /** 「剧集」「电影」 */
  cat?: string
  /** 「2019/大陆/国产」 */
  info?: string
}

export interface SiteSearchResult {
  siteId: string
  items: SearchItem[]
  /** 站点自报的总数，用来提示「只列出了第一页」 */
  total?: number
  /**
   * 站点在服务端被挡住了（目前只有 Cloudflare 人机校验这一种）。
   * 不当错误报：这不是我们坏了，用户在源站自己搜还是能搜到的。
   */
  blocked?: 'cloudflare'
  /** blocked 时给出的源站搜索地址 */
  siteSearchUrl?: string
}
