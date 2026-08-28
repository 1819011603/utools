/**
 * 播放器的「裸状态」：只有 ref 和纯展示常量，不含任何逻辑。
 *
 * 单独成模块是为了打断依赖环——引擎、交互控制、连接策略、持久化四个模块都要读写这批 ref，
 * 若把它们塞进其中任一模块，其余三个就得反向依赖它。
 */
import type { HlsTuning, VideoFitMode } from './types'
import { DEFAULT_HLS_TUNING } from './types'

export function useVideoMediaState() {
  // ── 视频源 ──
  const videoUrl = ref('')
  const videoUrlInput = ref('')      // 多行输入
  const isVideoLoaded = ref(false)
  const isHls = ref(false)
  const errorMessage = ref('')
  const isLoading = ref(false)
  const isBuffering = ref(false)
  const isResolvingUrl = ref(false)  // 按需取址中（列表里是占位地址，正在现取真实地址）
  // 解析播放列表的阶段文案（「正在计算站点校验…」这类）。
  // 走 ?parseUrl= 进来时整份列表要现场解析，慢的站点要好几秒，而那时 Stage 还没渲染
  // （它 v-if="isVideoLoaded"），遮罩上的提示一个字都看不到，页面就是空的
  const resolveStage = ref('')

  // ── DOM 引用 ──
  const videoEl = ref<HTMLVideoElement>()
  const playerContainer = ref<HTMLDivElement>()
  const progressBar = ref<HTMLDivElement>()
  const speedMenuRef = ref<HTMLElement>()

  // ── 播放状态 ──
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(1)
  const isMuted = ref(false)
  const playbackRate = ref(1)   // 实际生效倍速（自动最佳倍速时可能被下调）
  const desiredRate = ref(1)    // 用户选择的目标倍速（上限），自动模式在 [1, desiredRate] 内取值
  const videoKey = ref(0)       // 自增以强制重新创建 video 元素，彻底重置状态

  // ── 界面开关 ──
  const isFullscreen = ref(false)
  const showControls = ref(false)
  const showPlayIcon = ref(false)
  const showSpeedMenu = ref(false)
  const showEpisodes = ref(false)
  /** 画面内的右侧设置抽屉（版式参照安卓客户端的「播放设置」） */
  const showSettings = ref(false)
  /** 画面内的换源面板（线路表来自最近一次解析） */
  const showLines = ref(false)
  const showAdvancedProxy = ref(false)
  const autoFullscreen = ref(true)
  // 手机浏览器要求用户激活才准进全屏，页面加载后自动调必被拒 → 挂起，等用户碰画面再兑现
  const pendingAutoFullscreen = ref(false)
  // 自动播放被拦下后改用静音起播，用户下一次触碰即解除
  const autoMuted = ref(false)
  // 锁定屏幕。放裸状态里是因为快捷键在 controls 里，而 controls 是手势层的**下游**，反向 import 成环
  const isLocked = ref(false)
  /** 锁定态下点一下画面让解锁键露几秒。与 isLocked 同理放这儿：controls 也要能把它压下去 */
  const showLockBtn = ref(false)
  const autoBestRate = ref(true)
  const turboRate = ref(false)
  /**
   * 后台播放：切到别的应用/标签页时不主动暂停，还要把浏览器替我们按下的那一发抢回来。
   *
   * 默认关。开着必然更费电更费流量（画面停了但分片照下），而多数人切走就是不想看了。
   */
  const bgPlay = ref(false)

  // ── 画面与解码 ──
  /** 画面尺寸：默认（等比）/ 填充 / 拉伸 / 强制 16:9 / 强制 4:3 */
  const fitMode = ref<VideoFitMode>('default')
  /**
   * 硬件解码。**浏览器不提供关掉硬解的开关**（那是 Chrome 启动参数级别的事），
   * 所以关掉它的实际含义是「只挑 H.264 / SDR 的档」——真正会让弱解码器音画不同步、
   * 拖不动进度的是 HEVC 和 HDR 那几档。默认开。
   */
  const hwDecode = ref(true)
  /** 长按加速的倍数（安卓客户端里也是可调的） */
  const boostRatePref = ref(2)
  /** 画面亮度（CSS filter，改不了背光但暗环境够用）。竖滑手势与设置面板共用 */
  const brightness = ref(1)

  // ── 进度条 ──
  const progressPercent = computed(() => duration.value ? (currentTime.value / duration.value) * 100 : 0)
  const bufferedPercent = ref(0)
  const seekPreviewTime = ref<number | null>(null)
  const seekPreviewPercent = ref(0)
  const isSeeking = ref(false)
  const hoverTime = ref<number | null>(null)
  const hoverPercent = ref(0)

  // ── 片头片尾 / 进度记忆 ──
  const skipIntro = ref(0)
  const skipOutro = ref(0)
  const hasSkippedIntro = ref(false)
  const savedProgress = ref<Record<string, number>>({})
  // MP4 等原生视频没有 MANIFEST_PARSED，恢复进度后要靠 canplay 触发自动播放
  const isRestoringFromSaved = ref(false)

  // ── HLS ──
  const hlsConfig = ref<HlsTuning>({ ...DEFAULT_HLS_TUNING })
  // dropped/total：解码渲染侧的掉帧。与 buffered（网络侧）分属两条完全不同的瓶颈，
  // 面板上要能一眼分开——「缓冲满但掉帧涨」是解码/GPU 问题，「缓冲空但不掉帧」才是网络问题
  const hlsStats = ref<{ buffered: number; level: string; dropped: number; total: number } | null>(null)
  const playbackDiag = ref('—')
  /**
   * `<video>` 解码后的实际像素高度（如 `"720p"`）。清单/master 列表声明的分辨率不总是准
   * （实测过某源清单写 608，ffprobe 解密真实分片一看编码其实是 720），解码尺寸才是唯一可信的数，
   * 所以单独存一份裸状态，不跟 hlsStats.level 混在一起——各展示位置按各自优先级去用
   */
  const decodedRes = ref('')

  // ── MP4 预加载 ──
  // 类型对齐 <video>.preload，免得赋值时要 as 一下
  const preloadStrategy = ref<'none' | 'metadata' | 'auto'>('auto')
  /**
   * 我们自己从 `moov/mvhd` 里读出来的整片 MP4 时长（秒）。0 = 没读到。
   * 安卓 Chrome 在这类文件上读不出总时长（进度条因此拖不动），而时长本来就在文件里，
   * 所以自己读一份兜底。见 engine/mp4Duration.ts
   */
  const mp4ProbedDuration = ref(0)
  /** 整片 MP4 的平均码率（Mbps）= mdat 字节 ÷ 时长。速度徽标的分母靠它 */
  const mp4AvgMbps = ref(0)
  /**
   * 整片 MP4 的实测下载速率（KB/s）。
   * 原生播放的请求是浏览器自己发的、`fetch` 拿不到，所以按
   * 「已缓冲末尾每秒往前走了几秒 × 平均字节率」估——误差只来自码率不均匀，判读够用。
   */
  const mp4Kbps = ref(0)

  return {
    videoUrl, videoUrlInput, isVideoLoaded, isHls, errorMessage, isLoading, isBuffering, isResolvingUrl, resolveStage,
    videoEl, playerContainer, progressBar, speedMenuRef,
    isPlaying, currentTime, duration, volume, isMuted, playbackRate, desiredRate, videoKey,
    isFullscreen, showControls, showPlayIcon, showSpeedMenu, showEpisodes, showSettings, showLines,
    showAdvancedProxy, autoFullscreen, pendingAutoFullscreen, autoMuted, autoBestRate, turboRate, bgPlay,
    isLocked, showLockBtn, fitMode, hwDecode, boostRatePref, brightness,
    progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, isSeeking, hoverTime, hoverPercent,
    skipIntro, skipOutro, hasSkippedIntro, savedProgress, isRestoringFromSaved,
    hlsConfig, hlsStats, playbackDiag, decodedRes,
    preloadStrategy, mp4ProbedDuration, mp4AvgMbps, mp4Kbps,
  }
}

export type VideoMediaState = ReturnType<typeof useVideoMediaState>
