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
   * 播放时建议注入的 Referer。留空表示交给播放器的可达性探测自动决策——
   * 写死策略会置 manualStrategyOverride，把探测整个关掉，通常更慢。
   */
  referer?: string
}

// 内置规则表——按需扩展：复制一条改 pattern 与几个正则即可
export const BUILTIN_PARSE_RULES: ParseRule[] = [
  {
    id: 'ncat',
    name: '网飞猫 (ncat)',
    // 站点会换域名（ncat22 / ncat23 …），用正则兜住数字后缀
    pattern: '/ncat\\d*\\.(com|app|net)/',
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
}

/** 需要前端算工作量证明时的应答 */
export interface PowChallenge {
  needPow: true
  kind: ChallengeKind
  c: string              // 挑战常量
  n1: number             // 校验字节偏移
  target: [number, number]
}
