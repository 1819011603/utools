/**
 * `<audio>` 生命周期：装载一首曲子、绑事件、处理加载超时与地址过期。
 *
 * 比视频那套简单一个量级——没有 HLS、没有代理、没有可达性探测：
 * 实测 24bit 的两个 CDN（酷我 / 网易云）都是 `ACAO: *` + 允许 `Range` + 不校验 Referer，
 * 浏览器直连即可。**别照搬 videoPlayer 的连接策略**，那套在这里纯属白绕一跳还吃出口流量。
 *
 * 依赖方向单向：engine → mediaState。需要「播下一首」这类上层能力时一律走 deps 回调，
 * 反向 import 会立刻循环依赖。
 */
import type { MusicMediaState } from './useMusicMediaState'
import type { ResolvedTrack, Track } from './types'

/** 取到地址后多久还没有任何数据就认为地址死了（签名过期最常见）。比 LOAD_TIMEOUT 早一档 */
const STALE_URL_TIMEOUT = 8000
/** 彻底放弃的时限。慢源确实要十几秒，但超过这个数多半是真的下不来 */
const LOAD_TIMEOUT = 20000
/** 被新的 load 打断后重试 play() 的间隔与次数（见 attemptPlay 的 AbortError 分支） */
const PLAY_RETRY_MS = 300
const PLAY_RETRY_MAX = 3

export interface MusicEngineDeps {
  /** 取址。留空表示这个播放器实例只播直链（阶段 1 就是这样） */
  resolve?: (track: Track) => Promise<ResolvedTrack>
  /** 一首播完了。由队列模块决定放哪一首（循环模式、随机都在那边判） */
  onEnded?: () => void
}

export function useMusicEngine(media: MusicMediaState, deps: MusicEngineDeps = {}) {
  const {
    audioEl, current, isPlaying, currentTime, duration, volume, isMuted,
    isBuffering, isResolving, resolveStage, errorMessage, errorKind, isSeeking,
  } = media

  /** 本轮加载的序号。切歌很快时旧的那轮回来要能认出自己已经过时，否则会把新曲目的状态覆盖掉 */
  let loadSeq = 0
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let hardTimer: ReturnType<typeof setTimeout> | null = null
  let resolveTicker: ReturnType<typeof setInterval> | null = null
  /**
   * 这一首已经硬重取过一次了。
   * **每首只重取一次**：地址真过期和站点真限流表现完全一样（都是取不到），
   * 反复取只会「取址 → 失败 → 再取址」原地打转（同 video-parse 的 `refetchedFor`）。
   */
  let refetchedFor = ''

  const clearTimers = () => {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null }
  }

  const stopResolveTicker = () => {
    if (resolveTicker) { clearInterval(resolveTicker); resolveTicker = null }
    resolveStage.value = ''
  }

  const fail = (kind: typeof errorKind.value, msg: string) => {
    errorKind.value = kind
    errorMessage.value = msg
    isBuffering.value = false
    isResolving.value = false
    stopResolveTicker()
    clearTimers()
  }

  /**
   * 起播。**失败要分两类**，混为一谈会让「自动播下一首」停在暂停态：
   *   · `NotAllowedError` = 被自动播放策略拦了 → 静音重播一次（静音播放任何时候都允许），
   *     宁可先出声轨也别停住，声音等用户下次触碰时恢复；
   *   · 其余（**主要是 `AbortError`**）= 这一发 play() 被新的 load 打断，跟权限毫无关系，
   *     隔一会儿重试即可。早先一律按「被拦」处理，表现是自动切歌后停在暂停（video 那边踩过）。
   */
  const attemptPlay = async (seq: number, tries = 0) => {
    const el = audioEl.value
    if (!el || seq !== loadSeq) return
    try {
      await el.play()
    } catch (e: any) {
      if (seq !== loadSeq) return
      if (e?.name === 'NotAllowedError') {
        el.muted = true
        isMuted.value = true
        try { await el.play() } catch { /* 静音也播不了就交给用户点一下 */ }
        return
      }
      if (tries < PLAY_RETRY_MAX) {
        setTimeout(() => void attemptPlay(seq, tries + 1), PLAY_RETRY_MS)
      }
    }
  }

  /** 取址：带阶段文案（每秒刷新秒数——不动的提示看不出是在跑还是卡死了） */
  const resolveUrl = async (track: Track): Promise<string> => {
    if (track.url) return track.url
    if (!deps.resolve) throw new Error('这条曲目没有播放地址')

    isResolving.value = true
    const startedAt = Date.now()
    resolveStage.value = '正在获取播放地址…'
    stopResolveTicker()
    resolveTicker = setInterval(() => {
      resolveStage.value = `正在获取播放地址…（${Math.round((Date.now() - startedAt) / 1000)}s）`
    }, 1000)

    try {
      const r = await deps.resolve(track)
      // 站点顺手给回的元数据通常比搜索结果更准（真封面、体积、格式），就地补上
      Object.assign(track, {
        url: r.url,
        format: r.format ?? track.format,
        sizeText: r.sizeText ?? track.sizeText,
        quality: r.quality ?? track.quality,
        cover: r.cover ?? track.cover,
        name: r.name ?? track.name,
        artist: r.artist ?? track.artist,
        album: r.album ?? track.album,
      })
      return r.url
    } finally {
      isResolving.value = false
      stopResolveTicker()
    }
  }

  /**
   * 地址可能死了 → 重取一次再放弃。
   * 地址过期比什么都常见（24bit 的签名约 20 分钟），直接报错等于把唯一一条活路堵死。
   */
  const refetchAndReload = async (reason: string) => {
    const track = current.value
    if (!track?.resolver || !deps.resolve) return false
    if (refetchedFor === track.key) return false
    refetchedFor = track.key
    console.log(`[music] ${reason} → 重新取址：${track.name}`)
    // 作废旧地址，否则 resolveUrl 会直接把它原样返回
    track.url = undefined
    try {
      await load(track, { autoplay: true, isRefetch: true })
      return true
    } catch {
      return false
    }
  }

  /** 装载一首曲子。切歌一律走这里 */
  const load = async (track: Track, opts: { autoplay?: boolean; isRefetch?: boolean } = {}) => {
    const seq = ++loadSeq
    clearTimers()
    if (!opts.isRefetch) refetchedFor = ''
    errorMessage.value = ''
    errorKind.value = ''
    current.value = track
    currentTime.value = 0
    duration.value = 0
    isBuffering.value = true

    let url: string
    try {
      url = await resolveUrl(track)
    } catch (e: any) {
      if (seq !== loadSeq) return
      // 文案**不能写死「没有资源」**：实测站点限流时照常回 200、只是不给地址，
      // 与「这首真没资源」在响应上完全无法区分，说死了就是在冤枉站点、也误导用户
      fail('resolve', e?.message || '暂时取不到播放地址（可能没有资源，也可能是站点限流）')
      return
    }
    if (seq !== loadSeq) return

    const el = audioEl.value
    if (!el) { fail('network', '播放器还没准备好'); return }

    // 先清干净再设新地址：残留的 src 会让元素先对旧地址再发一次请求
    el.removeAttribute('src')
    el.load()
    el.src = url
    el.volume = volume.value
    el.muted = isMuted.value
    el.load()

    // 两档闹钟：早的那档静默重取（它**必然误伤**慢源，不该弹任何提示），晚的那档才报错
    staleTimer = setTimeout(() => {
      if (seq !== loadSeq) return
      if ((el.buffered?.length ?? 0) > 0) return   // 已经有数据了，只是慢
      void refetchAndReload('加载 8s 无数据')
    }, STALE_URL_TIMEOUT)

    hardTimer = setTimeout(() => {
      if (seq !== loadSeq) return
      if ((el.buffered?.length ?? 0) > 0) return
      fail('network', '加载超时，音频地址可能已失效')
    }, LOAD_TIMEOUT)

    if (opts.autoplay !== false) void attemptPlay(seq)
  }

  // ── 事件 ──

  const onLoadedMetadata = () => {
    const el = audioEl.value
    if (!el) return
    duration.value = isFinite(el.duration) ? el.duration : 0
    if (current.value) current.value.duration = duration.value
  }

  const onTimeUpdate = () => {
    const el = audioEl.value
    // 拖动中不跟着走：否则手指还按着，进度条就被 timeupdate 拽回去了
    if (!el || isSeeking.value) return
    currentTime.value = el.currentTime
  }

  const onPlaying = () => { isPlaying.value = true; isBuffering.value = false; clearTimers() }
  const onPause = () => { isPlaying.value = false }
  const onWaiting = () => { isBuffering.value = true }
  const onCanPlay = () => { isBuffering.value = false }

  const onEnded = () => {
    isPlaying.value = false
    deps.onEnded?.()
  }

  /**
   * `<audio>` 报错。**先重取再报错**——地址过期是这里最常见的原因，
   * 而重取一次就能救回来（同 video-player 的 `recoverFromNetworkFailure` 那条顺序）。
   */
  const onError = () => {
    const el = audioEl.value
    const code = el?.error?.code
    // MEDIA_ERR_NETWORK(2) / MEDIA_ERR_SRC_NOT_SUPPORTED(4) 都可能是签名过期导致的 403
    if (code === 2 || code === 4) {
      void refetchAndReload(`audio error code=${code}`).then(ok => {
        if (ok) return
        fail(
          code === 2 ? 'network' : 'decode',
          code === 2
            ? '音频拉取失败，地址可能已失效——换个音源或重新搜索试试'
            : '这个地址取回的不是可播放的音频',
        )
      })
      return
    }
    fail('decode', '音频解码失败')
  }

  /**
   * 每秒心跳：**兜底熄灯**。
   * `isBuffering` 只由 `playing`/`canplay` 熄，而正播着的音频不会再补发 `playing`——
   * 漏发一次转圈就一直盖在正常播放的界面上（video 那边踩过，这里同理）。
   * 拿「播放头真的在往前走」当地面真值，比任何事件都可信。
   */
  let lastTick = 0
  const tick = () => {
    const el = audioEl.value
    if (!el) return
    if (!el.paused && el.currentTime > lastTick) isBuffering.value = false
    lastTick = el.currentTime
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null

  const bind = () => {
    const el = audioEl.value
    if (!el) return
    el.addEventListener('loadedmetadata', onLoadedMetadata)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('play', onPlaying)
    el.addEventListener('pause', onPause)
    el.addEventListener('waiting', onWaiting)
    el.addEventListener('stalled', onWaiting)
    el.addEventListener('canplay', onCanPlay)
    el.addEventListener('ended', onEnded)
    el.addEventListener('error', onError)
    heartbeat = setInterval(tick, 1000)
  }

  const unbind = () => {
    const el = audioEl.value
    clearTimers()
    stopResolveTicker()
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    if (!el) return
    el.removeEventListener('loadedmetadata', onLoadedMetadata)
    el.removeEventListener('timeupdate', onTimeUpdate)
    el.removeEventListener('playing', onPlaying)
    el.removeEventListener('play', onPlaying)
    el.removeEventListener('pause', onPause)
    el.removeEventListener('waiting', onWaiting)
    el.removeEventListener('stalled', onWaiting)
    el.removeEventListener('canplay', onCanPlay)
    el.removeEventListener('ended', onEnded)
    el.removeEventListener('error', onError)
  }

  // ── 对外的控制动作 ──

  const togglePlay = () => {
    const el = audioEl.value
    if (!el || !current.value) return
    if (el.paused) void attemptPlay(loadSeq)
    else el.pause()
  }

  const seekTo = (sec: number) => {
    const el = audioEl.value
    if (!el || !isFinite(sec)) return
    el.currentTime = Math.max(0, Math.min(sec, duration.value || sec))
    currentTime.value = el.currentTime
  }

  const setVolume = (v: number) => {
    const nv = Math.max(0, Math.min(1, v))
    volume.value = nv
    if (audioEl.value) audioEl.value.volume = nv
    // 调音量意味着用户想听见 —— 顺手解掉「被策略拦下后自动静音」那一档
    if (nv > 0 && isMuted.value) setMuted(false)
  }

  const setMuted = (m: boolean) => {
    isMuted.value = m
    if (audioEl.value) audioEl.value.muted = m
  }

  const toggleMuted = () => setMuted(!isMuted.value)

  return { load, bind, unbind, togglePlay, seekTo, setVolume, setMuted, toggleMuted, attemptPlay }
}

export type MusicEngine = ReturnType<typeof useMusicEngine>
