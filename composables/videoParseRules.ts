/**
 * 解析规则：从「网站播放页地址」反查出真实视频地址（m3u8/mp4）。
 *
 * 与 videoSiteRules.ts 的分工：
 *   · videoSiteRules 管「拿到视频地址之后怎么播」（代理/防盗链/并发）
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
   * 线路标签。捕获组约定：
   *   1 = class 上的修饰串（含 active 即当前线路）
   *   2 = 线路名        3 = 线路副标题（可选）
   * 顺序必须与 episodeGroupRe 匹配出的分组顺序一一对应。
   */
  lineRe?: string

  /** 选集分组容器，取第 1 个捕获组作为该组的内层 HTML */
  episodeGroupRe?: string

  /** 组内单集。捕获组约定：1 = 相对/绝对链接，2 = 集数标题 */
  episodeRe?: string

  /**
   * 播放时建议的 Referer。留空则用源站播放页的 origin 兜底（见 video-parse 的 playAll）。
   * 两者都只是**候选值**，播放器仍按 直连 → 代理·伪装 → 这对头 → 主域 逐级实测降级，
   * 直连能通就走直连，不会因为写了它就白白多绕一层代理。
   */
  referer?: string
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
    name: '4k影视 (4kvm)',
    // 站点会换域名后缀，用正则兜住
    pattern: '/4kvm\\d*\\.(org|com|net|cc|top)/',
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

/** 目前只有一种；新增执行器时在这里并上，前端 useClientResolve 按 kind 分发 */
export type ClientResolveTask = WasmSignerTask

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
  lines: ParsedLine[]
  activeLineIndex: number
  // 分批解析：单请求有子请求上限，长剧要多批才拉得完。
  // 前端拿到 remaining > 0 就带 offset=batchTo 继续请求下一批，把结果合并进来。
  batchFrom: number
  batchTo: number
  remaining: number
  lineUnsupported?: boolean  // 该线路页面不给直链（src 渲染成空串），整条线路都取不到
  referer?: string
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
