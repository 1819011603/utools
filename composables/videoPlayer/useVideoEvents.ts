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
 * **门槛的单位是「能播多少秒」，不是「缓冲了多少秒」**——两者差一个倍速。
 * 3x 下缓冲 6 秒只够播 2 秒，1x 下缓冲 2 秒就够播 2 秒；拿固定秒数当门槛，
 * 等于在高倍速下过早起播（马上再卡）、在 1x 下过晚起播（干等）。所以一律 × 倍速。
 *
 * 两档只差「要几秒的播放量」：
 * · 定位类起播（切集 / 拖进度 / 重载）—— 画面停着，每多一秒都在盯转圈 → 够播 2 秒就走，
 *   后面由预取追；真追不上还有抗卡环兜。
 * · 首次冷启动（刚点开页面，人还在看别的）—— 多等一会儿攒厚一点划算 → 至少 6 秒缓冲，
 *   高倍速下同样按「够播 2 秒」放宽（3x 时两者正好都是 6s）。
 *
 * 实测这两档配合「存货不够就少开线程」（见 useHlsPrefetch 的 SAFE_WALL_SECS）才有意义：
 * 不收窄并发的话，门槛要的这点量本身就被 6~12 条并行下载拖慢了。
 */
const AUTOPLAY_PLAYABLE_SECS = 2      // 「够播几秒」就可以出画面
const AUTOPLAY_COLD_MIN_BUFFER = 6    // 冷启动的缓冲下限（1x 时就是它）
const AUTOPLAY_MIN_BUFFER = 1         // 再快也得有这么多，否则等于没缓冲就播
const AUTOPLAY_MAX_WAIT_MS = 8000

/** 起播门槛（秒缓冲）。relocating = 切集/拖进度/重载那一档 */
const autoPlayTarget = (rate: number, relocating: boolean): number => {
  const byRate = AUTOPLAY_PLAYABLE_SECS * Math.max(1, rate)
  return relocating
    ? Math.max(AUTOPLAY_MIN_BUFFER, byRate)
    : Math.max(AUTOPLAY_COLD_MIN_BUFFER, byRate)
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
  } = media

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
      const target = autoPlayTarget(playbackRate.value, relocating)
      const ready = !isHls.value
        ? waited >= 2000
        : ahead >= target || waited >= AUTOPLAY_MAX_WAIT_MS
      if (!ready) {
        delayedPlayTimer = setTimeout(tryPlay, AUTOPLAY_POLL_MS)
        return
      }
      delayedPlayTimer = null
      console.log(`开始自动播放（预缓冲 ${ahead.toFixed(1)}s / 门槛 ${target.toFixed(1)}s @${playbackRate.value}x`
        + `，等待 ${(waited / 1000).toFixed(1)}s）`)
      engine.clearRelocating()
      isBuffering.value = false
      void attemptPlay(0)
    }

    // 立刻跑第一拍。原来起手 setTimeout(…, 500) 是无条件的自造延迟：
    // 预热命中、分片已在缓存里时，这 500ms 就是全部的等待时间
    tryPlay()
  }

  // HLS 走 MANIFEST_PARSED 触发起播；destroyHls 时要清掉在飞的定时器
  engine.registerAutoPlayHook(scheduleAutoPlay)
  engine.registerDestroyHook(() => {
    if (delayedPlayTimer) { clearTimeout(delayedPlayTimer); delayedPlayTimer = null }
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
        void playlist.playNext()
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

  const onLoadedMetadata = () => {
    if (!videoEl.value) return
    engine.markDataReceived()
    duration.value = videoEl.value.duration
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
    // 非 HLS 没有 MANIFEST_PARSED，起播预缓冲在这里挂
    if (!isHls.value) scheduleAutoPlay()

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
    isBuffering.value = true
    if (!isHls.value) return
    // 卡顿即刻反应：立即跑一次预取控制（不等下一个心跳/FRAG_BUFFERED）
    engine.prefetchTick()
    // 缓冲空洞跳跃：播放头前方几乎没缓冲、但更后面存在缓冲段（洞），跳过小洞恢复播放
    const video = videoEl.value
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
    // 暂停就解锁：锁定防的是「看着的时候误触」，画面都停了就没什么可防的了。
    // 而锁定态下画面上只有一枚解锁键，来电/拔耳机这类系统级暂停之后，
    // 用户回来面对的是一个点什么都没反应的播放器
    media.isLocked.value = false
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
    if (playlist.hasNext.value) playlist.playNext()
  }

  /** 页面卸载时清掉本模块起的定时器 */
  const disposeEvents = () => {
    if (progressSaveTimer) clearTimeout(progressSaveTimer)
    if (delayedPlayTimer) clearTimeout(delayedPlayTimer)
    if (seekBufferingTimer) clearTimeout(seekBufferingTimer)
  }

  return {
    onTimeUpdate, onLoadedMetadata, onVolumeChange, onVideoError,
    onCanPlay, onLoadedData, onWaiting, onCanPlayThrough,
    onSeeking, onSeeked, onPlaying, onPause, onVideoEnded,
    scheduleAutoPlay, disposeEvents,
  }
}

export type VideoEvents = ReturnType<typeof useVideoEvents>
