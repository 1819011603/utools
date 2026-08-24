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
  /**
   * 线路名（「大陆0线」）。序号只是它在页面上的位置，源站增删线路后就指到别处去了，
   * 分享链接放几天再打开会静默换成另一条线路。有名字就按名字认，序号退居兜底。
   */
  lineName?: string
}

/**
 * 交给 hls.js 的 MSE 窗口硬上限（秒）。
 *
 * 曾经有个独立的「最大缓冲时长」（`maxMaxBufferLength`）输入框，已删——它和「预加载时长」
 * **是一回事**：两者进 hls.js 前都被 `Math.min` 压到 30/60，用户填的数字压根到不了 hls.js；
 * 而「预加载时长」还兼着真正有用的那个职责（JS 预取深度 `effectivePrefetchTarget`）。
 * 留两个输入框只会让人以为它们各管一段，实际改第二个什么也不会发生。
 *
 * 统计面板显示 MSE 天花板也用这个常量——同一个算式写两遍必然漂移。
 */
export const MSE_CEILING_SECS = 60

/** HLS 可调配置（「HLS 配置」卡片直接绑定，随 SavedState 持久化） */
export interface HlsTuning {
  /**
   * 「预加载时长」（秒，**墙钟 / 够播几秒**）——JS 预取深度。
   * **不是「缓存几秒视频」**：3x 下要缓存 90 秒视频才算「够播 30 秒」，换算在
   * useHlsPrefetch 的 `effectivePrefetchTarget` 里做。与「存货保险线」同一把尺子。
   * 它**不再参与 hls.js 的 MSE 窗口**（那是技术天花板，见 MSE_CEILING_SECS）。
   */
  maxBufferLength: number
  backBufferLength: number     // 后台缓冲（秒）
  maxBufferSizeMB: number      // 预取缓存内存上限（MB）——JS 侧缓存，非 MSE
  fragLoadingTimeOut: number   // 单个分片下载超时上限（ms）
  fragLoadingMaxRetry: number
  enableWorker: boolean
  lowLatencyMode: boolean
  /**
   * 「存货保险线」（秒，墙钟）。手上缓存**够播**的秒数低于它 = 吃紧，预取线程收敛到 2~3，
   * 把连接和带宽让给紧邻播放头那一片；补够了再放开爬满。
   * 判据是 `缓存秒数 ÷ 倍速`，所以 3x 下缓存 15 秒才等于这里的 5 秒。
   * 详见 useHlsPrefetch 的 SAFE_WALL_SECS。调大 = 更保守（更早收敛、更稳但预取铺得慢）。
   */
  safeWallSecs: number
}

/**
 * 首次进页面的默认值。真正的大量预读放在 JS 预取缓存里，
 * 喂进 hls.js 的 MSE 值会在 useVideoEngine 里再用 Math.min 压到 30/60（见那里的注释）。
 *
 * **预读深度与内存上限都不能一味给大**（这两项曾经都是 3600，是页面偶发「整个浏览器卡死」的根因）：
 * `maxBufferLength` 是 `effectivePrefetchTarget()` 的直接来源，给 3600 就是让引擎一路预读到
 * 一小时之后，1080p 3Mbps 的片子能堆出 1GB+ 的 ArrayBuffer。而**后台标签页是浏览器做内存
 * 压缩/回收的首选对象**——切走再切回来要把这一大坨整体换页回来，主线程整段阻塞，
 * 表现就是「浏览器像卡死了一样，再切一次才好」。
 * 抗卡真正吃紧的是「濒卡 <30s」那个区间，缓到 10 分钟和缓到 1 小时对流畅度的差别几乎为零，
 * 内存却差 5 倍。要更深的人在「HLS 配置」卡片里自己调。
 */
export const DEFAULT_HLS_TUNING: HlsTuning = {
  // 预读深度：**够播 60 秒**（1x 时 ~22MB @3Mbps，3x 时缓存 180 秒视频 ~67MB）。
  // 只有这一项决定预取内存。单位是墙钟秒，不是视频秒——见 HlsTuning 上的说明
  maxBufferLength: 60,
  backBufferLength: 300,
  maxBufferSizeMB: 1024,       // LRU 天花板，兜住高码率源；正常由上面的预读深度先到顶
  fragLoadingTimeOut: 300000,
  fragLoadingMaxRetry: 3,
  enableWorker: true,
  lowLatencyMode: false,
  safeWallSecs: 5,             // 存货不够播 5 秒就收敛线程（见 HlsTuning 上的说明）
}

/**
 * 迁移 localStorage 里存下来的旧配置。
 *
 * 存档的优先级高于默认值，所以**光改 `DEFAULT_HLS_TUNING` 对老用户等于没改**——
 * 他们要一直手动点「重置默认」才吃得到。而这次调小的两项治的是「浏览器偶发卡死几秒」
 * （几百 MB~GB 级 ArrayBuffer 的 GC / 换页），恰恰是老用户最需要的修复，
 * 不能指望他们自己去点那个按钮。
 *
 * **只认旧的默认值 3600，不做区间钳制**：用户手动填过别的数字（比如为某个慢源站特意调到
 * 1800）是明确意图，悄悄改掉比不改更糟。3600 三项同时出现只可能是旧默认留下的。
 */
export function migrateHlsTuning(saved: Partial<HlsTuning>): Partial<HlsTuning> {
  const out = { ...saved }
  const OLD_DEFAULT = 3600
  /**
   * 「预加载时长」的**语义**变了：以前是「缓存几秒视频」，现在是「够播几秒」（墙钟）。
   * 老默认值 600 按新语义读就是「够播 10 分钟」，3x 下等于要缓存 30 分钟视频——
   * 比它原本的意思还夸张，正是当初调小 3600 时要治的那个毛病。
   * 所以旧默认值 600 也一并迁到新默认值。**同样只认精确匹配**：
   * 手填过别的数字是明确意图，悄悄改比不改更糟。
   */
  if (out.maxBufferLength === OLD_DEFAULT || out.maxBufferLength === 600) {
    out.maxBufferLength = DEFAULT_HLS_TUNING.maxBufferLength
  }
  if (out.backBufferLength === OLD_DEFAULT) out.backBufferLength = DEFAULT_HLS_TUNING.backBufferLength
  if (out.maxBufferSizeMB === OLD_DEFAULT) out.maxBufferSizeMB = DEFAULT_HLS_TUNING.maxBufferSizeMB
  return out
}

/** 「重置默认」按钮用的一套：缓冲时长回到保守值，内存上限仍给足 */
export const FACTORY_HLS_TUNING: HlsTuning = {
  ...DEFAULT_HLS_TUNING,
  maxBufferLength: 30,
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
  /** 超快倍速（3.5~5x）是否解锁。可选：老状态里没有这个键，读的时候按 false 兜 */
  turboRate?: boolean
  skipIntro: number
  skipOutro: number
  // 引擎当前生效的连接配置。存下来只为刷新后首屏能立刻显示上次的结论，
  // 真正的取值仍由 applyStrategy 每次加载时重新决定（探测/规则/阶梯）。
  requestOrigin: string
  requestReferer: string
  manifestOnly: boolean
  disguiseAsDownloader: boolean
  dualChannel?: boolean
  // 用户填的防盗链候选值。必须持久化——这类域名（如 vod1.maowushi.com 对应 aeete.com）
  // 从视频地址推不出来，全靠用户自己找，丢一次就得重找一次
  originHint?: string
  refererHint?: string
  hlsConfig: HlsTuning
  tierOverrides?: Partial<TierParams>  // 抗卡策略参数覆盖（空=跟随档位）
  // 按需取址的作业单。列表里存的是占位地址，没有它刷新后一集都播不了
  lazyTask?: ClientResolveTask | null
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
  /**
   * 源站播放页地址 + 线路序号：整份播放列表由播放器自己重新解析得来。
   *
   * 这是解析来的列表**唯一可分享**的表达方式。此前还有 `?handoff=1`（列表在本机
   * localStorage 的「交接槽」里，别人打开一片空白）和 `urls=a|b|c`（几十集顶爆地址栏，
   * 且带签名的地址过几小时就死）——交接槽已整套删除，`handoff` 只剩个被忽略的历史键。
   * 带上来源则链接短、永不过期，别人打开自动解析到同一线路同一集。
   */
  parseUrl?: string
  line?: number
  /**
   * 线路名 / 集名。序号（line/index）是位置，源站增删线路或往中间插集之后就指到别处去了，
   * 而分享链接的寿命恰恰以天计。所以两者都写：**先按名字认，名字找不到才退回序号**。
   */
  lineName?: string
  ep?: string
}

/**
 * 本页自己认识的 query 参数名。
 *
 * 关键坑：视频地址自带 query（`?token=1&sign=2`）时，未编码的 `&` 会被拆成独立参数，
 * 直接读 `route.query.url` 只能拿到 `sign` 之前的部分。所以解析走原始 search 串，
 * 凡「不在这张表里」的片段一律原样回写进最近的那个视频地址。
 */
// `handoff` 已经不再产出也不再读（交接槽整套删了），但**必须留在这张表里**：
// 老书签/老标签页上还有 `?handoff=1`，一旦不认它，这段就会被当成 query 尾巴
// 原样接到最近那个视频地址后面去。同 proxy/noref/manifestOnly——认得出、然后忽略。
export const PAGE_QUERY_KEYS = new Set([
  'url', 'urls', 'index', 'origin', 'referer', 'proxy', 'noref', 'manifestOnly', 'handoff',
  'parseUrl', 'line', 'lineName', 'ep',
])
