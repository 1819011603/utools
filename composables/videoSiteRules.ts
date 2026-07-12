/**
 * 站点规则：按视频 host 自动套用一套代理/防盗链/并发配置，
 * 解决「有些站点播放慢 / 403」——不同 CDN 对代理模式、Referer、并发的要求不同。
 *
 * 匹配优先级：用户自定义规则 > 内置规则；同级按数组顺序，第一个命中即用。
 * pattern 语义：以 `/` 包裹视为正则（如 `/\.jisuzyv\.com$/`），否则按 host 子串匹配。
 */
export interface SiteRule {
  id: string
  name: string
  pattern: string
  useProxy?: boolean
  manifestOnly?: boolean            // true=仅代理 manifest（分片直连，快）；false=全程代理（兼容）
  disguiseAsDownloader?: boolean    // true=不发 Origin/Referer（部分 CDN 放行）
  origin?: string
  referer?: string
  playbackConcurrency?: number      // 预取并发「下限/手动兜底」；不设则引擎按实测+倍速全自动(2-6)
  downloadConcurrency?: number      // 下载并发，默认 6
  dualChannel?: boolean             // true=直连+代理双通道：分片在「直连 CDN」和「/api/proxy」两个 origin 间分流，
                                    // 把浏览器 per-origin 6 连接上限提到 ~12（仅直连可达的源有效，代价是服务器出口流量）
  serverTier?: ServerTier | 'auto'  // 服务器档位：'good'|'medium'|'bad' 手动锁定一档；'auto'/不设=按实测自动分档（可被 host 学习值起步）
}

// ── 服务器档位：好/中/差 三套抗卡参数预设 ──
// 一处集中管理（取代 useHlsPrefetch 里散落的模块常量），供引擎按档位读取。
export type ServerTier = 'good' | 'medium' | 'bad'

export interface TierParams {
  maxConn: number            // 单 origin 并发上限（仍受浏览器 per-host 6 硬顶）
  concurrencyFloor: number   // 起播并发下限
  safety: number             // 带宽安全系数
  panicSecs: number          // MSE 前向缓冲低于此 = 濒卡（触发抗卡阶梯）
  lowSecs: number            // MSE 前向缓冲低于此 = 吃紧（并发爬坡）
  hedgeMs: number            // 关键分片超此时间 → 追加竞速连接（对冲死连接）
  skipMs: number             // 关键分片超此时间 → 跳过该片（保实时）
  maxRacers: number          // 单个关键分片最多并行竞速连接数
  dualChannelAuto: boolean   // 濒卡时是否自动开启直连+代理双通道
}

export const SERVER_TIERS: Record<ServerTier, TierParams> = {
  // 好：单连接就够，低并发 + 长超时，不折腾
  good:   { maxConn: 4, concurrencyFloor: 1, safety: 1.2, panicSecs: 5,  lowSecs: 15, hedgeMs: 8000, skipMs: 30000, maxRacers: 3, dualChannelAuto: false },
  // 中：单连接慢但可并行，靠加线程补齐
  medium: { maxConn: 6, concurrencyFloor: 3, safety: 1.4, panicSecs: 8,  lowSecs: 25, hedgeMs: 5000, skipMs: 18000, maxRacers: 5, dualChannelAuto: false },
  // 差：源站带宽硬顶，激进——满并发 + 双通道 + 短超时快跳
  bad:    { maxConn: 6, concurrencyFloor: 6, safety: 1.7, panicSecs: 12, lowSecs: 40, hedgeMs: 3000, skipMs: 10000, maxRacers: 6, dualChannelAuto: true },
}

// 冷启动/未测出时的兜底档（中档：既不误判快源浪费、也给慢源留余量）
export const DEFAULT_TIER: ServerTier = 'medium'

// 实测自动分档：
//  - 单连接就喂得动码率 → 好
//  - 单连接不够，但满并发聚合能喂动且「聚合随线程增长」（每连接限速、可并行）→ 中
//  - 聚合封顶仍不够，或加线程聚合不涨（每 IP 总量硬顶、不可并行）→ 差
export function classifyTier(
  perConnBps: number,
  segBitrate: number,
  aggregateScales: boolean,
  rate = 1,
  maxConn = 6,
): ServerTier {
  if (!perConnBps || !segBitrate) return DEFAULT_TIER   // 冷启动：先中档
  const demand = segBitrate * rate
  if (perConnBps >= demand) return 'good'
  const aggregate = perConnBps * maxConn
  if (aggregate >= demand * 1.2 && aggregateScales) return 'medium'
  return 'bad'
}

// ── 按 host 记忆的学习档案（自愈调参持久化，下次进同站直接从最优起步）──
export interface LearnedProfile {
  learnedTier?: ServerTier
  bestConcurrency?: number
  dualChannelHelped?: boolean
  stallHistory?: number[]   // 最近若干次会话的卡顿次数（滚动，用于趋势）
  updatedAt?: number
}

const LEARNED_KEY = 'video-player-learned-profiles'

function readLearnedMap(): Record<string, LearnedProfile> {
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, LearnedProfile>
    }
  } catch (e) {
    console.error('加载学习档案失败:', e)
  }
  return {}
}

export function loadLearnedProfile(host: string): LearnedProfile | null {
  if (!host) return null
  return readLearnedMap()[host] ?? null
}

// 合并式保存（保留未提供的字段），限制 host 数量避免无限增长
export function saveLearnedProfile(host: string, profile: LearnedProfile) {
  if (!host) return
  try {
    const map = readLearnedMap()
    const merged: LearnedProfile = { ...map[host], ...profile, updatedAt: Date.now() }
    if (merged.stallHistory && merged.stallHistory.length > 20) {
      merged.stallHistory = merged.stallHistory.slice(-20)
    }
    map[host] = merged
    // 超过 100 个 host 时清理最旧的，防 localStorage 膨胀
    const keys = Object.keys(map)
    if (keys.length > 100) {
      keys.sort((a, b) => (map[a].updatedAt ?? 0) - (map[b].updatedAt ?? 0))
      for (const k of keys.slice(0, keys.length - 100)) delete map[k]
    }
    localStorage.setItem(LEARNED_KEY, JSON.stringify(map))
  } catch (e) {
    console.error('保存学习档案失败:', e)
  }
}

// 从 URL 提取 host（复用内部 getHost 的公开版，供 video-player 记忆按 host 存取）
export function hostOf(url: string): string {
  return getHost(url)
}

// 内置规则表——按需扩展：复制一条改 pattern/name 与要覆盖的字段即可
export const BUILTIN_RULES: SiteRule[] = [
  {
    id: 'jisuzyv',
    name: '极速资源 (jisuzyv)',
    pattern: 'jisuzyv.com',
    // 该 CDN 分片直连易 502，走全程代理更稳；限制并发避免互相堵塞
    useProxy: false,
    manifestOnly: false,
    disguiseAsDownloader: false,
    playbackConcurrency: 2,
    downloadConcurrency: 4,
  },
  {
    id: 'xhscdn',
    name: '小红书 CDN (xhscdn)',
    pattern: 'xhscdn.com',
    // 对无 Origin/Referer 的请求放行，403 时用伪装下载器
    disguiseAsDownloader: true,
    playbackConcurrency: 3,
  },
  {
    id: 'huyall',
    name: '慢速 CDN (huyall/baisiweiting)',
    pattern: '/huyall\\.com|baisiweiting\\.com/',
    // 源站每连接仅 ~80-160KB/s、1080p 需 ~3.5Mbps：只设并发下限保证起播即高并发，
    // 直连/代理仍交给自动可达性阶梯，引擎再按实测微调（冷启动直接用满 6）。
    playbackConcurrency: 6,
    downloadConcurrency: 8,
  },
]

const LS_KEY = 'video-player-site-rules'

// 读取用户自定义规则（独立 localStorage key，避免污染主 state）
export function loadUserSiteRules(): SiteRule[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as SiteRule[]
    }
  } catch (e) {
    console.error('加载站点规则失败:', e)
  }
  return []
}

export function saveUserSiteRules(rules: SiteRule[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rules))
  } catch (e) {
    console.error('保存站点规则失败:', e)
  }
}

function getHost(url: string): string {
  try {
    return new URL(url.startsWith('//') ? 'https:' + url : url).host
  } catch {
    return ''
  }
}

function ruleMatches(rule: SiteRule, url: string, host: string): boolean {
  const p = rule.pattern?.trim()
  if (!p) return false
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    try {
      return new RegExp(p.slice(1, -1)).test(url)
    } catch {
      return false
    }
  }
  return host.includes(p) || url.includes(p)
}

// 命中的规则：用户规则优先，其次内置
export function matchSiteRule(url: string, userRules: SiteRule[] = []): SiteRule | null {
  const host = getHost(url)
  for (const rule of [...userRules, ...BUILTIN_RULES]) {
    if (ruleMatches(rule, url, host)) return rule
  }
  return null
}
