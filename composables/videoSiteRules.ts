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
