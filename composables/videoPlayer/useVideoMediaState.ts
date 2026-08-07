/**
 * 播放器的「裸状态」：只有 ref 和纯展示常量，不含任何逻辑。
 *
 * 单独成模块是为了打断依赖环——引擎、交互控制、连接策略、持久化四个模块都要读写这批 ref，
 * 若把它们塞进其中任一模块，其余三个就得反向依赖它。
 */
import type { HlsTuning } from './types'
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
  const showControls = ref(true)
  const showPlayIcon = ref(false)
  const showSpeedMenu = ref(false)
  const showAdvancedProxy = ref(false)  // 展开手动连接设置（默认隐藏，全自动）
  const autoFullscreen = ref(true)
  // 锁定屏幕：屏蔽手势、控制栏与快捷键（横屏握持时误触太容易）。
  // 放在裸状态里而不是手势模块内，是因为快捷键在 controls 里，而 controls 是手势层的**下游**——
  // 反过来 import 就成环了。
  const isLocked = ref(false)
  const autoBestRate = ref(true)        // 自动最佳倍速：在 [1, 所选倍速] 内按带宽自动取值

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

  // ── MP4 预加载 ──
  // 类型对齐 <video>.preload，免得赋值时要 as 一下
  const preloadStrategy = ref<'none' | 'metadata' | 'auto'>('auto')

  return {
    videoUrl, videoUrlInput, isVideoLoaded, isHls, errorMessage, isLoading, isBuffering, isResolvingUrl, resolveStage,
    videoEl, playerContainer, progressBar, speedMenuRef,
    isPlaying, currentTime, duration, volume, isMuted, playbackRate, desiredRate, videoKey,
    isFullscreen, showControls, showPlayIcon, showSpeedMenu, showAdvancedProxy, autoFullscreen, autoBestRate, isLocked,
    progressPercent, bufferedPercent, seekPreviewTime, seekPreviewPercent, isSeeking, hoverTime, hoverPercent,
    skipIntro, skipOutro, hasSkippedIntro, savedProgress, isRestoringFromSaved,
    hlsConfig, hlsStats, playbackDiag,
    preloadStrategy,
  }
}

export type VideoMediaState = ReturnType<typeof useVideoMediaState>
