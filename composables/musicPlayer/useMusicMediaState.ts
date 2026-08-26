/**
 * 播放器的「裸状态」：只有 ref，不含任何逻辑。
 *
 * 单独成模块是为了打断依赖环——引擎、队列、下载、装配层都要读写这批 ref，
 * 塞进其中任一个，其余几个就得反向依赖它（同 videoPlayer/useVideoMediaState 的理由）。
 */
import type { MusicErrorKind, RepeatMode, Track } from './types'

export function useMusicMediaState() {
  // ── DOM ──
  const audioEl = ref<HTMLAudioElement>()

  // ── 当前曲目 ──
  /** 正在播（或正准备播）的那首。null = 播放器还没被用过，底部播放条画成空态 */
  const current = ref<Track | null>(null)
  /**
   * 手粘直链的输入框。放裸状态里是因为「粘一条地址就能播」是播放器自带的能力，
   * 不属于任何数据源适配层 —— 这也是阶段 1 能独立验收的原因。
   */
  const urlInput = ref('')

  // ── 播放状态 ──
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref(1)
  const isMuted = ref(false)
  /**
   * 正在缓冲。判据是 `waiting`/`stalled` 起、`playing`/`canplay` 灭，
   * 但**必须有兜底熄灯**（见 useMusicEngine 的心跳）：正播着的音频不会再补发 `playing`，
   * 漏发一次转圈就一直盖着（video 那边踩过同样的坑）。
   */
  const isBuffering = ref(false)
  /** 正在取址（列表里是占位，正现取真实地址）。遮罩文案挂在它上面 */
  const isResolving = ref(false)
  /** 取址阶段文案，每秒刷新带秒数——不动的「正在获取…」看不出是在跑还是卡死了 */
  const resolveStage = ref('')

  // ── 错误 ──
  const errorMessage = ref('')
  /** 错误分类，决定界面给什么出路（换音源 / 重试 / 等一会儿） */
  const errorKind = ref<MusicErrorKind | ''>('')

  // ── 队列 ──
  const queue = ref<Track[]>([])
  const queueIndex = ref(-1)
  const repeat = ref<RepeatMode>('all')
  const shuffle = ref(false)

  // ── 进度条交互 ──
  /** 拖动中的预览位置（秒）。松手才真 seek —— 拖动过程中不断 seek 会把解码器打断成一片卡顿 */
  const seekPreview = ref<number | null>(null)
  const isSeeking = ref(false)

  // ── 界面开关 ──
  const showQueue = ref(false)
  const showDownloads = ref(false)
  const showFavorites = ref(false)
  const showLyrics = ref(false)
  /** 全屏沉浸模式（黑底大字歌词），独立于页面里那张歌词卡片的开关 */
  const showImmersive = ref(false)

  const progressPercent = computed(() =>
    duration.value ? Math.min(100, (currentTime.value / duration.value) * 100) : 0,
  )

  return {
    audioEl,
    current, urlInput,
    isPlaying, currentTime, duration, volume, isMuted, isBuffering, isResolving, resolveStage,
    errorMessage, errorKind,
    queue, queueIndex, repeat, shuffle,
    seekPreview, isSeeking,
    showQueue, showDownloads, showFavorites, showLyrics, showImmersive,
    progressPercent,
  }
}

export type MusicMediaState = ReturnType<typeof useMusicMediaState>
