/**
 * 视频装载：把一条 URL 装进 `<video>`（HLS / FLV / 原生 MP4 三条路），以及 HLS 的事件接线。
 *
 * 从 `useVideoEngine` 拆出来：这是「怎么把流挂上去」的一整套，跟心跳、预取、网络恢复等
 * 引擎级逻辑只通过下面这组依赖打交道。引擎仍是 hls/flv 实例的持有者（通过 setHls/setFlv 回写），
 * 本模块只在装载期间用到它们。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type HlsType from 'hls.js'
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoConnStrategy } from '../useVideoConnStrategy'
import { isFlvUrl } from '../../../utils/mediaUrl'
import { buildHlsConfig } from './hlsConfig'
import { useHlsErrorHandler } from './hlsErrors'
import { probeMp4Head } from './mp4Duration'
import { createFlvStream, type FlvHandle } from './flvStream'
import { holdPiP, releasePiPHolder } from './pipHandoff'

// 动态导入 hls.js（避免 SSR 问题），模块级缓存一次
let Hls: typeof HlsType | null = null

export interface VideoLoaderDeps {
  media: VideoMediaState
  conn: VideoConnStrategy
  getSavedProgress: (url: string) => number
  progressKey: () => string
  /** 就地重新取一次播放地址并重载（按需取址的站点才做得到） */
  refetchUrl: () => Promise<boolean>
  // 引擎动作
  destroyHls: () => void
  setHls: (h: HlsType | null) => void
  setFlv: (f: FlvHandle | null) => void
  armPiPRestore: () => void
  useCacheForVideo: (url: string) => void
  startLoadTimeout: () => void
  markDataReceived: () => void
  startPrefetchCleanup: () => void
  primePrefetch: () => void
  startHlsTick: () => void
  startFlvTick: () => void
  updateHlsStats: () => void
  cancelBufferingGate: () => void
  armBufferingGate: () => void
  triggerAdaptivePrefetch: (sn: number) => void
  failMessage: (fallback: string) => string
  createHlsFragLoader: () => any
  createHlsPlaylistLoader: (defaultLoader: any) => any
  onBufferStalled: () => void
  /** MANIFEST_PARSED 之后要触发的起播预缓冲（由 useVideoEvents 登记，可能还没登记上） */
  getAutoPlayHook: () => (() => void) | null
  // 起播锚点
  beginAnchor: (startPos: number) => void
  setAppliedStartPos: (n: number) => void
  setRelocating: (v: boolean) => void
}

export function useVideoLoader(deps: VideoLoaderDeps) {
  const { media, conn } = deps
  const {
    videoUrl, videoEl, isHls, isFlv, isLoading, isBuffering, isPlaying, isVideoLoaded,
    errorMessage, currentTime, duration, bufferedPercent, videoKey, hlsConfig, playbackRate, volume, isMuted,
  } = media
  const { setHls, setFlv, destroyHls, beginAnchor, setAppliedStartPos, setRelocating, getAutoPlayHook } = deps

  /** 等 `<video>` 挂上来（元素被 `videoKey++` 重建的那条路）。 */
  const awaitMount = async (ms: number) => {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  /** 等元素挂好并断言存在（FLV / 原生那条路，元素一定是刚重建的），返回该元素。 */
  const awaitVideoEl = async (ms: number): Promise<HTMLVideoElement> => {
    await awaitMount(ms)
    const el = videoEl.value
    if (!el) throw new Error('视频元素未初始化，请刷新页面重试')
    return el
  }

  const loadVideo = async () => {
    if (!videoUrl.value.trim()) return

    errorMessage.value = ''
    isLoading.value = true
    isBuffering.value = true
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0
    bufferedPercent.value = 0
    setAppliedStartPos(0)   // 非 HLS 那条路不设 startPosition，别留上一次的值
    /**
     * 「定位类起播」= 页面上已经有播放器了（切集 / 重载 / 改配置），起播门槛走「够播 2 秒」那一档。
     * 本次会话第一发（`isVideoLoaded` 还是 false）算冷启动，仍要攒够 6 秒——那时用户刚打开页面，
     * 多等一会儿攒厚一点划算；而切集时画面是停着的，每多一秒都在盯转圈。
     * 必须在下面把 isVideoLoaded 置真**之前**读。
     */
    setRelocating(isVideoLoaded.value)

    const url = videoUrl.value.trim()
    const nextIsHls = conn.isHlsUrl(url)
    const nextIsFlv = !nextIsHls && isFlvUrl(url)
    /**
     * **HLS → HLS 时复用同一个 `<video>` 元素**，不再 `videoKey++`。
     *
     * 重建元素要付四笔账：等一次 `nextTick` + 50ms（新元素挂载）；解码器被卸掉重建；
     * 刚发出的 `play()` 撞上 attach 变成 `AbortError`、再等 400ms×n 重试；
     * 以及**画面立刻变黑**——切集体感「慢」有一半来自这一下黑屏，跟真实耗时无关。
     * 换成复用之后，上一集最后一帧会留在屏幕上直到新流出画面。
     *
     * 只有「HLS ↔ MP4 互转」才必须重建：原生播放要 `src`，而 MSE 那套挂在同一个元素上，
     * 两种模式的内部状态（error / networkState / 已 append 的 buffer）混在一起清不干净。
     * `videoTransform` 也不再被重建冲掉（见 forceRecomposite）。
     */
    const reuseEl = !!videoEl.value && isVideoLoaded.value && nextIsHls && isHls.value
    /**
     * 画中画接力**第一段**，必须赶在下面 `destroyHls` / `removeAttribute('src')` 之前：
     * 那两步一执行，Chrome 就把 `document.pictureInPictureElement` 清空（小窗还开着但已经没主），
     * 「已有元素在画中画里 → 申请免用户激活」那条豁免随之消失，播完自动切集就再也开不回来。
     * 详见 engine/pipHandoff.ts。
     */
    const wasPiP = !!videoEl.value && document.pictureInPictureElement === videoEl.value
    const pipHeld = wasPiP ? await holdPiP('正在切换到下一集…') : false
    if (!reuseEl) videoKey.value++
    isVideoLoaded.value = true
    destroyHls()
    // 复用时元素上还留着上一条流的痕迹（MSE 的 blob src、error、已缓冲区间）。
    // hls.js 的 attachMedia 会重设 srcObject/src，但先手动摘掉更稳：
    // 残留的 src 会让 <video> 在 attach 之前先对旧地址发一次请求（表现是控制台多一条取消的请求）。
    if (reuseEl && videoEl.value) {
      videoEl.value.removeAttribute('src')
      try { videoEl.value.load() } catch {}
    }

    // 按视频切换缓存：同一视频（重播/点回去）保留内存缓存，换了视频才清空旧的
    deps.useCacheForVideo(url)
    // 可达性探测可能阻塞（首访该 host 时约 0.5-3s）——必须在 startLoadTimeout 之前 await，
    // 否则探测耗时会被算进加载超时，慢源直接被误判成「加载超时」。
    await conn.applyStrategy(url)
    // 探测期间用户切了地址 → 放弃本次加载。占位画面要一起收掉，否则小窗永远停在「正在切换…」
    // （新的那一发 loadVideo 会自己重新接力）
    if (videoUrl.value.trim() !== url) { if (pipHeld) releasePiPHolder(); return }

    deps.startLoadTimeout()
    isHls.value = nextIsHls
    isFlv.value = nextIsFlv

    console.log('开始加载视频:', url, '是否HLS:', isHls.value,
      isFlv.value ? '（FLV）' : '', '使用代理:', conn.useProxy.value)

    try {
      if (isHls.value) await loadHlsVideo(url, reuseEl)
      else if (isFlv.value) await loadFlvVideo(url)
      else await loadNativeVideo(url)
      // 挂在这里而不是更早：src 刚设上（重建元素那条路新元素也已挂好），元信息事件还没可能派发，
      // 一次都不会漏
      if (pipHeld) deps.armPiPRestore()
    } catch (e) {
      console.error('加载视频失败:', e)
      if (pipHeld) releasePiPHolder()   // 这一集起不来了，别让小窗一直停在「正在切换…」
      errorMessage.value = '加载视频失败: ' + (e instanceof Error ? e.message : String(e))
      isLoading.value = false
      isBuffering.value = false
      isVideoLoaded.value = false
    }
  }

  const loadHlsVideo = async (url: string, reuseEl = false) => {
    if (!Hls) Hls = (await import('hls.js')).default
    const HlsLib = Hls   // 取成局部常量，闭包里就不用到处写 Hls!

    isVideoLoaded.value = true
    // 只有真重建了元素才需要等它挂载。复用时元素一直在 DOM 里，这 50ms 是白等——
    // 而它落在切集的关键路径上，每切一集都赔一次。
    // `!videoEl.value` 那半边是兜底：判定「可复用」是在 await 可达性探测**之前**做的，
    // 那期间出错路径可能把 isVideoLoaded 关掉、Stage 连同 <video> 一起卸掉，
    // 这时候还是得等它挂回来，而不是当场抛「视频元素未初始化」。
    if (!reuseEl || !videoEl.value) {
      await awaitMount(50)
    }

    if (!HlsLib.isSupported()) {
      // 尝试原生支持（Safari）
      if (videoEl.value?.canPlayType('application/vnd.apple.mpegurl')) {
        await loadNativeVideo(url)
        return
      }
      errorMessage.value = '您的浏览器不支持 HLS 播放'
      isLoading.value = false
      return
    }
    if (!videoEl.value) throw new Error('视频元素未初始化')

    const finalUrl = conn.getProxyUrl(url)
    console.log('加载 HLS 视频:', finalUrl)

    /**
     * 起播位置：直接告诉 hls.js 从这里起播，避免它先从头猛下一堆用不上的分片、
     * 等 onLoadedMetadata 里再 seek 过去（那样等于白下了一遍开头）。
     *
     * **跳过片头也走这条路**。原来 startPosition 只认进度记录，`skipIntro` 是在
     * onLoadedMetadata 里手动 `currentTime = skipIntro` 实现的——于是开着「跳过片头 90s」时
     * hls.js 从 0 开始下，下到一半被 seek 打断，再从 90s 重下一遍。片头那段全是白下的流量，
     * 起播还平白多等一轮。两者语义本来就一样：都是「从第 N 秒开始播」。
     * 进度优先于片头（看到一半回来的人不该被扔回片头之后）。
     *
     * 进度按稳定键存（按需取址的站点真实地址每次都变），不能用 url 查。
     */
    const resumeTime = deps.getSavedProgress(deps.progressKey())
    const startPos = resumeTime > 0 ? resumeTime : (media.skipIntro.value > 0 ? media.skipIntro.value : 0)
    beginAnchor(startPos)

    const hls = new HlsLib(buildHlsConfig({
      tuning: hlsConfig.value,
      startPos,
      fLoader: deps.createHlsFragLoader() as any,
      // 清单加载器必须包在 hls.js 默认 loader 之上（miss 时要走它原来的那套重试/超时）
      pLoader: deps.createHlsPlaylistLoader((HlsLib as any).DefaultConfig.loader) as any,
      hwDecode: media.hwDecode.value,
    }))
    setHls(hls)

    /**
     * 字幕默认不出。hls.js 的 `subtitleDisplay` 默认为真，清单里带字幕轨时它会自动选一条并渲染，
     * 于是画面上凭空多出一层字幕——而本播放器压根没有字幕开关，用户只能问「这怎么关」（实测被问到）。
     * 源站带的字幕多半还硬编码在画面里，这一层纯属重叠。
     * 真要字幕就用浏览器自带的字幕菜单，不在这里造一套 UI。
     * 注意它是**实例属性**不是构造配置，写进 new Hls({...}) 里 tsc 直接报未知属性。
     */
    hls.subtitleDisplay = false

    /**
     * **事件必须在 loadSource 之前登记**（hls.js 官方也是这么建议的）。
     *
     * 原来是「loadSource → attachMedia → 然后才 hls.on(...)」，靠的是「网络请求总是异步的、
     * 事件不可能在这几行之内就派发」。而 pLoader 命中探测下载好的清单时是**同步**回调的，
     * 于是 MANIFEST_LOADED/MANIFEST_PARSED 在 `loadSource()` 里就派发完了——
     * 那时还没有人订阅，`autoPlayHook` 一辈子不会被调，画面永远停在「加载中…」（踩过）。
     */
    hls.on(HlsLib.Events.MANIFEST_PARSED, (_, data) => {
      /*
       * **画质档要连分辨率一起打出来**（一行字符串，不是对象——控制台默认把对象折成 `{…}`）。
       * 「档数 5」这个读数分不清一件要紧的事：**各档的宽高比一致吗**。
       * 实测遇到同一条流里 1920x800（2.40:1 裁过的）和 1920x1080（16:9 烧了黑边的）并存，
       * ABR 一换档，`<video>` 的固有比例就变 → 画中画小窗被浏览器跟着改尺寸（且只增不减，
       * 缩小方向浏览器不给）。没有这一行的话，现场只能看到「小窗自己越变越大」。
       */
      const levelBrief = data.levels
        .map((l: any, i: number) => `${i}:${l.width || '?'}x${l.height || '?'}`
          + `${l.width && l.height ? `(${(l.width / l.height).toFixed(2)})` : ''}`)
        .join(' ')
      console.log(`HLS manifest 解析完成，画质数: ${data.levels.length} → ${levelBrief}`)
      deps.markDataReceived()
      isLoading.value = false
      deps.startPrefetchCleanup()  // 启动周期清理过期缓存
      if (videoEl.value) {
        videoEl.value.playbackRate = playbackRate.value
        videoEl.value.volume = volume.value
        videoEl.value.muted = isMuted.value
      }
      getAutoPlayHook()?.()
    })

    // playlist（分片列表）就绪 → 立刻并行预热前若干分片 + 启动实时心跳
    hls.on(HlsLib.Events.LEVEL_LOADED, () => {
      deps.primePrefetch()
      deps.startHlsTick()
    })

    // 致命错误处理（实现见 ./engine/hlsErrors.ts）：网络重试 → 重新取址 → 重探；媒体错误恢复带上限
    const { onHlsError, resetErrorCounters, noteLoadOk } = useHlsErrorHandler({
      HlsLib,
      getHls: () => hls,
      setError: (msg: string) => { errorMessage.value = msg; return msg },
      clearIfUnchanged: (msg: string) => { if (errorMessage.value === msg) errorMessage.value = '' },
      failMessage: deps.failMessage,
      giveUp: () => {
        isLoading.value = false
        isBuffering.value = false
        isVideoLoaded.value = false
        destroyHls()
      },
      refetchUrl: () => deps.refetchUrl(),
      escalateStrategy: () => conn.escalateStrategyAndReload(),
      onBufferStalled: deps.onBufferStalled,
    })
    resetErrorCounters()
    hls.on(HlsLib.Events.ERROR, (_, data) => onHlsError(data))

    // 分片加载完成 → 更新统计 + 触发自适应预取
    hls.on(HlsLib.Events.FRAG_BUFFERED, (_, data) => {
      deps.updateHlsStats()
      deps.cancelBufferingGate()
      isBuffering.value = false
      // 成功一片就把网络重试额度还回去：额度的语义是「连续失败」，不是「本次播放累计」
      // （见 hlsErrors.noteLoadOk——不还的话看久了任何一次抖动都直接走到销毁）
      noteLoadOk()
      // sn 在 init segment 上是字符串 'initSegment'，那种片没有后续可预取，跳过
      const sn = data?.frag?.sn
      if (typeof sn === 'number') deps.triggerAdaptivePrefetch(sn)
    })

    // 分片加载中：不再当场点亮转圈，交给延迟闸门按「有效可播」判（见 armBufferingGate）。
    // 原来这里是 `buffered.end(最后一段) - currentTime < 2` 就亮，两处都错：判据该看播放头
    // 所在缓冲段的前向（拖进度后最后一段常整段落在播放头后面，两者差十几秒），且不该立刻亮
    hls.on(HlsLib.Events.FRAG_LOADING, () => deps.armBufferingGate())

    hls.on(HlsLib.Events.LEVEL_SWITCHED, (_, data: any) => {
      deps.updateHlsStats()
      // 换档要留一行痕迹：`<video>` 的固有比例跟着当前档走，比例一变画中画小窗就被浏览器改尺寸。
      // 没这行的话，「小窗自己越变越大」和「流里拼了不同分辨率的片段」这两件事在现场分不开
      const l: any = hls?.levels?.[data?.level]
      if (l?.width && l?.height) console.log(`[level] 切到档 ${data.level}：${l.width}x${l.height} = ${(l.width / l.height).toFixed(3)}`)
    })

    // 全部事件登记完毕，这才开始加载（见上面 MANIFEST_PARSED 处的说明）
    /**
     * **先 attachMedia 再 loadSource**。顺序反了在 pLoader 命中时会整个播不起来：
     * 那一发清单是同步返回的，于是 `loadSource()` 一行之内就把清单解析完并开始拉分片，
     * 而此时 `<video>` 还没 attach、MediaSource 压根不存在——分片下下来无处可 append，
     * 表现是「分片一个接一个 200，缓冲恒 0，画面一直转圈」（踩过）。
     * 这也是 hls.js 文档里给的标准顺序，异步那条路上同样更稳。
     */
    hls.attachMedia(videoEl.value)
    hls.loadSource(finalUrl)
  }

  /**
   * FLV：交给 mpegts.js 解复用喂 MSE（浏览器不认这个容器，`<video src>` 一定放不出来）。
   *
   * **先直连，代理只作退路**。走了 MSE 就意味着数据是我们自己 fetch 的 → 跨源必须有 CORS 头，
   * 所以这条路上确实可能要代理；但**直播 CDN 并不是都不给** —— 抖音那条实测回
   * `Access-Control-Allow-Origin: *`（`Timing-Allow-Origin: *` 也给了），直连完全可行。
   * 而**直播尤其不该白走一趟代理**：那是一条长连接，全程要占着 Worker 转发，
   * 平白多一跳延迟、还把首帧和断流重连都压在我们自己的出口上。
   * 所以顺序交给 `createFlvStream` 逐条试：**没出过数据就换下一条，出过就粘住**。
   * 混合内容那种（https 页面拉 http 流）直连必被浏览器拦，直接跳过不试。
   */
  const loadFlvVideo = async (url: string) => {
    const proxied = conn.getProxyUrl(url)
    // getProxyUrl 只在注入了 Origin/Referer 时才代理 → 补一发 noref=1 兜住「什么头都没填」的常态
    const viaProxy = proxied === url ? conn.getProxyPassthroughUrl(url) : proxied
    const mixed = url.startsWith('http:') && location.protocol === 'https:'
    const channels = mixed
      ? [{ label: '代理', url: viaProxy }]
      : [{ label: '直连', url }, { label: '代理', url: viaProxy }]
    isVideoLoaded.value = true
    const el = await awaitVideoEl(100)   // 元素是刚 videoKey++ 重建的，等它挂上来（同 loadNativeVideo）
    deps.startFlvTick()
    setFlv(await createFlvStream(el, channels, url, msg => {
      // 期间可能已经切走了，别把上一条流的错误盖到新的上面
      if (videoUrl.value.trim() !== url) return
      errorMessage.value = msg
      isLoading.value = false
      isBuffering.value = false
    }))
  }

  const loadNativeVideo = async (url: string) => {
    const finalUrl = conn.getProxyUrl(url)
    console.log('加载原生视频:', finalUrl)
    isVideoLoaded.value = true
    const el = await awaitVideoEl(100)   // 等 DOM 更新（video 元素重新创建需要更多时间）
    el.src = finalUrl
    el.load()

    /**
     * 顺手自己读一次真实时长与平均码率（约 2.5KB 两发小请求，见 engine/mp4Duration.ts）。
     *
     * 安卓 Chrome 在这类整片 MP4 上**读不出总时长** → 进度条钉在最左边、拖不动
     *（实测 `01:04 / 00:00`），而时长明明就写在 `moov/mvhd` 里。
     * 不 await：它跟起播没有先后关系，读到了再补上去。
     */
    media.mp4ProbedDuration.value = 0
    media.mp4AvgMbps.value = 0
    media.mp4Kbps.value = 0
    void probeMp4Head(finalUrl).then(({ durationSecs, mediaBytes }) => {
      // 期间可能已经切集了，别把上一集的读数写到这一集头上
      if (!durationSecs || videoUrl.value.trim() !== url) return
      media.mp4ProbedDuration.value = durationSecs
      media.mp4AvgMbps.value = mediaBytes
        ? Math.round((mediaBytes * 8 / durationSecs / 1e6) * 100) / 100
        : 0
      const own = videoEl.value?.duration
      const browserKnows = typeof own === 'number' && Number.isFinite(own) && own > 0
      console.log(`[mp4] 自读时长 ${durationSecs.toFixed(1)}s / 码率 ${media.mp4AvgMbps.value} Mbps`
        + `（浏览器${browserKnows ? `读到 ${own!.toFixed(1)}s` : '没读出来 → 用我们这份'}）`)
      if (!browserKnows) duration.value = durationSecs
    })
  }

  return { loadVideo }
}

export type VideoLoader = ReturnType<typeof useVideoLoader>
