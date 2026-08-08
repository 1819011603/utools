/**
 * 播放侧按 host 学习/预设的参数：服务器档位（好/中/差）与学习档案。
 *
 * **「站点规则」整张表已删除**（`SiteRule` / `BUILTIN_RULES` / `matchSiteRule` /
 * 用户自定义规则的读写全部不复存在）。理由：它是一堆写死的静态判断，
 * 而它想解决的每件事现在都有实测来源——
 *   · 连接方式 → 可达性探测（四通道两轴）+ 运行时 lane 熔断；
 *   · 并发    → `useHlsPrefetch` 的闭环控制，按缓冲趋势与实测带宽爬坡；
 *   · 档位    → `classifyTier` 自动分档 + 按 host 学习（`LearnedProfile`）。
 * 规则唯一的作用只剩「让源站改了策略之后整站播不了，还看不出是被谁按住的」。
 */

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
  // 连接可达性探测结果（useReachabilityProbe.ProbeResult）。自带 at 时间戳，
  // 与 updatedAt 分开——档位是长期经验，可达性会随源站策略/签名变化，需独立的短 TTL。
  reach?: { at: number; [k: string]: any }
  updatedAt?: number
}

// 可达性缓存有效期（按 host 存，见 LEARNED_KEY）。
// 放到 1 小时：探测是**阻塞起播**的，首访要等一轮四通道串行降级（慢源上能到十几秒），
// 而源站的 CORS/防盗链策略以天计地稳定，30 分钟一到就重探等于反复付这个代价。
// 结论万一过时也不致命：真实请求失败会走 lane 熔断 + escalateStrategyAndReload 重探，
// 而且命中缓存后本来就有一次后台静默复验（每 host 每会话一次）。
// 注意这跟服务端 headerModeCache 的 30 分钟是两回事，不必对齐——那份是「带不带头」，
// 存在服务端内存里、进程一换就没了。
export const REACH_TTL = 60 * 60 * 1000

export function isReachFresh(profile: LearnedProfile | null | undefined): boolean {
  const at = profile?.reach?.at
  return typeof at === 'number' && Date.now() - at < REACH_TTL
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

function getHost(url: string): string {
  try {
    return new URL(url.startsWith('//') ? 'https:' + url : url).host
  } catch {
    return ''
  }
}
