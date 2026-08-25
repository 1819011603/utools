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
import { musicCacheKeyOf } from './useMusicAudioCache'

/** 取到地址后多久还没有任何数据就认为地址死了（签名过期最常见）。比 LOAD_TIMEOUT 早一档 */
const STALE_URL_TIMEOUT = 8000
/** 彻底放弃的时限。慢源确实要十几秒，但超过这个数多半是真的下不来 */
const LOAD_TIMEOUT = 20000
/** 被新的 load 打断后重试 play() 的间隔与次数（见 attemptPlay 的 AbortError 分支） */
const PLAY_RETRY_MS = 300
const PLAY_RETRY_MAX = 3

/**
 * 播够多少秒才值得把整首缓存下来。
 *
 * 翻列表试听是常态：点开三秒觉得不对就切下一首。那种情况下缓存整首等于白下几十 MB
 * （一首无损 20–110MB），既费用户流量也费我们的代理出口。
 * 熬过这十秒基本就是真在听了。
 */
const CACHE_AFTER_SECS = 10

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

  const cache = useMusicAudioCache()
  // 下载那半边用来把整首拉下来存缓存 —— 播放能直连但 fetch 不能（CORS 挡 Range），
  // 所以缓存必须走这条，不能拿播放的地址去 fetch（见 useMusicMediaUrl 的文件注释）
  const { toPlaybackUrl, demotePlayback, toDownloadUrl } = useMusicMediaUrl()

  /**
   * 缓存键要带音质档：同一首歌的两个档是**两个不同的文件**（体积差 5 倍），
   * 只按 track.key 存会让「点高清环绕声却放出无损那一份」。
   */
  const cacheKeyFor = (t: Track) =>
    musicCacheKeyOf(t.key, (t.locator as { preferred?: string } | undefined)?.preferred)

  /** 正在用的 blob URL。切歌要 revoke，否则几十 MB 一首地漏 */
  let objectUrl = ''
  /** 当前这首是从缓存放出来的（记缓存键）。心跳据此跳过"再存一遍" */
  let fromCacheKey = ''
  const releaseObjectUrl = () => {
    if (!objectUrl) return
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }

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
      /*
       * 只补**文件属性**，绝不覆盖曲名/歌手/专辑。
       *
       * 实测站点在某些 id 下存的元数据是串的：请求「想你就写信」那个 id，
       * 详情页回来的 `id` 与请求完全一致，`name`/`player`/`album` 却是另一首完全无关的歌
       * （音频文件本身是对的 —— 体积、音质都对得上，是它那边的曲库匹配错了）。
       *
       * 覆盖的话表现就是「点了 A，播放条显示 B」，用户会以为我们把列表搞乱了。
       * 用户点的是搜索结果里那一条，那条才是他要的身份；详情页只负责给地址和文件属性。
       */
      Object.assign(track, {
        url: r.url,
        format: r.format ?? track.format,
        sizeText: r.sizeText ?? track.sizeText,
        quality: r.quality ?? track.quality,
        cover: r.cover ?? track.cover,
        lrc: r.lrc ?? track.lrc,
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

    releaseObjectUrl()

    /*
     * 先查本地缓存 —— 命中的话**连取址都不用发**。
     * 这是整个缓存功能最主要的收益：站点按天按 IP 限配额，而循环播放、重听、
     * 从收藏里再点开都是常态，每一次都去要一条 20 分钟就过期的新地址纯属浪费额度。
     *
     * 只查有 resolver 的（站点解析来的）：手粘直链本来就没有配额问题，
     * 而且用户可能粘一个巨大的文件，没理由替他缓存。
     */
    let url = ''
    let fromCache = false
    fromCacheKey = ''
    cachedFor = ''
    if (track.resolver) {
      const key = cacheKeyFor(track)
      const blob = await cache.getCached(key)
      if (blob && seq === loadSeq) {
        objectUrl = URL.createObjectURL(blob)
        url = objectUrl
        fromCache = true
        fromCacheKey = key
        console.log(`[music] 命中缓存《${track.name}》，未发任何请求`)
      }
    }
    if (seq !== loadSeq) return

    if (!url) {
      try {
        // 播放走 toPlaybackUrl：<audio> 不受 CORS 约束，绝大多数 CDN 直连就能播，
        // 没理由让几十上百 MB 白绕我们的出口
        url = toPlaybackUrl(await resolveUrl(track))
      } catch (e: any) {
        if (seq !== loadSeq) return
        // 文案**不能写死「没有资源」**：实测站点配额耗尽时照常回 200、只是不给地址，
        // 与「这首真没资源」在响应上完全无法区分，说死了就是在冤枉站点、也误导用户
        fail('resolve', e?.message || '暂时取不到播放地址（可能没有资源，也可能是站点限流）')
        return
      }
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

    /*
     * 两档闹钟：早的那档静默重取（它**必然误伤**慢源，不该弹任何提示），晚的那档才报错。
     * **缓存命中时一档都不挂**：blob URL 是本地数据，不存在"地址过期"或"源站慢"，
     * 挂着只会在某些慢解码的机器上误触发一次毫无意义的重新取址（还白烧一份配额）。
     */
    if (!fromCache) {
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
    }

    if (opts.autoplay !== false) void attemptPlay(seq)
  }

  // ── 后台缓存 ──

  /** 这一轮已经安排过缓存了，别在心跳里反复触发 */
  let cachedFor = ''

  /**
   * 把整首拉下来存本地。**与播放并行、不阻塞起播**（方案 A）：
   * `<audio>` 那边直连秒开，这边悄悄下一份，用户下次重听/循环就零请求。
   *
   * 走 `toDownloadUrl` 而不是播放那条地址：播放能直连是因为 `<audio>` 不受 CORS 约束，
   * 而这里是 `fetch`，跨域拿不到（`Range` 触发预检、CDN 不放行）——拿播放地址来 fetch 必失败。
   */
  const cacheInBackground = async (track: Track) => {
    if (!track.resolver || !track.url) return
    const key = cacheKeyFor(track)
    if (await cache.hasCached(key)) return

    try {
      const src = await toDownloadUrl(track.url)
      const res = await fetch(src, { referrerPolicy: 'no-referrer' })
      if (!res.ok) return
      const blob = await res.blob()
      // 全或无：交给 putCached 用 expectedBytes 核对，对不上一个字节都不写
      const expected = Number(res.headers.get('content-length')) || 0
      const ok = await cache.putCached(key, blob, {
        trackKey: track.key,
        expectedBytes: expected || undefined,
        format: track.format,
      })
      if (ok) console.log(`[music] 已缓存《${track.name}》${(blob.size / 1048576).toFixed(1)}MB`)
    } catch {
      // 缓存是锦上添花，失败一声不吭 —— 用户正在听歌，不该为这个弹任何东西
    }
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

    /*
     * 没有源就一定不在缓冲。**这是道自愈闸**：`isBuffering` 只由 `playing`/`canplay` 熄，
     * 而一个没有 src 的元素永远等不到这两个事件 —— 只要有任何一条路径把它误置位
     * （比如空元素上触发的 `waiting`），转圈就再也下不去了。
     * 靠事件兜不住的状态，就得靠心跳拿地面真值去纠正。
     */
    if (!el.currentSrc && !el.src) {
      isBuffering.value = false
      return
    }

    if (!el.paused && el.currentTime > lastTick) isBuffering.value = false
    lastTick = el.currentTime

    /*
     * 播够十秒才把整首存下来。翻列表试听是常态（点开三秒觉得不对就切），
     * 那种情况下缓存整首等于白下几十 MB。熬过十秒基本就是真在听了。
     *
     * 判据用 `currentTime` 而不是"播了多久"：拖到中段听十秒也算真在听。
     */
    const t = current.value
    if (!t || fromCacheKey === cacheKeyFor(t)) return          // 本来就是从缓存放的，别再存一遍
    if (el.currentTime < CACHE_AFTER_SECS) return
    if (cachedFor === t.key) return
    cachedFor = t.key
    void cacheInBackground(t)
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
    // blob URL 不 revoke 的话，一首无损就是几十 MB 挂在内存里出不去
    releaseObjectUrl()
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
    const track = current.value
    if (!el || !track) return

    /*
     * **刷新后的第一次点击必须走完整装载，不能直接 play()。**
     *
     * 持久化时地址是被刻意剥掉的（它约 20 分钟就过期，存下来必是死链），
     * 所以恢复出来的当前曲目只是个占位、`<audio>` 上压根没有 src。
     * 对着没有源的元素调 `play()` 既不报错也播不动，只会停在 `waiting` ——
     * 表现就是「刚进来点播放，一直转圈」（用户实测到的正是这个）。
     */
    if (!el.currentSrc && !el.src) {
      void load(track, { autoplay: true })
      return
    }

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
