/**
 * `<video>` 元素的事件处理（起播预缓冲见 ./events/autoplay.ts）。
 *
 * 单独成模块的理由：这些回调只被模板绑定，彼此之间几乎不共享私有状态，
 * 但每一个都要横跨 media/engine/playlist 三个模块，塞在引擎里会让引擎既管加载又管播放反馈。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoEngine } from './useVideoEngine'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'
import { useAutoplayScheduler } from './events/autoplay'


export interface VideoEventsDeps {
  media: VideoMediaState
  engine: VideoEngine
  conn: VideoConnStrategy
  playlist: VideoPlaylistCtl
}

export function useVideoEvents(deps: VideoEventsDeps) {
  const { media, engine, conn, playlist } = deps
  const {
    videoEl, isHls, isPlaying, isBuffering, isLoading, isVideoLoaded,
    currentTime, duration, bufferedPercent, volume, isMuted, playbackRate,
    skipIntro, skipOutro, hasSkippedIntro, autoFullscreen, errorMessage,
    hlsStats, decodedRes,
  } = media

  // 起播预缓冲（门槛随卡顿递增/归零、scheduleAutoPlay、canplay 只挂一发）——实现见 ./events/autoplay.ts
  const { scheduleAutoPlay, refreshStallEscalation, getRecentStalls, armCanPlayOnce, disposeAutoplay } =
    useAutoplayScheduler({ media, engine })


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
  let seekBufferingTimer: ReturnType<typeof setTimeout> | null = null


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
        // 切集途中旧 `<video>` 还在原地播，此刻读到的秒数属于**上一集**，不能按新集数落库
        //（playByIndex 开头已经就地把上一集存过一次了）。见 useVideoPlaylistCtl 的 playingIndex
        if (!playlist.isSwitching.value) playlist.saveCurrentProgress()
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
    if (!isHls.value) armCanPlayOnce()

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
      console.log(`连续卡顿 ${getRecentStalls()} 次 → 主动缓冲到更高门槛再播（避免反复短卡）`)
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
    if (isHls.value) {
      engine.primePrefetch()
      // primePrefetch 刚把目标压低时会记下「刚减过线程」的沉降锁；seek 不是「判定多开了」，
      // 清掉它，缓冲一补起来就能立刻升并发（否则要白等一个沉降期，最长 5s）
      engine.resetConcurrencyRamp()
    }
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
    disposeAutoplay()   // 起播预缓冲那边在飞的定时器
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
