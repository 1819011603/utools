/**
 * 音乐站点的描述符 —— 「换个数据源只加一个文件」的那份契约。
 *
 * ## 分层
 *
 *   `composables/musicPlayer/`   播放器。**一个站点都不认识**，只认 `Track`
 *   `composables/musicSites/`    ← 这里。每个站点一份描述符，站点差异全在这一层
 *   `pages/music.vue`            装配：把注册表接到播放器和闸门上
 *
 * 照的是本项目视频那侧已经验证过的路子（`videoSearchRules.ts` 一张表、执行器不认识任何具体站点）。
 * 共享层里**一句 `if (site === 'xxx')` 都不该有** —— 有了就说明该往描述符里加字段了。
 */
import type { ResolvedTrack } from '../musicPlayer/types'

/** 站点标识。同时用作 `Track.resolver` 和 `Track.key` 的前缀，所以**改名等于让存量收藏失效** */
export type MusicSiteId = '24bit' | 'fangpi'

/**
 * 音质档。
 *
 * `label` 一律用**站点自己的说法**（实测值），不编规格参数 ——
 * 编一个「24bit 96kHz」出来而实际文件不是那个规格，比不写更糟。
 */
export interface QualityTier {
  /** 传给取址接口的档位标识。对播放器和缓存层是**不透明字符串** */
  tier: string
  label: string
  /** 按钮的 title，用来交代体积量级这类事先该知道的信息 */
  hint?: string
  color: 'primary' | 'blue' | 'green' | 'gray'
}

/**
 * 站内的一条搜索泳道。
 *
 * 一个站点可以有多条（24bit 就有两个不同的库），它们**并发搜、各自落地**，
 * 结果在同一段里混排 —— 对用户来说「音源一/音源二」没有意义，他要的是这首歌。
 */
export interface MusicSiteSource {
  id: string
  name: string
}

/**
 * 搜索结果的一条。**一份形状装所有站点的结果**，所以字段要够但不能带站点特有的东西。
 *
 * 字段名 `player` 沿用 24bit 接口自己的叫法（同一个东西两套名字，迟早在某个组件里漂移）。
 */
export interface MusicSearchRow {
  /** 这条是哪个站点来的。**分区展示、按行画档位按钮、拼 Track.key 全靠它** */
  site: MusicSiteId
  id: string
  name: string
  player: string
  /** 专辑。**不是每个站点都给**（fangpi 的搜索页就没有），界面必须做成「有才显示」 */
  album?: string
}

/**
 * 取址定位信息。播放器把它当不透明数据原样交给 resolver（见 `Track.locator`）。
 *
 * ## 这里**故意不放 site**
 *
 * 「这条曲目该找哪个站点取址」由 `Track.resolver` 回答 —— 那本来就是它的职责
 * （"用哪个取址器"），而且**存量数据天然是对的**：接入第二个站点之前存下来的收藏和队列，
 * `resolver` 里躺着的正是 `'24bit'`。
 *
 * 往 locator 里再放一份 `site` 只会多一个可能与 `resolver` 打架的字段，
 * 还要为「老数据里没有它」写一路兜底。这个形状与接入 fangpi 之前**完全一致**，
 * 所以存量收藏一行迁移代码都不需要。
 */
export interface MusicLocator {
  id: string
  /** 上次成功的档位。命中过就下次从它开始，省掉一发注定失败的请求 */
  preferred?: string
}

/** 取址结果。`src` = 实际命中的档位，闸门记下来供下次优先尝试 */
export type MusicResolved = ResolvedTrack & { src?: string }

/** 一个站点的全部知识 */
export interface MusicSite {
  id: MusicSiteId
  /** 面向用户的站名，分区标题上就显示它 */
  name: string
  /** 音质一句话。摆在站名旁边，让用户一眼看出这一段和另一段的差别 */
  tagline: string
  sources: MusicSiteSource[]
  tiers: QualityTier[]
  /**
   * 每页多少条，用来推断「还有没有下一页」（站点都不报总数）。
   * **`0` = 这个站点不分页**，界面据此不画「加载更多」——
   * 画一个永远没反应的按钮，比没有更让人以为坏了。
   */
  pageSize: number

  /** 搜一页。`page` 从 1 开始；不分页的站点一律只会被以 `page=1` 调用 */
  search: (source: string, kw: string, page: number, signal?: AbortSignal) => Promise<MusicSearchRow[]>

  /** 取址。一次只试一个档位，重试和退避由闸门统一管（见 useMusicResolveGate） */
  resolve: (id: string, tier: string, signal?: AbortSignal) => Promise<MusicResolved>

  /**
   * 配额耗尽时说什么。**只有真按天限量的站点才有**（24bit 有，fangpi 没发现）。
   * 有值才意味着这个站点存在「配额」这个概念，闸门据此决定要不要彻底停手。
   */
  quotaHint?: string
  /** 配额提示里那个登录入口。站点自己给的出路 */
  loginUrl?: string
}
