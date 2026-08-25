/**
 * 音乐播放器的共享数据形状。
 *
 * **播放器不认识任何站点**——这是「可复用」的全部含义。它只认 `Track`：
 * 手上有 `url` 就直接播；没有就拿 `locator` 交给外部注入的取址回调（`TrackResolver`）现取。
 * 24bit 的那些 `/music/b/`、`searchOnlineMusicOne` 只存在于 `composables/music24bit.ts` 里。
 */

/** 一首曲子。同时用于队列、收藏、下载三处，所以字段要够但不能带站点特有的东西 */
export interface Track {
  /**
   * 稳定标识，做队列去重、收藏比对、下载排队的键。
   *
   * **绝不能用 `url` 当键**：24bit 的地址带时效签名、约 20 分钟一换，
   * 同一首歌前后两次取到的地址完全不同（同 video-parse 里 `progressKey()` 那条教训）。
   * 手粘直链的 key 就是那个地址本身（它本来就是终态，不会变）。
   */
  key: string

  name: string
  /** 歌手。沿用站点的叫法（它那边字段名就是 player），避免同一个东西两套名字 */
  artist?: string
  album?: string
  cover?: string
  /** 'flac' | 'mp3' | …。**下载时的扩展名只信这个**，不信 CDN 的 content-type（实测谎报） */
  format?: string
  /** 站点给的可读体积（如 `20.76 MB`）。只用来显示，真实字节数下载时读 content-length */
  sizeText?: string
  /** 音质标注（如「无损音质」「高清环绕声」），站点自报，只做展示 */
  quality?: string
  /**
   * 时长（秒）。站点**不给**这个字段，只能等 `<audio>` 的 loadedmetadata 回填。
   * 所以列表里在播过之前是没有时长的 —— 别为了填上它去预加载，那是几十上百 MB 的代价。
   */
  duration?: number

  /**
   * 歌词原文（LRC 格式或纯文本）。取址时顺带拿到，**经常是空的**
   * ——实测酷我那个源回的是长度 2 的空占位，所以界面必须做成「有才显示」。
   */
  lrc?: string

  /**
   * 播放地址。**这个字段绝不能被持久化**（写进 localStorage 的地址下次打开必定是死链）。
   * 留空 = 还没取址，播放前要先过 `TrackResolver`。
   */
  url?: string

  /**
   * 取址所需的定位信息，**对播放器是不透明的**——它只负责原样交给 resolver。
   * 24bit 那边是 `{ src: 'b' | 'c', id }`，换个站点是别的形状，播放器一律不看。
   */
  locator?: unknown

  /**
   * 用哪个取址器。留空 = `url` 已是终态，不需要取址（手粘直链就是这种）。
   * 有值时即使 `url` 已经有内容，过期后也能靠它重取。
   */
  resolver?: string
}

/**
 * 取址回调：把 `locator` 换成可播的地址。由页面装配时注入（见 useMusicPlayerController 的 deps）。
 *
 * **实现方必须自带节流**：24bit 的限流是静默的（照常回 200、只是不给地址），
 * 密集取址会把整个站点对我们关上门。闸门在 `useMusicResolveGate`。
 */
export type TrackResolver = (track: Track) => Promise<ResolvedTrack>

/**
 * 取址结果。
 *
 * ⚠️ **`name`/`artist`/`album` 不可信，不要拿去覆盖 `Track` 上原有的值。**
 * 实测站点在某些 id 下存的元数据是串的：请求「想你就写信」那个 id，回来的 `id` 与请求
 * 完全一致，`name`/`player`/`album` 却是另一首完全无关的歌（音频文件本身是对的 ——
 * 体积、音质都对得上，是它那边曲库匹配错了）。覆盖的表现就是「点了 A，播放条显示 B」。
 * 用户点的是搜索结果里那一条，那条才是身份来源；这里只该采信**文件属性**。
 */
export interface ResolvedTrack {
  url: string
  format?: string
  sizeText?: string
  quality?: string
  cover?: string
  /** 歌词原文。经常是空的（见 Track.lrc） */
  lrc?: string
  /** 以下三项**仅供参考**，理由见上方注释 */
  name?: string
  artist?: string
  album?: string
}

/** 循环模式。`one` 单曲循环、`all` 列表循环、`off` 播完就停 */
export type RepeatMode = 'off' | 'all' | 'one'

/** 写进 localStorage 的那份状态。**注意这里没有 url**，理由见 Track.url */
export interface SavedMusicState {
  volume?: number
  muted?: boolean
  repeat?: RepeatMode
  shuffle?: boolean
  /** 队列里存的是去掉 url 的 Track（占位），下次打开靠 resolver 重新取址 */
  queue?: Track[]
  queueIndex?: number
}

/**
 * 播放失败的分类。文案要按类别分开写——
 * 「取不到地址」和「地址取到了但播不了」是两件完全不同的事，混成一句用户没法自救。
 */
export type MusicErrorKind =
  | 'resolve'    // 取址失败（没资源 / 被限流 / 网络）
  | 'network'    // 地址取到了，但音频拉不下来（多半是签名过期）
  | 'decode'     // 拉下来了但解不了（格式不支持 / 数据损坏）
  | 'aborted'    // 被新的加载请求打断，不是真错误

/** 去掉运行时字段，得到可安全持久化的那份 */
export function toStorableTrack(t: Track): Track {
  // url 必须剥掉：它 20 分钟就死，存下来只会让下次打开时静默失败
  const { url, ...rest } = t
  return rest
}
