/**
 * 解析规则：从「网站播放页地址」反查出真实视频地址（m3u8/mp4）。
 *
 * 与 videoSiteRules.ts 的分工：
 *   · videoSiteRules 管「拿到视频地址之后怎么播」（服务器档位、按 host 的学习档案）
 *   · 本文件管「怎么从一个网页地址拿到视频地址」
 * 两者 pattern 语义保持一致：以 `/` 包裹视为正则，否则按 host 子串匹配。
 *
 * 匹配优先级：用户自定义规则 > 内置规则；同级按数组顺序，第一个命中即用。
 */
import { hostOf } from './videoSiteRules'

/** 反爬类型。none = 直接能取到页面；cdndefend = 需要先过 SHA1 工作量证明。 */
export type ChallengeKind = 'none' | 'cdndefend'

export interface ParseRule {
  id: string
  name: string
  pattern: string
  challenge?: ChallengeKind

  /** 站点首页。界面上的「支持的站点」清单靠它给出可点的入口，用户自定义规则可以不填 */
  homepage?: string

  /** 提取当前集播放地址，取第 1 个捕获组 */
  sourceRe: string

  /**
   * sourceRe 抠出来的地址要怎么解码。留空 = 原样。
   *
   * 'maccms'：苹果 CMS（`player_aaaa`）系站点的地址按 `encrypt` 字段有三种形态——
   * 明文 / percent / base64 套 percent。解码器自适应解到 http 开头为止，**不读 encrypt 值**：
   * 同一站点不同线路的 encrypt 可以不同（实测 ylsp=0、netflixgc=2），按字段写死会漏。
   *
   * 'base64-scan'：base64 前面塞了几个随机字符（实测 kpkuang 的 `data-play` 恒为 3 个、
   * 每次刷新都变）。逐个偏移试到解出 http 开头为止，不写死前缀长度。
   */
  sourceDecode?: 'maccms' | 'base64-scan'

  /**
   * 只接受媒体地址（m3u8 / mp4 之类），抠出来的是**网页地址**就当这条线路没给直链。
   *
   * 由来：有些站点的部分线路给的是第三方站点的播放页（实测 kpkuang 的芒果线给
   * `www.mgtv.com/b/…`、超清 AB 线给 `abyssplayer.com/…`），要它自家的解析服务才变得出
   * 视频，我们拿不到。这类地址是合法 http 地址，不筛掉就会一路喂到播放器里黑屏，
   * 而报错信息只会是「加载失败」。
   *
   * 筛掉之后的去向看有没有配 `playerOrigin`：配了就拼成 `ParseResult.embedUrl`
   * 用站点自带的播放器内嵌播，没配才当 lineUnsupported 报出来。
   */
  sourceMediaOnly?: boolean

  /**
   * 线路标签。捕获组约定：
   *   1 = class 上的修饰串（含 active 即当前线路）
   *   2 = 线路名        3 = 线路副标题（可选）
   * 顺序必须与 episodeGroupRe 匹配出的分组顺序一一对应。
   */
  lineRe?: string

  /**
   * 判定「当前线路」的标记，对 lineRe 的第 1 个捕获组匹配，默认 `active`。
   * 各站的 class 名不一样（ylsp 用 `active`、netflixgc 用 `on`），
   * 认错的表现是解析结果默认落到第一条线路上，而不是用户点开的那条。
   */
  activeFlagRe?: string

  /** 选集分组容器，取第 1 个捕获组作为该组的内层 HTML */
  episodeGroupRe?: string

  /** 组内单集。捕获组约定：1 = 相对/绝对链接，2 = 集数标题 */
  episodeRe?: string

  /**
   * 剧名。留空则从 `<title>` 削掉站名后缀兜底，够用就别写。
   * 有些站点的 title 是一长串 SEO 文案（实测 netflixgc 有 90 多个字符），
   * 兜底削不干净——而这个值会顶掉播放器的标题栏，必须是干净的剧名。
   */
  titleRe?: string

  /**
   * 播放时建议的 Referer。留空则用源站播放页的 origin 兜底（见 video-parse 的 playAll）。
   * 两者都只是**候选值**，播放器仍按 直连 → 代理·伪装 → 这对头 → 主域 逐级实测降级，
   * 直连能通就走直连，不会因为写了它就白白多绕一层代理。
   */
  referer?: string

  /**
   * 播放时建议的 Origin。**不填则用播放页 origin 兜底**，只有在源站的防盗链认的是
   * 另一个域名时才需要显式写（实测 netflixgc.net 的视频只认 cjbfq.netflixgc.tv，
   * 播放页域名和主域都是 403）。同 referer，仍只是候选值。
   *
   * 能用 `playerOrigin` 动态取到就别写死这个——站点换播放器域名的频率不低。
   */
  origin?: string

  /**
   * 从站点自己的配置/播放页里**动态取**「解析播放器地址」。同一个值有两用：
   *   · 它的 origin → 防盗链候选值，取代写死的 origin/referer
   *   · 它整串（形如 `https://…/?url=`）→ 拼 `ParseResult.embedUrl` 的前缀，
   *     即 `sourceMediaOnly` 筛掉第三方播放页之后，用它内嵌播的那个地址
   *
   * 由来：这类站点的视频挂在毫不相干的 CDN 上（`v.fengbao10.com`），防盗链认的却是
   * 站点自己的播放器页（`cjbfq.netflixgc.tv/player/ec.php?...&url=<视频地址>`）。
   * 而那个 iframe 是 JS 运行时注入的，抓回来的静态 HTML 里根本没有——地址在
   * MacCMS 的 `/static/js/playerconfig.js` 里，每条线路（`player_aaaa.from`）一份。
   *
   * 写死也能用，但站点换播放器域名时就得改代码；动态取则自动跟上。
   * 取到的优先于 origin/referer，取不到就退回它们（配置文件 404 之类）。
   */
  playerOrigin?: {
    /**
     * 配置文件地址，相对站点根。
     *
     * **留空 = 域名就写在播放页上**，直接对当前页的 HTML 跑 `re`，不发请求、也不按 host 缓存
     * （实测 kpkuang 的 `data-pars`：每条线路的解析播放器不同，按 host 缓存会把上一条线路的
     * 域名喂给下一条）。这种情况下 `fromRe` 无意义。
     */
    url?: string
    /** 从配置里抠播放器地址，取第 1 个捕获组；`%FROM%` 会被替换成当前线路的标识 */
    re: string
    /** 从播放页抠当前线路的标识（喂给上面的 `%FROM%`）。抠不到就退回配置里第一条 */
    fromRe?: string
  }

  /**
   * 按需取址：解析阶段只取传入的那一集，其余集播到哪集才去抓哪集的播放页。
   *
   * 这类规则的地址是**逐集抓页**抠出来的，一集一个子请求。长剧（实测 ylsp 186 集）
   * 一次抓完既慢又容易被源站限流，而用户通常只看几集。默认应当打开——
   * 只有集数很少、且确实要一次性拿到全部地址（比如给「复制全部」用）时才关。
   */
  lazy?: boolean
}

// 内置规则表——地址明文写在页面里、能用正则描述的站点都加在这，复制一条改 pattern 与几个正则即可。
// 需要写代码才能解析的站点（接口另取、签名、加密…）不进这张表，
// 去 server/parsers/sites/ 加一个 .ts 并在 server/parsers/index.ts 注册。
export const BUILTIN_PARSE_RULES: ParseRule[] = [
  {
    id: 'ncat',
    name: '网飞猫 (ncat)',
    // 站点会换域名（ncat22 / ncat23 …），用正则兜住数字后缀
    pattern: '/ncat\\d*\\.(com|app|net)/',
    homepage: 'https://www.ncat22.com/',
    challenge: 'cdndefend',
    // 地址明文写在内联脚本的 xgplayer 播放源里，没有二次解析接口
    sourceRe: 'playSource\\s*=\\s*\\{[^}]*?src:\\s*"([^"]+)"',
    lineRe: '<a[^>]*class="source-item\\s*([^"]*)"[^>]*>\\s*<span class="source-item-label">([^<]*)</span>\\s*(?:<span class="source-item-sublabel">([^<]*)</span>)?',
    // 该站把「全部线路」的选集都渲染在同一页里（非当前线路 display:none），
    // 所以一次请求就能拿到整张线路 × 集数表，不用逐线路翻页
    episodeGroupRe: '<div class="episode-list"[^>]*>([\\s\\S]*?)</div>',
    episodeRe: '<a[^>]*href="([^"]+)"[^>]*class="[^"]*episode-item[^"]*"[^>]*>\\s*<span>([^<]*)</span>',
  },
  // ── 以下两条是苹果 CMS（MacCMS）站点，页面结构不同但地址都在 player_aaaa 里 ──
  // 这类站点占了国内影视站的大多数，接新站基本就是把下面这条复制一份改四个正则。
  {
    id: 'ylsp',
    name: '永乐视频 (ylsp)',
    pattern: '/ylsp\\d*\\.[a-z]{2,4}\\//',
    homepage: 'https://www.ylsp.lv/',
    // encrypt=0，地址是明文，只是 JSON 里的 `\/` 要还原
    sourceRe: 'player_aaaa\\s*=\\s*\\{[\\s\\S]*?"url"\\s*:\\s*"([^"]+)"',
    sourceDecode: 'maccms',
    // 当前线路渲染成 <div>、其余是 <a>，所以标签名不能写死
    lineRe: '<(?:a|div)[^>]*class="module-tab-item tab-item([^"]*)"[^>]*>\\s*<span>([^<]*)</span>',
    // 组不能用 `</div>` 收尾：当前集的 <a> 里嵌了 <div class="playon">，
    // 非贪婪匹配会断在那，整条线路只剩 1 集（踩过）
    episodeGroupRe: '<div class="module-play-list-content[^"]*">([\\s\\S]*?)</div></div></div>',
    episodeRe: '<a class="module-play-list-link[^"]*" href="([^"]+)"[^>]*>\\s*<span>([^<]*)</span>',
    // title 是「剧名-免费在线观看-集号」，兜底只削得掉最后一段
    titleRe: '<title>([^<-]+)',
    // 实测 186 集，一次抓完要 186 个子请求
    lazy: true,
  },
  {
    id: 'netflixgc',
    name: '奈飞工厂 (netflixgc)',
    pattern: '/netflixgc\\d*\\.(net|com|tv|cc)/',
    homepage: 'https://netflixgc.net/',
    // encrypt=2：base64 套 percent，两层都由 sourceDecode 剥
    sourceRe: 'player_aaaa\\s*=\\s*\\{[\\s\\S]*?"url"\\s*:\\s*"([^"]+)"',
    sourceDecode: 'maccms',
    lineRe: '<a data-form="[^"]*" class="vod-playerUrl swiper-slide([^"]*)"[^>]*>(?:<i[^>]*>[^<]*</i>)?(?:&nbsp;)?([^<]*)<',
    // 当前线路的标记是 `on` 不是 `active`
    activeFlagRe: '\\bon\\b',
    episodeGroupRe: '<ul class="anthology-list-play[^"]*">([\\s\\S]*?)</ul>',
    episodeRe: '<a[^>]*href="([^"]+)"[^>]*>\\s*<span>([^<]*)</span>',
    // title 是一长串 SEO 文案，剧名只在书名号里
    titleRe: '<title>[^<]*《([^》]+)》',
    // 视频挂在与播放页无关的 CDN 上（v.fengbao10.com 之类），防盗链认的是站点自己的
    // 播放器页。地址从站点的播放器配置里现取，站点换域名时不用改代码
    playerOrigin: {
      url: '/static/js/playerconfig.js',
      re: '"%FROM%"\\s*:\\s*\\{[^}]*?"parse"\\s*:\\s*"(https?:[^"]+)"',
      fromRe: '"from"\\s*:\\s*"([^"]+)"',
    },
    // 配置文件取不到时的兜底（实测值，2026-08）
    referer: 'https://cjbfq.netflixgc.tv',
    origin: 'https://cjbfq.netflixgc.tv',
    lazy: true,
  },
  {
    id: 'kpkuang',
    name: '看片狂人 (kpkuang)',
    pattern: '/kpkuang\\d*\\.(org|com|net|cc|tv)/',
    homepage: 'https://www.kpkuang.org/',
    // 不是 player_aaaa 那一套：地址在播放器 iframe 的 data-play 上，
    // 3 个随机字符 + base64（见 decodeScannedBase64）
    sourceRe: 'data-play="([^"]+)"',
    sourceDecode: 'base64-scan',
    // 26 条线路里有几条给的是第三方站点的播放页而非直链，筛掉当「未给出直链」，见 sourceMediaOnly
    sourceMediaOnly: true,
    // active 标记在外层 <li> 上（uk-active），不在 <a> 上，所以捕获的是 li 的 class
    lineRe: '<li class="(fed-drop-btns[^"]*)"[^>]*>\\s*<a[^>]*class="[^"]*line-select[^"]*"[^>]*data-linename="([^"]*)"',
    activeFlagRe: '\\buk-active\\b',
    // 必须从 fed-play-item 起锚：页面上另有两个空的 `<ul class="fed-part-rows">`
    // （一个在选集区之前、一个在之后），直接匹配这个 ul 会多出两组、整张表错位一位。
    // 另外 class 后面不能收在 `"` 上——超清 AB/BY/EV 三条线带了 style 属性（踩过：漏 3 组）
    episodeGroupRe: '<li class="fed-play-item[^"]*">[\\s\\S]*?<ul class="fed-part-rows"[^>]*>([\\s\\S]*?)</ul>',
    episodeRe: '<a class="fed-btns-info[^"]*"[^>]*href="([^"]+)"[^>]*>\\s*([^<]*?)\\s*</a>',
    // title 是「《剧名》(年份) - 在线播放页面 - 当前播放:N - 线路:X - 站名」
    titleRe: '<title>[^<]*《([^》]+)》',
    // 防盗链域名**每条线路都不一样**，而且就写在播放页的 data-pars 上（那是这条线路用的
    // 解析播放器前缀）：睿映线认 soul.flixfiend.top、电影天堂线认 vip.dyttzyplay.com、
    // 芒果线认 jx.xmflv.com。所以不给 url —— 现抠当前页，也不按 host 缓存
    playerOrigin: {
      re: 'data-pars="(https?:[^"]*)"',
    },
    // 实测 26 条线路、最多 71 集
    lazy: true,
  },
]

/**
 * 代码型站点的登记表：这些站点用正则描述不了（要另调接口、要签名、要解密…），
 * 实现各自独立在 `server/parsers/sites/<id>.ts`，在 `server/parsers/index.ts` 注册。
 *
 * pattern 放在这里而不是各自的 .ts 里，是因为前端也要用它判断「这个地址支持不支持」——
 * 前端不能 import server/ 下的代码，两边各写一份必然漂移。
 */
export interface CodedParseSite {
  id: string
  name: string
  pattern: string
  /** 站点首页，同 ParseRule.homepage */
  homepage?: string
  /** 一句话说明这个站的特殊之处（限流、要登录…），只用于界面提示 */
  note?: string
}

export const CODED_PARSE_SITES: CodedParseSite[] = [
  {
    id: 'nbmovie',
    name: '4k影视 (4kvm / ziziys)',
    // 站点会换域名后缀，用正则兜住。同一套程序换皮开的站（ziziys）页面结构同构，
    // 归在同一条里即可，**改这里要同步改 server/parsers/sites/nbmovie.ts 的 PATTERN**
    pattern: '/(4kvm\\d*|ziziys)\\.(org|com|net|cc|top)/',
    homepage: 'https://4kvm.org/',
    note: '源站限流，按需取址：解析只取当前一集，其余播到哪集取哪集',
  },
]

/** 「支持的站点」清单里一条的形状 */
export interface ParseSiteInfo {
  id: string
  name: string
  pattern: string
  homepage?: string
  note?: string
  /** 用户自定义规则 vs 内置，界面上要区分 */
  custom?: boolean
}

/**
 * 界面用：把两张表（+ 用户规则）合成一份可展示的清单。
 * 顺序与 matchParseSite 的优先级一致，这样「清单里排前面的先命中」不会与实际行为打架。
 */
export function listParseSites(userRules: ParseRule[] = []): ParseSiteInfo[] {
  return [
    ...userRules.map(r => ({ id: r.id, name: r.name, pattern: r.pattern, homepage: r.homepage, custom: true })),
    ...CODED_PARSE_SITES.map(s => ({ id: s.id, name: s.name, pattern: s.pattern, homepage: s.homepage, note: s.note })),
    ...BUILTIN_PARSE_RULES.map(r => ({
      id: r.id,
      name: r.name,
      pattern: r.pattern,
      homepage: r.homepage,
      note: r.challenge === 'cdndefend' ? '有反爬校验，首次解析需在浏览器里算几十毫秒的工作量证明' : undefined,
    })),
  ]
}

const LS_KEY = 'video-parse-rules'

export function loadUserParseRules(): ParseRule[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as ParseRule[]
    }
  } catch (e) {
    console.error('加载解析规则失败:', e)
  }
  return []
}

export function saveUserParseRules(rules: ParseRule[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rules))
  } catch (e) {
    console.error('保存解析规则失败:', e)
  }
}

/** pattern 与 host 是否匹配。`/xxx/` 视为正则，否则子串。 */
function patternMatches(pattern: string, host: string, fullUrl: string): boolean {
  if (!pattern) return false
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i').test(fullUrl)
    } catch {
      return false
    }
  }
  return host.includes(pattern)
}

export function matchParseRule(url: string, userRules: ParseRule[] = []): ParseRule | null {
  const host = hostOf(url)
  if (!host) return null
  for (const rule of [...userRules, ...BUILTIN_PARSE_RULES]) {
    if (patternMatches(rule.pattern, host, url)) return rule
  }
  return null
}

/**
 * 界面用：这个地址能不能解析、命中的是谁。
 * 优先级与服务端 matchParser 保持一致：用户规则 > 代码型站点 > 内置规则。
 */
export function matchParseSite(url: string, userRules: ParseRule[] = []): { id: string; name: string } | null {
  const host = hostOf(url)
  if (!host) return null
  for (const s of [...userRules, ...CODED_PARSE_SITES, ...BUILTIN_PARSE_RULES]) {
    if (patternMatches(s.pattern, host, url)) return { id: s.id, name: s.name }
  }
  return null
}

// ── 服务端也要用这张表，但 Nitro 里没有 localStorage ──
// 所以解析接口只吃内置表 + 前端随请求带上来的规则（前端负责读 localStorage）。
export function findRuleById(id: string): ParseRule | null {
  return BUILTIN_PARSE_RULES.find(r => r.id === id) ?? null
}

// ── 接口返回的数据形状（前后端共用）──

export interface ParsedEpisode {
  title: string          // 「第 1 集」
  pageUrl: string        // 该集的播放页绝对地址
  videoUrl?: string      // 解析出的 m3u8/mp4；解析失败时为空
  /**
   * 这一集的「站点自带播放器」地址，见 ParseResult.embedUrl。
   * 只有解析线路才有，且是逐集现取的（解析页点到哪集才填哪集），取过就缓存在这不再重取。
   */
  embedUrl?: string
  error?: string
}

// ── 「取址作业单」：服务端做不了、必须由浏览器完成的那部分 ──
//
// 出现这种分工有两类原因，都不是某个站点独有的：
//   · 算法只以 wasm 形式存在。CF Workers 禁止运行时实例化非打包的 wasm，服务端跑不了；
//     文件名还带内容 hash（站点一更新就变），也没法预先打进产物。
//   · 结果带时效签名，攒一批再用会过期，只能现算现用。
// 另外走浏览器逐发打 /api/proxy，每发都是独立 Worker 调用，
// 天然绕开「单请求 50 subrequest」的硬顶，长剧不必分批。

/** 从接口返回的 JSON 里挑出可播地址的规则（纯声明，接新站不用写代码） */
export interface JsonUrlPick {
  /** 候选数组的路径，点分，如 'data.quality_urls'；留空表示根就是数组 */
  listPath?: string
  /** 地址字段名 */
  urlKey: string
  /** 这些字段为真的候选直接跳过（会员锁定、下架等） */
  skipFlags?: string[]
  /** 按该字段降序取最大（通常是码率/清晰度） */
  rankKey?: string
  /** 失败时取错误文案的路径，点分 */
  messagePath?: string
}

/**
 * 用站点自带的 wasm 现签接口地址，再从接口 JSON 里取真实播放地址。
 * 我们只加载并调用站点公开的导出函数，不复刻其算法——
 * 站点换签名方案时前端不用动，只要页面上还能读到模块地址就继续能用。
 */
export interface WasmSignerTask {
  kind: 'wasm-url-signer'
  /** wasm-bindgen 胶水 js 的绝对地址（带内容 hash，会变，所以每次从页面现读） */
  moduleUrl: string
  /** .wasm 本体的绝对地址 */
  wasmUrl: string
  /** 胶水模块里导出的签名函数名 */
  fn: string
  /** 签名函数返回相对地址时的基准（站点根） */
  base: string
  /** 每集一组实参，与 lines[activeLineIndex].episodes 下标严格一一对应 */
  argsList: string[][]
  /**
   * 站点限流，不许一次把整季都取完 —— 改成「播到哪集才取哪集」。
   * 打开后解析阶段只取当前这一集（验证链路 + 给个能复制的地址），
   * 其余集在播放器里按需现取，见 video-player.vue 的 resolveLazyUrl。
   */
  lazy?: boolean
  /** wasm 要读页面上某个 <meta id=…> 的 content 当时间戳时，填它的 id */
  timestampMetaId?: string
  /** 接口 JSON → 播放地址 */
  pick: JsonUrlPick
}

/**
 * 逐集抓源站播放页、按规则的 sourceRe 抠地址——与 htmlRule 在服务端做的事完全相同，
 * 只是把「什么时候抓」从解析阶段推迟到播放阶段（见 ParseRule.lazy）。
 *
 * 与 WasmSignerTask 的动机不同：那个是服务端**做不了**，这个是服务端**不该一次做完**。
 * 长剧逐集抓页是一集一个子请求，实测 186 集的站点一次抓完要分 5 批、上百个请求，
 * 慢且容易被源站限流，而用户通常只看几集。
 */
export interface HtmlSourceTask {
  kind: 'html-source'
  /** 每集的播放页地址，与 lines[activeLineIndex].episodes 下标严格一一对应 */
  pageUrls: string[]
  /** 同 WasmSignerTask.lazy；这类作业单实际上总是 lazy，字段保留是为了让分发逻辑统一 */
  lazy?: boolean
}

/** 新增执行器时在这里并上，前端 useClientResolve 按 kind 分发 */
export type ClientResolveTask = WasmSignerTask | HtmlSourceTask

export interface ParsedLine {
  name: string           // 「GS线路」
  sublabel?: string      // 「高清」
  active: boolean        // 是否为传入地址所属线路
  episodes: ParsedEpisode[]
}

export interface ParseResult {
  ruleId: string
  ruleName: string
  title?: string         // 影片名（取自 <title>）
  pageUrl: string
  currentVideoUrl?: string
  /**
   * 这条线路只能用**站点自带的解析播放器内嵌播**时给出的 iframe 地址。
   *
   * 由来：部分线路抠出来的不是视频地址，而是第三方站点的播放页（`www.iqiyi.com/v_…`、
   * `www.mgtv.com/b/…`）。真实地址由站点自带的解析服务在浏览器里现算，服务端拿不到——
   * 但站点自己也就是把这个地址塞进 `<iframe src="解析播放器?url=第三方播放页">` 而已，
   * 我们照它的拼法拼出同一个地址内嵌在解析页上即可（用的是它的播放器，不是我们的）。
   *
   * 有它时 `currentVideoUrl` 必为空、`clientTask` 必不下发（我们的播放器放不了这种地址），
   * 也**不算 lineUnsupported**——线路是好的，只是播放器不是我们的。
   */
  embedUrl?: string
  lines: ParsedLine[]
  activeLineIndex: number
  // 分批解析：单请求有子请求上限，长剧要多批才拉得完。
  // 前端拿到 remaining > 0 就带 offset=batchTo 继续请求下一批，把结果合并进来。
  batchFrom: number
  batchTo: number
  remaining: number
  lineUnsupported?: boolean  // 该线路页面不给直链，整条线路都取不到
  /**
   * 不给直链的**具体原因**，界面上直接展示。留空则用「页面把地址留空」这个默认说法。
   *
   * 两种失败长得不一样：ncat 的 4K 线是 src 渲染成空串；kpkuang 的「爱奇艺-VIP解析」
   * 抠到的是 `www.iqiyi.com/v_…` 这类第三方播放页。都说成前者的话，
   * 用户只会以为是我们的正则写坏了（实测被问过）。
   */
  lineUnsupportedReason?: string
  referer?: string
  /** 防盗链认的 Origin 与播放页域名不同时，由规则显式给出（见 ParseRule.origin） */
  origin?: string
  /** 有它就表示 episodes 里全都没有 videoUrl，要前端拿这张作业单去补 */
  clientTask?: ClientResolveTask
}

/** 需要前端算工作量证明时的应答 */
export interface PowChallenge {
  needPow: true
  kind: ChallengeKind
  c: string              // 挑战常量
  n1: number             // 校验字节偏移
  target: [number, number]
}
