/**
 * 播放器各模块共享的数据形状。
 *
 * 单独成文件的理由：这些结构被「持久化 / 交接槽 / 地址栏 / 引擎」四处同时引用，
 * 放在任一模块里都会让其他三个反向依赖它，形成环。
 */
import type { TierParams } from '../videoSiteRules'
import type { ClientResolveTask } from '../videoParseRules'

/** 播放列表来源：解析页地址 + 线路序号。带签名的地址会过期，靠这个能就地重解析 */
export interface PlaylistSource {
  pageUrl: string
  line: number
}

/** HLS 可调配置（「HLS 配置」卡片直接绑定，随 SavedState 持久化） */
export interface HlsTuning {
  maxBufferLength: number      // 预加载时长（秒）
  maxMaxBufferLength: number   // 最大缓冲时长（秒）
  backBufferLength: number     // 后台缓冲（秒）
  maxBufferSizeMB: number      // 预取缓存内存上限（MB）——JS 侧缓存，非 MSE
  fragLoadingTimeOut: number   // 单个分片下载超时上限（ms）
  fragLoadingMaxRetry: number
  enableWorker: boolean
  lowLatencyMode: boolean
}

/**
 * 首次进页面的默认值。缓冲相关一律给大值：真正的大量预读放在 JS 预取缓存里，
 * 喂进 hls.js 的 MSE 值会在 useVideoEngine 里再用 Math.min 压到 30/60（见那里的注释）。
 */
export const DEFAULT_HLS_TUNING: HlsTuning = {
  maxBufferLength: 3600,
  maxMaxBufferLength: 3600,
  backBufferLength: 3600,
  maxBufferSizeMB: 3600,
  fragLoadingTimeOut: 300000,
  fragLoadingMaxRetry: 3,
  enableWorker: true,
  lowLatencyMode: false,
}

/** 「重置默认」按钮用的一套：缓冲时长回到保守值，内存上限仍给足 */
export const FACTORY_HLS_TUNING: HlsTuning = {
  ...DEFAULT_HLS_TUNING,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  backBufferLength: 30,
}

/** localStorage `video-player-state` 的载荷 */
export interface SavedState {
  videoUrlInput: string
  playlist: string[]
  currentIndex: number
  progress: Record<string, number>  // URL -> 播放进度（秒）
  volume: number
  playbackRate: number
  useProxy: boolean
  autoFullscreen: boolean
  autoBestRate: boolean
  skipIntro: number
  skipOutro: number
  requestOrigin: string
  requestReferer: string
  manifestOnly: boolean
  disguiseAsDownloader: boolean
  dualChannel?: boolean
  manualStrategyOverride: boolean  // 手动连接策略（持久化，避免刷新后被自动策略覆盖）
  hlsConfig: HlsTuning
  tierOverrides?: Partial<TierParams>  // 抗卡策略参数覆盖（空=跟随档位）
  // 按需取址的作业单。列表里存的是占位地址，没有它刷新后一集都播不了
  lazyTask?: ClientResolveTask | null
}

/**
 * localStorage `video-player-handoff` 的载荷（长播放列表交接槽）。
 *
 * 几十集的列表拼进 query 会顶爆地址栏（部分浏览器 2000 字符上界，硬刷新还要过 CF 的请求头上限），
 * 所以改走 localStorage 交接：生产者写这个槽 + 跳 `?handoff=1`，播放器读出来。
 * 带时间戳，过期的不用——避免半个月前的残留列表被翻出来。
 */
export interface HandoffPayload {
  urls: string[]
  names?: string[]            // 集名（「第 12 集」这类），与 urls 同下标；解析页知道，光看 URL 猜不出来
  title?: string              // 剧名，同理
  source?: PlaylistSource
  // 按需取址的站点（站点限流，不许一次把整季都取完）：urls 里放的是源站播放页地址占位，
  // 真实地址等播到那一集才现取。作业单跟着列表一起交接，下标与 urls 严格对齐。
  lazy?: ClientResolveTask
  index?: number
  at: number
}

/** 从地址栏解析出的本页参数 */
export interface QueryVideoParams {
  urls: string[]
  index?: number
  origin?: string
  referer?: string
  proxy?: boolean
  noref?: boolean
  manifestOnly?: boolean
}

/**
 * 本页自己认识的 query 参数名。
 *
 * 关键坑：视频地址自带 query（`?token=1&sign=2`）时，未编码的 `&` 会被拆成独立参数，
 * 直接读 `route.query.url` 只能拿到 `sign` 之前的部分。所以解析走原始 search 串，
 * 凡「不在这张表里」的片段一律原样回写进最近的那个视频地址。
 */
export const PAGE_QUERY_KEYS = new Set([
  'url', 'urls', 'index', 'origin', 'referer', 'proxy', 'noref', 'manifestOnly', 'handoff',
])
