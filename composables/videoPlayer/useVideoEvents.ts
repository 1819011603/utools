/**
 * `<video>` 元素的事件处理 + 起播预缓冲。
 *
 * 单独成模块的理由：这些回调只被模板绑定，彼此之间几乎不共享私有状态，
 * 但每一个都要横跨 media/engine/playlist 三个模块，塞在引擎里会让引擎既管加载又管播放反馈。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoEngine } from './useVideoEngine'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'

/**
 * 起播预缓冲：缓冲够了就起播，剩下的交给并行预取在播放中补齐；
 * 慢站最多等 AUTOPLAY_MAX_WAIT_MS 兜底避免卡死。非 HLS 固定等 2s。
 *
 * **`PLAYABLE_SECS` 是这一块唯一的秒数常量，单位是「能播多少秒」不是「缓冲多少秒」**
 * ——两者差一个倍速，所以用它的地方一律 × 倍速。3x 下缓冲 6 秒只够播 2 秒；
 * 拿固定秒数当门槛等于高倍速下过早起播（马上再卡）、1x 下过晚起播（干等）。
 *
 * 起播门槛的两档只差一个倍数：
 * · 定位类起播（切集 / 拖进度 / 重载）—— 画面停着，每多一秒都在盯转圈 → 够播 2 秒就走，
 *   后面由预取追；真追不上还有抗卡环兜。
 * · 首次冷启动（刚点开页面，人还在看别的）—— 多等一会儿攒厚一点划算 → 翻倍，够播 4 秒。
 *
 * 实测这两档配合「存货不够就少开线程」（见 useHlsPrefetch 的 SAFE_WALL_SECS）才有意义：
 * 不收窄并发的话，门槛要的这点量本身就被 6~12 条并行下载拖慢了。
 */
const PLAYABLE_SECS = 2               // 「够播几秒」：起播门槛与卡顿归零窗口共用
const AUTOPLAY_MAX_WAIT_MS = 8000

/**
 * 卡一次，下一次起播的门槛就翻一倍（封顶 ×8）。
 *
 * 治的是**慢源上「多次短频卡顿」**——尤其拖完进度那一下：缓冲清零后按「够播 2 秒」就出画面，
 * 而慢源两秒后供给还没跟上，于是又卡；浏览器只要拿到一帧就继续播，于是卡→播→卡→播 抖成锯齿。
 * 用户感受上，**五次一秒的卡远比一次四秒的等难受**（每一次都要重新对焦画面和声音）。
 *
 * 所以门槛不是常量而是「这条源最近有多不争气」的函数：连着卡就多攒一点再出画面，
 * 连续流畅一段时间后自动归零（见 recentStalls）。翻倍而不是线性加：
 * 真慢的源线性爬要卡七八次才够，指数两三次就到位。
 */
const STALL_ESCALATION_CAP = 8
/**
 * 门槛归零要的「连续流畅」墙钟秒数，同样是 `PLAYABLE_SECS` × 倍速（`smoothSecs` 是墙钟）：
 * 1x 要顺畅播过 2 秒，3x 要 6 秒。倍速越高，源要供上的吞吐越高、缓冲消耗得越快，
 * **「刚好喘匀这几秒」的偶然性越大，免罪就该越难拿**。
 *
 * **原来是固定 20s，太长了**：断网 / 换 Wi-Fi 必然制造卡顿，而那些卡顿**不是这条源不争气**，
 * 却一样把门槛翻上去。于是网络一恢复，`onWaiting` 就主动 pause 去攒 `2^stalls` 的门槛
 * ——1x 下 stalls=2 就是 24s，实际必然吃满 `AUTOPLAY_MAX_WAIT_MS` 的 8s 封顶。
 * 也就是说**网络早通了，画面还要再等 8 秒**，而 20s 的下坡路让这个惩罚在整段恢复期里一直挂着。
 *
 * 倍速夹在 1~3x：慢放不缩短（0.5x 本来就不卡，没理由更容易免罪），超快倍速（3.5~5x）不加码
 * ——那一档本来就必卡（多数浏览器 4x 往上还直接静音），让它把归零线拉到 10s 只是把
 * 「网络早通了还在等」重演一遍，而那正是这条归零线存在的理由。
 */
const stallDecaySmoothSecs = (rate: number) =>
  PLAYABLE_SECS * Math.min(3, Math.max(1, rate))

/** 起播门槛（秒缓冲）。relocating = 切集/拖进度/重载那一档；stalls = 近期卡顿次数 */
const autoPlayTarget = (rate: number, relocating: boolean, stalls = 0): number => {
  const byRate = PLAYABLE_SECS * Math.max(1, rate)
  const base = relocating ? byRate : byRate * 2   // 冷启动攒厚一倍
  return base * Math.min(STALL_ESCALATION_CAP, 2 ** Math.max(0, stalls))
}
/**
 * 起播就绪的轮询间隔。原来是 300ms 固定轮询 + 起手先空等 500ms——
 * 那 500ms 是纯自造延迟（每次切集都赔一次），而 300ms 的粒度意味着「其实早就够了」
 * 还要再等最多 300ms。现在立刻跑第一拍，之后 100ms 一拍。
 * 每一拍只读 `video.buffered`（不发请求、不遍历分片表），加密到 100ms 也可忽略。
 */
const AUTOPLAY_POLL_MS = 100

export interface VideoEventsDeps {
  media: VideoMediaState
  engine: VideoEngine
  conn: VideoConnStrategy
  playlist: VideoPlaylistCtl
}

export function useVideoEvents(deps: VideoEventsDeps) {
  const { media, engine, conn, playlist } = deps
  const {
    videoEl, playerContainer, isHls, isPlaying, isBuffering, isLoading, isVideoLoaded,
    currentTime, duration, bufferedPercent, volume, isMuted, playbackRate,
    skipIntro, skipOutro, hasSkippedIntro, autoFullscreen, errorMessage,
    hlsStats, decodedRes,
  } = media

  /**
   * 清晰度徽标要的解码实测尺寸。**只在这里更新，别处不要各写一份**：
   * `loadedmetadata` 起播/切集各来一次，`resize`（原生事件，videoWidth/videoHeight 变化时触发）
   * 补 ABR 切档那种画面中途变尺寸的情况——两个事件都落在这一个函数上，才不会出现
   * 「只在起播那一刻测了一次，切档之后没跟上」的漂移
   */
  const syncDecodedRes = () => {
    const v = videoEl.value
    if (v?.videoWidth && v?.videoHeight) decodedRes.value = `${v.videoHeight}p`
  }
  const onVideoResize = () => syncDecodedRes()

  /**
   * 清晰度徽标：解码实测优先，清单/master 列表声明的档只在解码还没出结果时先顶个位——
   * 声明值不总是准（见 decodedRes 上那条注释），解码一有结果立刻让位。
   * 播放器信息条和全屏顶栏共用这一个值，不各写一份。
   */
  const videoRes = computed(() => {
    if (decodedRes.value) return decodedRes.value
    const declared = isHls.value ? hlsStats.value?.level : ''
    return declared && declared !== '自动' ? declared : ''
  })

  let isFirstLoad = true
  let outroFired = false   // 本集是否已触发过「跳过片尾」（每次 loadedmetadata 复位）
  let progressSaveTimer: ReturnType<typeof setTimeout> | null = null
  let delayedPlayTimer: ReturnType<typeof setTimeout> | null = null
  let seekBufferingTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 起播这一发 play()。失败分两类，处理完全不同——早先一律按「被浏览器拦了」处理，
   * 于是自动跳集时表现成「跳过去了但停在暂停，还得自己点一下」：
   *
   * · `NotAllowedError` = 真的被自动播放策略拦了（安卓上「点选集 → 几秒后才 play()」，
   *   用户手势的有效期早过了）。改静音重播一次——宁可先出画面，声音等用户下次触碰时恢复
   *  （`useVideoUiControls.restoreSound`，任何点按都解除）。
   * · 其余（**主要是 `AbortError`**）= 这一发被新的 load 请求打断了。切集时 `videoKey++` 重建
   *   `<video>`、hls.js 紧接着 attach + startLoad，play() 撞上去就是这个。它跟权限毫无关系，
   *   静音重播照样会被打断，然后旧代码就彻底放弃了。这种只需要过一会儿再试。
   */
  const attemptPlay = async (tries: number): Promise<void> => {
    const video = videoEl.value
    if (!video) return
    try {
      await video.play()
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        if (media.autoMuted.value) {                  // 静音也不行 = 真没辙，把静音还回去
          console.log('自动播放被阻止（静音也不行）:', e.message)
          video.muted = isMuted.value = media.autoMuted.value = false
          return
        }
        video.muted = true
        media.autoMuted.value = true
        isMuted.value = true
        return await attemptPlay(tries)
      }
      if (tries >= 3) {
        console.log('自动播放放弃（重试 3 次仍被打断）:', e?.name, e?.message)
        return
      }
      console.log(`自动播放被打断（${e?.name}），400ms 后重试`)
      await new Promise(r => setTimeout(r, 400))
      return await attemptPlay(tries + 1)
    }
  }

  // ── 起播预缓冲 ──
  /**
   * 近期卡顿次数（供门槛递增用）。**连续流畅够 `stallDecaySmoothSecs()` 秒就清零**——门槛涨上去容易，
   * 不给它一条下坡路的话，源恢复正常之后每次拖进度还得干等十几秒（比卡顿更烦）。
   * 计数只认 stallTracker 的真实停顿（排除 seek 与用户 pause），不认我们自己的加载等待。
   */
  let recentStalls = 0
  let lastSeenStallCount = 0
  const refreshStallEscalation = () => {
    const n = engine.stall.stallCount.value
    if (n > lastSeenStallCount) { recentStalls += n - lastSeenStallCount; lastSeenStallCount = n }
    // 倍速现读：自动最佳倍速会在播放中改它，用起播那一刻的值会算错归零时机
    if (engine.stall.smoothSecs.value >= stallDecaySmoothSecs(playbackRate.value)) recentStalls = 0
    return recentStalls
  }
  engine.registerTickHook(refreshStallEscalation)   // 每秒心跳刷新一次

  const scheduleAutoPlay = () => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
    isBuffering.value = true
    const startTs = performance.now()
    // 定位类起播（切集/拖进度/重载）走低门槛。engine 在 loadVideo 里置位，这里只读一次：
    // 起播成功后 clearRelocating 会把它清掉，读晚了会退回冷启动那一档
    const relocating = engine.isRelocatingStart()

    const tryPlay = () => {
      const video = videoEl.value
      if (!video) { delayedPlayTimer = null; return }
      const ahead = engine.getAheadBuffered(video)
      const waited = performance.now() - startTs
      // 门槛每一拍现算：倍速可能在等待期间被自愈环改掉（尤其「自动最佳倍速」刚测出带宽那一下）
      const target = autoPlayTarget(playbackRate.value, relocating, recentStalls)
      // FLV（直播）不能干等这 2 秒：`liveBufferLatencyChasing` 就是要贴着缓冲边缘播，
      // 存货永远攒不厚，等满 2s 只是白盖 2 秒转圈 → 能播就播
      const ready = media.isFlv.value
        ? video.readyState >= 3 || waited >= 2000
        : !isHls.value
          ? waited >= 2000
          : ahead >= target || waited >= AUTOPLAY_MAX_WAIT_MS
      if (!ready) {
        delayedPlayTimer = setTimeout(tryPlay, AUTOPLAY_POLL_MS)
        return
      }
      delayedPlayTimer = null
      console.log(`开始自动播放（预缓冲 ${ahead.toFixed(1)}s / 门槛 ${target.toFixed(1)}s @${playbackRate.value}x`
        + `，等待 ${(waited / 1000).toFixed(1)}s${recentStalls ? `，近期卡顿 ${recentStalls} 次已抬高门槛` : ''}）`)
      engine.clearRelocating()
      isBuffering.value = false
      void attemptPlay(0)
    }

    // 立刻跑第一拍。原来起手 setTimeout(…, 500) 是无条件的自造延迟：
    // 预热命中、分片已在缓存里时，这 500ms 就是全部的等待时间
    tryPlay()
  }

  /** 这一次加载有没有挂过起播（非 HLS 那条路走 canplay，而它会反复触发） */
  let autoPlayArmed = false

  // HLS 走 MANIFEST_PARSED 触发起播；destroyHls 时要清掉在飞的定时器
  engine.registerAutoPlayHook(scheduleAutoPlay)
  engine.registerDestroyHook(() => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
    autoPlayArmed = false   // loadVideo 一律先 destroyHls，正好当「换了一条流」的信号
  })

  // ── 事件 ──

  const onTimeUpdate = () => {
    if (!videoEl.value) return
    currentTime.value = videoEl.value.currentTime

    // 缓冲进度含预取缓存，进度条反映真实可拖范围
    if (duration.value > 0) {
      const aheadEnd = videoEl.value.currentTime + engine.getCachedAhead(videoEl.value)
      bufferedPercent.value = (aheadEnd / duration.value) * 100
    }

    // 自动跳过片尾。
    // 一集只认一次（outroFired）：timeupdate 每秒来四次，而切集是异步的，
    // 不上这道闩会在等待期间连着调十几次 playNext，一路跳到十几集之后
    //（playByIndex 里还有一道门闩兜底，两处都留着——这里省掉的是无谓的重复调用）。
    if (skipOutro.value > 0 && duration.value > 0 && !outroFired) {
      const remaining = duration.value - currentTime.value
      if (remaining > 0 && remaining <= skipOutro.value && playlist.hasNext.value) {
        outroFired = true
        void playlist.playNext(true)   // 自动：切集期间不再叠加（见 playNext 注释）
        return
      }
    }

    // 每 5 秒保存一次进度（防抖）
    if (!progressSaveTimer) {
      progressSaveTimer = setTimeout(() => {
        playlist.saveCurrentProgress()
        progressSaveTimer = null
      }, 5000)
    }
  }

  /**
   * 读总时长。三个来源按可信度排：
   *   ① `video.duration` 有限值 —— 浏览器自己解出来的，最准；
   *   ② 我们从 `moov/mvhd` 里自读的那份（`mp4ProbedDuration`）—— **安卓 Chrome 在整片 MP4 上
   *      读不出总时长时靠它**（实测 `01:04 / 00:00`、进度条拖不动，而时长明明写在文件里）；
   *   ③ 都没有 → 记 0。
   *
   * 非有限值绝不能直接赋进去：`Infinity`（源长度未知）会让进度条看着能拖、
   * 实际 seek 到 Infinity，比老老实实显示 00:00 更糟。
   *
   * 而且**不能只在 loadedmetadata 读一次**：整片 MP4 的 moov 常在文件尾，
   * 时长晚到几秒甚至一直不来，晚到的那一份走 `durationchange` 补。
   */
  const readDuration = () => {
    const own = videoEl.value?.duration
    if (typeof own === 'number' && Number.isFinite(own) && own > 0) { duration.value = own; return }
    duration.value = media.mp4ProbedDuration.value || 0
  }
  const onDurationChange = () => readDuration()

  /**
   * 整片 MP4 的下载速率采样。
   *
   * 原生播放的请求是**浏览器自己发的**，`fetch` 层拿不到，所以没有真实的网络读数。
   * 但「已缓冲末尾」每秒往前走了几秒 × 平均字节率 就是吞吐量，误差只来自码率不均匀，
   * 判读「够不够喂当前倍速」完全够用。
   *
   * 挂在 `progress` 上而不是自己起定时器：这个事件恰好在「元素确实在收数据」时触发，
   * 缓冲期间也来，正是要采样的时刻。EWMA 平滑——`buffered` 是一段段跳着长的。
   */
  let lastBufEnd = -1
  let lastBufAt = 0
  const onProgress = () => {
    const v = videoEl.value
    if (!v || isHls.value) return
    const now = performance.now()
    const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0
    const dt = (now - lastBufAt) / 1000
    if (lastBufEnd >= 0 && dt > 0.2 && media.mp4AvgMbps.value > 0) {
      const kbps = (Math.max(0, end - lastBufEnd) / dt) * media.mp4AvgMbps.value * 1e6 / 8 / 1024
      media.mp4Kbps.value = Math.round(media.mp4Kbps.value ? media.mp4Kbps.value * 0.7 + kbps * 0.3 : kbps)
    }
    if (lastBufEnd < 0 || dt > 0.2) { lastBufEnd = end; lastBufAt = now }
  }

  const onLoadedMetadata = () => {
    if (!videoEl.value) return
    engine.markDataReceived()
    syncDecodedRes()
    readDuration()
    lastBufEnd = -1   // 换了一集，缓冲末尾的采样基准要重来
    // 出问题时最该看的三个读数：浏览器解出的时长、可 seek 区间、就绪等级。
    // 「拖不动」几乎一定是 seekable 为空或只到已缓冲处，光看时长看不出来
    if (!isHls.value && !media.isFlv.value) {
      const v = videoEl.value
      const sk = Array.from({ length: v.seekable.length }, (_, i) =>
        `${v.seekable.start(i).toFixed(0)}~${v.seekable.end(i).toFixed(0)}`).join(', ') || '(空)'
      console.log(`[mp4] loadedmetadata: duration=${v.duration} seekable=[${sk}] readyState=${v.readyState}`)
    }
    outroFired = false   // 换了一集，片尾闩重新上膛

    // HLS 已经通过 hls.js 的 startPosition 直接从目标位置起播，这里不用再 seek 一次
    //（避免多余的 seek 打断刚起播的加载）；非 HLS 没有 startPosition 机制，仍需手动 seek。
    const key = playlist.progressKey()
    let savedTime = playlist.getSavedProgress(key)
    // 存的位置已经在片尾区 → 这集其实看完了。恢复过去会当场满足「跳过片尾」的判据被弹到下一集，
    // 这集就永远看不成（踩过：看过 22 集后回头点 21 集，播完自动进 22 集又被弹走）。
    // 写入侧已经不再记这种位置了（saveCurrentProgress），这里管的是老版本留下来的记录。
    const finishedAt = duration.value - Math.max(5, skipOutro.value)
    if (savedTime > 0 && savedTime >= finishedAt) {
      playlist.dropSavedProgress(key)
      savedTime = 0
      if (isHls.value && videoEl.value.currentTime >= finishedAt) videoEl.value.currentTime = 0
    }
    // HLS 的两种起播位置（恢复进度 / 跳过片头）都已由 hls.js 的 startPosition 落位
    //（见 useVideoEngine.loadHlsVideo 的 startPos），所以这里**不再 seek 一次**——
    // 多余的 seek 会打断刚起播的加载，而片头那段还会被白下一遍。
    // 唯一要补的是上面那段兜底刚把老进度作废、播放头拨回 0 的情况：
    // 那时引擎给的起播位置是那条作废的进度，若还开着「跳过片头」就得在这里补上。
    if (isHls.value) {
      if (skipIntro.value > 0 && engine.getAppliedStartPos() !== skipIntro.value && savedTime === 0) {
        videoEl.value.currentTime = skipIntro.value
      }
      if (savedTime > 0 || skipIntro.value > 0) hasSkippedIntro.value = true
    } else if (media.isFlv.value) {
      // FLV（尤其直播）没有可落位的时间线：seek 到任何位置都只会把刚起播的流打断
    } else if (savedTime > 0 && savedTime < duration.value - 5) {
      videoEl.value.currentTime = savedTime
      hasSkippedIntro.value = true   // 已恢复进度，视为已跳过片头
    } else if (skipIntro.value > 0 && !hasSkippedIntro.value) {
      videoEl.value.currentTime = skipIntro.value
      hasSkippedIntro.value = true
    }

    // 切换/刷新后重新应用倍速和音量（video 换源时会重置）
    videoEl.value.playbackRate = playbackRate.value
    videoEl.value.volume = volume.value
    videoEl.value.muted = isMuted.value

    // 字幕轨一律先关掉。hls 那边已经 subtitleDisplay: false，但原生轨（MP4 内嵌、
    // 或已经被加到元素上的 TextTrack）不受它管，仍会自己 showing。
    // 只在起播这一下关：之后用户从浏览器自带的字幕菜单打开，我们不再去动它。
    const tracks = videoEl.value.textTracks
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].mode === 'showing') tracks[i].mode = 'disabled'
    }
  }

  const onVolumeChange = () => {
    if (!videoEl.value) return
    volume.value = videoEl.value.volume
    isMuted.value = videoEl.value.muted
  }

  const onVideoError = async (e: Event) => {
    engine.clearLoadTimeout()
    const error = (e.target as HTMLVideoElement)?.error
    let msg = '视频加载失败'

    // 网络/源被拒：先重新取址（签名地址过期时换通道全是白等），再升级可达性策略（重探 → 线性阶梯）。
    // 顺序与 HLS 那条路一致，见 useVideoEngine.recoverFromNetworkFailure
    if (error && (error.code === MediaError.MEDIA_ERR_NETWORK || error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
      if (await playlist.refetchCurrentUrl()) return
      if (conn.escalateStrategyAndReload()) return
    }

    if (error) {
      switch (error.code) {
        case MediaError.MEDIA_ERR_ABORTED:
          msg = '视频加载被中断'
          break
        case MediaError.MEDIA_ERR_NETWORK:
          msg = '网络错误：已自动尝试直连/代理/防盗链均失败，链接可能已过期或无法访问'
          break
        case MediaError.MEDIA_ERR_DECODE:
          msg = '视频解码失败'
          break
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
          msg = '视频源被拒绝或格式不支持：已自动尝试各策略仍失败，请检查链接'
          break
      }
    }

    console.error('视频错误:', error)
    errorMessage.value = msg
    isLoading.value = false
    isBuffering.value = false
    isVideoLoaded.value = false
  }

  const onCanPlay = () => {
    isLoading.value = false
    if (videoEl.value) {
      videoEl.value.playbackRate = playbackRate.value
      videoEl.value.volume = volume.value
      videoEl.value.muted = isMuted.value
    }
    /**
     * 非 HLS 没有 MANIFEST_PARSED，起播预缓冲在这里挂。**但一次加载只许挂一发**：
     * `canplay` 在直播 FLV 上会反复触发（每次 readyState 回升一次就来一发），
     * 而 scheduleAutoPlay 起手就 `isBuffering = true` 并等到判据成立 —— 无条件重挂
     * 等于**在正常播放的画面上反复盖转圈**，还会把用户自己按的暂停自动放开。
     */
    if (!isHls.value && !autoPlayArmed) {
      autoPlayArmed = true
      scheduleAutoPlay()
    }

    // 自动全屏只登记意图，兑现交给 controls（它才管横屏锁和 iOS 的原生全屏兜底）。
    // 原来在这里直接 requestFullscreen 并把 reject 打进 console：安卓上**必然**被拒
    // （没有用户激活），于是「自动全屏」在手机上从来没生效过，还看不出是被谁拒的。
    if (isFirstLoad && autoFullscreen.value) {
      isFirstLoad = false
      media.pendingAutoFullscreen.value = true
    }
  }

  const onLoadedData = () => { isLoading.value = false }

  const onWaiting = () => {
    // 不当场点亮转圈：拖进度后 waiting 必然触发一次，而目标分片多半已在预取缓存里，
    // 等的只是 append/解码那几百毫秒（见 engine.armBufferingGate 的两级判据）
    engine.armBufferingGate()
    if (!isHls.value) return
    // 卡顿即刻反应：立即跑一次预取控制（不等下一个心跳/FRAG_BUFFERED）
    engine.prefetchTick()

    /*
     * **已经形成抖动了就主动 hold 一下，把「五次一秒的卡」换成「一次几秒的等」。**
     *
     * 浏览器的默认行为是「拿到一帧就继续播」——慢源上这必然抖成锯齿：播 1 秒、卡 1 秒、
     * 再播 1 秒……每一次都要重新对焦画面和声音，比一次干脆的等待难受得多。
     * 我们没法改浏览器的恢复策略，但可以自己按住：暂停 → 走 scheduleAutoPlay，
     * 由它按**抬高后的门槛**（见 autoPlayTarget 的递增）攒够再放行，遮罩上还有转圈交代。
     *
     * 只在**已经连着卡两次**时才这么做：第一次卡完全可能是偶发（一个慢分片），
     * 当场按住反而是自找的延迟；连着卡才说明供给真的跟不上。
     * 用户主动暂停的不管（paused 时压根不会走到这里）。
     */
    const video = videoEl.value
    if (refreshStallEscalation() >= 2 && video && !video.paused && !video.ended) {
      console.log(`连续卡顿 ${recentStalls} 次 → 主动缓冲到更高门槛再播（避免反复短卡）`)
      video.pause()
      scheduleAutoPlay()
    }
    // 缓冲空洞跳跃：播放头前方几乎没缓冲、但更后面存在缓冲段（洞），跳过小洞恢复播放
    if (video && video.buffered.length > 1 && engine.getAheadBuffered(video) < 0.3) {
      const ct = video.currentTime
      for (let i = 0; i < video.buffered.length; i++) {
        const s = video.buffered.start(i)
        if (s > ct && s - ct < 3) { video.currentTime = s + 0.01; break }  // 跳过 <3s 的洞
      }
    }
  }

  const onCanPlayThrough = () => { isBuffering.value = false }

  // 开始 seek：延迟显示 loading，避免已缓冲区域的快速 seek 闪烁转圈
  const onSeeking = () => {
    if (seekBufferingTimer) clearTimeout(seekBufferingTimer)
    seekBufferingTimer = setTimeout(() => {
      seekBufferingTimer = null
      isBuffering.value = true
    }, 150)
  }

  const onSeeked = () => {
    if (seekBufferingTimer) { clearTimeout(seekBufferingTimer); seekBufferingTimer = null }
    // 起播定位到位（currentTime 刚跳到锚点）不是用户跳转：预取本就锚定在此、已在正确位置
    // 并行下载，别 abort 掉白费。只有真·用户跳转才终止旧位置预取、腾连接给新位置。
    const arrivingAtStart = engine.isArrivingAtStart(videoEl.value?.currentTime ?? 0)
    engine.clearStartAnchor()   // 此后以真实播放头为准
    if (!arrivingAtStart) {
      // 不清空已完成缓存：seek 回跳/来回拖动时直接命中内存，不重新下载（TTL+LRU 兜底）
      engine.abortAllPrefetches()
      engine.prefetchInfo.value.pending = 0
      // 收窄并发这件事不用在这里做：新位置前方缓存归零 → 「存货够播几秒」自然为 0，
      // useHlsPrefetch 的 SAFE_WALL_SECS 那条规则会立刻把线程压到 2~3，
      // 等补到够播 5 秒再自己放开。拖回已缓存段落时存货本来就足，一条也不压。
    }
    isBuffering.value = false
    // 立刻在当前位置并行预取（不等 1s 心跳），尽快把目标分片拉下来
    if (isHls.value) engine.primePrefetch()
  }

  /**
   * 暂停时补一次强制重新合成。
   *
   * 治的是**暂停那一刻画面撕裂/留残影**：浏览器把视频画在独立的硬件 overlay 平面上，
   * 停下来之后那层不再更新，最后一次合成没画完就永远留在屏幕上（实测拔蓝牙耳机
   * 触发的系统级暂停最容易撞上：画面错开成两块，音频和 currentTime 都正常）。
   * 手动点暂停通常没事，因为那一下的点击本身就带来了别的重绘。
   *
   * 只在**没有别的东西会重画**时才做：`isBuffering` 期间有转圈遮罩在动，不用管。
   */
  const onPause = () => {
    isPlaying.value = false
    /*
     * **暂停不解锁**。这里原来是无条件 `isLocked = false`（理由是「画面停了就没什么可防的」），
     * 但 `pause` 事件的来路远不止用户点暂停：抗卡会主动 pause 去攒秒数、卡死自救会动播放头、
     * 而**切走应用时我们自己就会 pause**（锁定态要保住进度）—— 于是「锁上 → 切个应用 →
     * 回来锁没了」，用户点名报过。
     * 逃生口不靠这一句：锁定态下解锁键在任何尺寸下都渲染，点一下画面就露出来（见 Stage.vue）。
     */
    if (!isBuffering.value) engine.forceRecomposite()
  }

  const onPlaying = () => {
    isBuffering.value = false
    isPlaying.value = true
    // 兜底：已在播放 = 起播位置已定，改用真实播放头（防 seeked 事件缺失时锚点残留）
    engine.clearStartAnchor()
  }

  const onVideoEnded = () => {
    isPlaying.value = false
    if (playlist.hasNext.value) void playlist.playNext(true)   // 播完自动下一集：同上，auto
  }

  /** 页面卸载时清掉本模块起的定时器 */
  const disposeEvents = () => {
    if (progressSaveTimer) clearTimeout(progressSaveTimer)
    if (delayedPlayTimer) clearTimeout(delayedPlayTimer)
    if (seekBufferingTimer) clearTimeout(seekBufferingTimer)
  }

  return {
    onTimeUpdate, onLoadedMetadata, onDurationChange, onProgress, onVolumeChange, onVideoError,
    onCanPlay, onLoadedData, onWaiting, onCanPlayThrough,
    onSeeking, onSeeked, onPlaying, onPause, onVideoEnded,
    onVideoResize, videoRes,
    scheduleAutoPlay, disposeEvents,
  }
}

export type VideoEvents = ReturnType<typeof useVideoEvents>
