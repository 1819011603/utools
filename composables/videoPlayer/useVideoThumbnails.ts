/**
 * 进度条悬浮缩略图（腾讯视频那种）。
 *
 * 这些站点的清单里既没有 `EXT-X-IMAGE-STREAM-INF` 也没有雪碧图，帧只能自己解。
 * 而这个项目为了不卡片把并发抠得极细（同 host 只给 6 条连接、存货不够还要**少**开线程），
 * 缩略图要是随手就去下分片，抢的正是「决定能不能播下去」的那几条 → 用户看到的是画面开始卡。
 * 所以取帧分两路，**先白捡再花钱**：
 *
 *   ① 正播着的画面每跨一个桶就顺手截一帧（`captureTick`）——帧已经在屏幕上了，
 *      零网络零解码器。往回拖（最常见的操作）时缩略图全是现成的。
 *   ② 悬浮到没截过的位置，才起一个隐藏解码器去解那一片。**先吃主播放已经下过的分片**
 *      （`getSegBuf`，预取缓存里那几十秒都算，零网络零延迟）；缓存里没有的（拖到片子后半段）
 *      **等指针停住 320ms 才下**——扫过进度条一趟点名几十个桶，逐个下等于把连接全占死，
 *      而停住不动 = 他真的想看那儿。缓冲吃紧/濒卡/离线时一片都不下。
 *
 * 整片 MP4 不做：它的 `<video>` 是直连 CDN 的（`crossorigin` 一加就整个播不了，见 CLAUDE.md），
 * 画到 canvas 上必然污染，`toDataURL` 直接抛 SecurityError。HLS 走 MSE（src 是 `blob:`，同源）没这问题。
 */
import type { VideoMediaState } from './useVideoMediaState'
import { isOffline } from './engine/netWatch'

/** 缩略图宽度。高度按视频真实比例算，不写死 16:9（这个项目里 2.40:1 的片子很常见） */
const THUMB_W = 240
/** 量化粒度：同一个 10 秒桶共用一张。扫过进度条时绝大多数悬浮点都落在已有的桶里 */
const BUCKET_SECS = 10
const MAX_THUMBS = 40
/** 扫过进度条时别每一像素都去解一帧；命中缓存的那些不走防抖，见 watch(hoverTime) */
const HOVER_DEBOUNCE_MS = 220
/**
 * 「指针停住了」的判据。**只对要下载的那一路生效**：缓存里有的照旧立刻出图。
 * 短了等于扫一趟下十几片，长了则「停下来等半天才出图」。
 */
const SETTLE_MS = 320
/**
 * 片头那一段该取多少字节，**按码率现算，不能拍脑袋定一个常数**。
 *
 * 「一帧而已」在压缩视频里不成立：分片开头那一帧是 **I 帧**，它是整个 GOP 里最大的一帧，
 * 1080p 常见 200~500KB；而 TS 里视频帧被拆进 PES 包，解复用器**收不齐一个完整 PES 包
 * 就不会输出任何样本**。给 100KB 的结果往往是「大半是音频包 + 半个 I 帧」——
 * 解码器一个样本都拿不到，于是「片下回来了、请求 200，就是不出图」。
 *
 * 估法：分片字节 ≈ `bitrate / 8 × duration`，取其三成（I 帧加上前面的头，通常在这个量级内），
 * 夹在 256KB ~ 2MB。夹上限是因为再多就该直接下整片了；夹下限是防止码率读数为 0 时退化成 0。
 */
const HEAD_RATIO = 0.3
const HEAD_MIN = 256 * 1024
const HEAD_MAX = 2 * 1024 * 1024
/**
 * 「这一档数据能不能解出来」的等待上限。数据已经在手上了，解不出就是截断得太狠，
 * **必须比 `SEEK_TIMEOUT_MS` 短得多**：阶梯要试三档，每档都等满 6 秒的话一张图最坏等小二十秒。
 */
const LOAD_TRY_MS = 2500
/** 解一帧的耐心。超了就放弃这一桶——缩略图没有比播放更重要 */
const SEEK_TIMEOUT_MS = 6000
/** 离开进度条这么久就把解码器拆掉：一个 MediaSource + 解码器不算小，留着白占 */
const IDLE_DISPOSE_MS = 30_000
const JPEG_Q = 0.62

export interface VideoThumbnailsDeps {
  media: VideoMediaState
  /** 主播放已经下过的分片（预取缓存 + 播过的都在里面）→ 命中即零网络 */
  getSegBuf: (url: string) => ArrayBuffer | null
  /**
   * 主播放的 hls 实例。**分片表和分片 URL 全从它拿**，缩略图自己一次清单都不取——
   * 那份清单主播放早就解析好了，再取一遍既慢（慢源上一两秒）又可能撞防盗链。
   * 拿到的 `frag.url` 还天然与主播放的分片缓存同键，命中率最高。
   */
  getHls: () => any
  /**
   * 必须跟主播放**完全一致**的连接配置。缓存里没有那一片、要自己下时用它：
   * 不过这一道的话，该走代理注入防盗链头的源一律 403（踩过，见 fetchSeg）。
   */
  getProxyUrl: (url: string) => string
  /** 缓冲健康区。吃紧/濒卡时一片都不许为缩略图下 */
  healthZone: () => string
}

export function useVideoThumbnails(deps: VideoThumbnailsDeps) {
  const { media, getSegBuf, getHls, getProxyUrl, healthZone } = deps
  const { videoEl, videoUrl, isHls, hoverTime } = media

  /** 当前该显示的缩略图（dataURL）。'' = 这个位置还没有 */
  const thumbImage = ref('')
  /** 正在解一帧：tooltip 上转个小圈，否则「在解」和「解不出」长得一样 */
  const thumbPending = ref(false)
  /** canvas 被污染过就永久停用（只可能发生在非 MSE 的源上） */
  const tainted = ref(false)
  /** 浏览器不支持 MSE 时也没得做 */
  const unsupported = ref(false)
  const thumbEnabled = computed(() => isHls.value && !tainted.value && !unsupported.value)

  const bucketOf = (t: number) => Math.max(0, Math.floor(t / BUCKET_SECS))

  // 按桶存 dataURL。Map 的插入顺序就是 LRU 顺序（同 useSegmentCache 的做法，不另养一份计数）
  const shots = new Map<number, string>()
  /** 这批缩略图属于哪个地址。按需取址的站点每集地址都不同，切集必须整批作废 */
  let shotsFor = ''

  const remember = (bucket: number, url: string) => {
    shots.delete(bucket)
    shots.set(bucket, url)
    while (shots.size > MAX_THUMBS) shots.delete(shots.keys().next().value as number)
  }

  /** 切集/换源时作废整批（同一个桶号在两集里指的是完全不同的画面） */
  const syncBatch = () => {
    if (videoUrl.value === shotsFor) return
    shotsFor = videoUrl.value
    shots.clear()
    thumbImage.value = ''
  }

  // ── 抓帧 ──

  let canvas: HTMLCanvasElement | null = null

  const grab = (src: HTMLVideoElement): string => {
    if (!src.videoWidth || !src.videoHeight) return ''
    if (!canvas) canvas = document.createElement('canvas')
    const h = Math.max(1, Math.round(THUMB_W * src.videoHeight / src.videoWidth))
    if (canvas.width !== THUMB_W || canvas.height !== h) { canvas.width = THUMB_W; canvas.height = h }
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    try {
      ctx.drawImage(src, 0, 0, THUMB_W, h)
      return canvas.toDataURL('image/jpeg', JPEG_Q)
    } catch {
      // SecurityError = 画布被跨域视频污染。整块停用，别每次悬浮都再抛一次
      tainted.value = true
      return ''
    }
  }

  /**
   * ① 白捡的那一路：挂在引擎心跳上（每秒一拍），当前桶没截过就顺手截一帧。
   * 每 10 秒播放最多截一次，`toDataURL` 那几毫秒可以忽略。
   * **后台标签页不截**：那时 `drawImage` 拿到的画面不保证是新的，而且后台正是要回收内存的时候。
   */
  const captureTick = () => {
    if (!thumbEnabled.value) return
    const v = videoEl.value
    if (!v || v.paused || v.readyState < 2) return
    if (document.visibilityState !== 'visible') return
    syncBatch()
    const b = bucketOf(v.currentTime)
    if (shots.has(b)) return
    const img = grab(v)
    if (img) remember(b, img)
  }

  // ── ② 隐藏解码器 ──

  let thumbHls: any = null
  let thumbVideo: HTMLVideoElement | null = null
  let HlsMod: any = null       // hls.js 模块本身（要用它的事件名常量）
  let decoderFor = ''          // 解码器当前属于哪一集
  let loadedFragUrl = ''       // 解码器里现在装着哪一片
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const disposeDecoder = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (thumbHls) { try { thumbHls.destroy() } catch { /* 已经销毁过 */ } thumbHls = null }
    if (thumbVideo) {
      // 先摘 src 再移除：留着 blob 引用会让 MediaSource 迟迟不释放
      try { thumbVideo.removeAttribute('src'); thumbVideo.load() } catch { /* 元素已脱离文档 */ }
      try { thumbVideo.remove() } catch { /* 同上 */ }
      thumbVideo = null
    }
    decoderFor = ''
    loadedFragUrl = ''
    segCtrl?.abort()
    segCtrl = null
    ownSegs.clear()
    partialSegs.clear()
    // 迷你清单的 blob 要显式回收，否则每悬浮一次就永久漏一个（页面不刷新就一直攒着）
    for (const u of blobUrls.splice(0)) { try { URL.revokeObjectURL(u) } catch { /* 已回收 */ } }
    playlistText.clear()
  }

  const armIdleDispose = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(disposeDecoder, IDLE_DISPOSE_MS)
  }

  /**
   * 两道闸：缓冲吃紧一律让路（缩略图永远不该是画面卡住的原因），没网就别白试。
   * 分片已经完全不走网络了，这道闸现在管的是**要不要建解码器**——建一次要取清单、
   * 可能还要取密钥，吃紧时连这几 KB 也别去抢。
   */
  const mayFetch = () => {
    const z = healthZone()
    return z !== 'panic' && z !== 'low' && !isOffline()
  }

  /**
   * 缩略图专用 loader：**一切数据都从主播放手上要，一个网络请求都不发**。
   *
   * 清单是我们自己拼的 `blob:`（见 miniPlaylist），hls.js 拿它当普通 URL 请求，
   * 这里直接把文本交回去；分片则去主播放的缓存里取，取不到就报错——那一桶没有图而已。
   *
   * 踩过：原来 miss 时交给 hls.js 默认的 XHR loader 自己下，结果分片一律 **403**
   *（Network 里那条写着 `strict-origin-when-cross-origin`）：XHR 发得出 Referer，
   * 而这些 CDN 认防盗链；主播放那条路是 `fetch(..., { referrerPolicy: 'no-referrer' })`。
   * 现在这条路整个不存在了 —— 慢源上下一片要好几秒，图永远慢一大截才出来，
   * 而它抢的正是「决定能不能播下去」的那几条连接。
   *
   * **交货必须延到下一个宏任务**——跟主播放那份 fLoader 是同一个坑（见 prefetch/fragLoader.ts
   * 里那段长注释）：hls.js 在 `load()` **返回之后**才把这一片记成「在加载中」，
   * 同步回调等于在它记账之前把结果交出去，那一片被当成无主的丢掉，而它永远停在「还在等」。
   */
  const makeLoader = (Hls: any) => class ThumbLoader extends (Hls.DefaultConfig.loader as any) {
    load(context: any, config: any, callbacks: any) {
      this.context = context
      this.stats.loading.start = performance.now()

      const deliver = (data: ArrayBuffer | string) => {
        setTimeout(() => {
          if (this.stats.aborted) return
          this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : data.byteLength
          this.stats.chunkCount = 1
          this.stats.loading.first = this.stats.loading.end = performance.now()
          callbacks.onSuccess({ data, url: context.url }, this.stats, context)
        }, 0)
      }
      const fail = (text: string) => {
        setTimeout(() => {
          if (this.stats.aborted) return
          callbacks.onError({ code: 0, text }, context, null, this.stats)
        }, 0)
      }

      // 清单：就是我们自己拼的那份，直接交（连 blob: 的那一次 fetch 都省了）
      if (context.responseType !== 'arraybuffer') {
        const text = playlistText.get(context.url)
        text ? deliver(text) : fail('缩略图：没有这份清单')
        return
      }

      // 分片：主播放缓存优先，其次是我们自己刚下回来的那一片（见 fetchSeg）
      const hit = getSegBuf(context.url) ?? ownSegs.get(context.url)
      hit ? deliver(hit) : fail('缩略图：这一片没有数据')
    }
  }

  /**
   * 主播放当前这条流的分片表。**只读它、不请求它**：这份表是主播放解析清单时就有的，
   * 缩略图再取一遍清单既慢（慢源上一两秒）又可能撞防盗链，而且拿到的还是同一份东西。
   */
  const mainFrags = (): any[] => {
    try {
      const hls = getHls()
      const level = hls?.levels?.[hls.currentLevel >= 0 ? hls.currentLevel : (hls.firstLevel ?? 0)]
      return level?.details?.fragments ?? []
    } catch {
      return []
    }
  }

  /** 时间点落在哪一片上 */
  const fragAt = (t: number): any | null =>
    mainFrags().find(f => t >= f.start && t < f.start + f.duration) ?? null

  /**
   * 这一片的「片头一段」该取多少字节（见 HEAD_RATIO 上的说明）。
   * 码率从主播放的当前档位上读——它是清单里声明的值，起播那一刻就有。
   */
  const headBytes = (frag: any): number => {
    let bitrate = 0
    try {
      const hls = getHls()
      bitrate = hls?.levels?.[hls.currentLevel >= 0 ? hls.currentLevel : (hls.firstLevel ?? 0)]?.bitrate ?? 0
    } catch { /* 读不到就退回下限 */ }
    const segBytes = bitrate > 0 ? (bitrate / 8) * (frag.duration || 10) : 0
    return Math.min(HEAD_MAX, Math.max(HEAD_MIN, Math.round(segBytes * HEAD_RATIO)))
  }

  /**
   * 只含**一片**的迷你清单，拿 `blob:` 喂给解码器。
   *
   * 这样做的好处一次全占了：不请求真清单（省一发网络、绕开防盗链）、解码器只认识这一片
   *（不会自作主张往后预读）、分片 URL 直接用主播放那份（与分片缓存**同键**，命中率最高）。
   *
   * 加密流（`EXT-X-KEY`）这里**不处理**：密钥要另取一发网络，而且各站的 IV/METHOD 都要还原，
   * 为一张缩略图不值得。那种源上就是没有图——已经播过的位置仍有「白捡」那一路兜着。
   */
  const playlistText = new Map<string, string>()
  const blobUrls: string[] = []

  /**
   * 缩略图自己下回来的分片。**单独存，不塞进主播放的预取缓存**：那份缓存的容量是按
   * 「够播几秒」算的，塞进去会把播放头前面真正要用的分片挤出去（越缺越挤，正是抗卡最怕的）。
   * 这里只留最近几片——扫进度条时同一片会被反复用到，而更早的那些再也不会回头看。
   */
  const ownSegs = new Map<string, ArrayBuffer>()
  const OWN_SEGS_MAX = 3

  const keepSeg = (url: string, buf: ArrayBuffer) => {
    ownSegs.delete(url)
    ownSegs.set(url, buf)
    while (ownSegs.size > OWN_SEGS_MAX) ownSegs.delete(ownSegs.keys().next().value as string)
  }

  /** 在途的那一发。用户把鼠标挪到别的桶就当场掐掉——他已经不看那一张了 */
  let segCtrl: AbortController | null = null
  /** 哪些片手上只有开头那一段（解不出图时要拿整片再试一次） */
  const partialSegs = new Set<string>()

  /**
   * 取分片的**开头 `limit` 字节**（缓存里没有那一片时）。
   *
   * **连接方式完全照搬主播放**（`getProxyUrl` + `no-referrer`）：直连的源就直连，
   * 该注入防盗链头的才走 `/api/proxy`。曾经为了带 `Range` 把这一发**强行绕到代理**上，
   * 结果是每张缩略图都比直连慢一大截（实测 803KB 走代理要 9.76s，直连同样的片一秒出头）
   * ——省下来的那点流量远不抵多绕的那一圈。同形还有个附带好处：URL 与主播放一模一样，
   * 能吃到浏览器对它的 HTTP 缓存。
   *
   * 省流量改由**自己数着字节读、够了就 `abort`** 来做（`body.getReader()`，
   * 不是 `res.arrayBuffer()` —— 那是「读完为止」，实测撞到过 1.2MB / 7.8s）。
   * 这条路**不需要 `Range` 头**，也就绕开了「跨域直连加 Range 会触发 CORS 预检、
   * 而大量 CDN 不接」那个坑（CLAUDE.md 里「直连探测绝不能加 Range」是同一条）。
   *
   * 一张 240px 的缩略图要的就是一帧，而分片都以关键帧开头，前面这一段足够解出第一帧。
   * 截断处那半个帧 transmuxer 自己会丢掉。
   */
  const fetchSeg = async (url: string, limit: number): Promise<ArrayBuffer | null> => {
    segCtrl?.abort()
    const ctrl = new AbortController()
    segCtrl = ctrl
    try {
      // 请求与主播放**完全同形**：同一个 URL、同样不带 Referer、同样没有任何自定义头
      const res = await fetch(getProxyUrl(url), { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
      if (!res.ok || !res.body) return null

      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let got = 0
      while (got < limit) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.byteLength
      }
      // 读到了 done = 手上是完整的一片（limit 给 Infinity 的那一档、或分片本来就比 limit 小）
      const complete = got < limit
      try { await reader.cancel() } catch { /* 已经读完了 */ }
      if (!complete) ctrl.abort()      // 真正止住流量的就是这一下（服务端还在发，我们把连接掐了）

      const buf = new Uint8Array(got)
      let off = 0
      for (const c of chunks) { buf.set(c, off); off += c.byteLength }
      complete ? partialSegs.delete(url) : partialSegs.add(url)
      keepSeg(url, buf.buffer)
      return buf.buffer
    } catch {
      return null      // 中止 / 网络失败：这一桶没有图，仅此而已
    } finally {
      if (segCtrl === ctrl) segCtrl = null
    }
  }

  const miniPlaylist = (frag: any): string | null => {
    if (!frag?.url) return null
    // 加密片：`decryptdata` 上挂着 METHOD/URI/IV。宁可保守判成加密（那一桶没图），
    // 也不要拼出一份缺 KEY 的清单——那会让解码器解出一堆噪声帧
    if (frag.decryptdata?.uri || frag.decryptdata?.key || frag.levelkeys) return null
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(frag.duration) || 10}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ]
    // fMP4（CMAF）的分片单独喂没用，必须带上 init 段
    const init = frag.initSegment?.url
    if (init) lines.push(`#EXT-X-MAP:URI="${init}"`)
    lines.push(`#EXTINF:${(frag.duration || 10).toFixed(3)},`, frag.url, '#EXT-X-ENDLIST')
    const text = lines.join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }))
    playlistText.set(url, text)
    blobUrls.push(url)
    return url
  }

  const ensureDecoder = async (): Promise<boolean> => {
    if (thumbHls && thumbVideo && decoderFor === videoUrl.value) return true
    // 建解码器本身不花网络了，但它要占一个解码器 + 一份 MediaSource。吃紧/离线时别添乱
    if (!mayFetch()) return false
    if (decoderFor && decoderFor !== videoUrl.value) disposeDecoder()   // 换集了，旧解码器作废
    if (thumbHls && thumbVideo) return true

    const { default: Hls } = await import('hls.js')
    if (!Hls.isSupported()) { unsupported.value = true; return false }

    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    // 挂进文档但完全不可见：部分浏览器对没挂进文档的 <video> 不给解码资源
    v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none'
    document.body.appendChild(v)

    const hls = new Hls({
      // 清单里只有一片，窗口给到能装下它就行，别跟主播放抢内存
      maxBufferLength: 2,
      maxMaxBufferLength: 4,
      autoStartLoad: true,
      // **给 `loader` 而不是只给 `fLoader`**：那份迷你清单也是从它这里交出去的
      loader: makeLoader(Hls),
    })
    // 缩略图解不出来不该在控制台刷屏，也绝不能影响主播放的任何判断
    hls.on(Hls.Events.ERROR, () => { /* 静默：失败就是这一桶没有图 */ })

    hls.attachMedia(v)
    HlsMod = Hls
    thumbHls = hls
    thumbVideo = v
    decoderFor = videoUrl.value
    loadedFragUrl = ''
    // 注意这里**不 loadSource**：装什么由 loadFrag 按悬浮位置现拼（见 miniPlaylist）
    return true
  }

  /**
   * 把「这一片」装进解码器。每换一片重新 `loadSource` 一份新的迷你清单——
   * 解码器实例是复用的（建一次要几十毫秒 + 一个 MediaSource），只换内容。
   */
  const loadFrag = async (frag: any): Promise<boolean> => {
    if (!await ensureDecoder()) return false
    if (loadedFragUrl === frag.url) return true
    const src = miniPlaylist(frag)
    if (!src) return false
    const hls = thumbHls
    const Hls = HlsMod
    if (!hls || !Hls) return false

    // 等这一片真的解完并进了 buffer 才敢 seek：光有 `loadedmetadata` 时数据还没到，
    // 那时 seek 会停在一个空位上，抓回来的是黑帧
    const ready = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { cleanup(); resolve(ok) }
      const onBuffered = () => done(true)
      const onErr = (_: unknown, data: any) => { if (data?.fatal) done(false) }
      // 数据已经在手上了，解不出来就是解不出来（截断得太狠）。**这里必须比 SEEK_TIMEOUT_MS 短**：
      // 加量阶梯要试三档，每档都等满 6 秒的话，一张图最坏要等小二十秒
      const timer = setTimeout(() => done(false), LOAD_TRY_MS)
      const cleanup = () => {
        clearTimeout(timer)
        hls.off(Hls.Events.FRAG_BUFFERED, onBuffered)
        hls.off(Hls.Events.ERROR, onErr)
      }
      hls.on(Hls.Events.FRAG_BUFFERED, onBuffered)
      hls.on(Hls.Events.ERROR, onErr)
    })

    hls.loadSource(src)
    loadedFragUrl = frag.url
    const ok = await ready
    if (!ok) loadedFragUrl = ''
    return ok
  }

  /**
   * seek 到 `t`（片内偏移）并抓一帧。
   *
   * **必须把目标钳进 `buffered` 里**：截断的分片只解得出开头一两秒，而我们要的桶中点
   * 往往落在片内第 5 秒——那个位置压根没有数据，`seeked` **永远不会来**，只能干等到超时，
   * 表现就是「分片明明下回来了、请求也 200，就是不出图」（踩过）。
   * 桶本来就是 10 秒粒度，退到已解出的那一段里抓，画面差几秒无所谓。
   */
  /** 等到元素真的有画面可抓（`FRAG_BUFFERED` 只说明数据进了 buffer，不代表解码器已经出帧） */
  const waitReady = (v: HTMLVideoElement) => new Promise<boolean>((resolve) => {
    if (v.readyState >= 2) { resolve(true); return }
    const ok = () => { cleanup(); resolve(true) }
    const timer = setTimeout(() => { cleanup(); resolve(false) }, LOAD_TRY_MS)
    const cleanup = () => { clearTimeout(timer); v.removeEventListener('loadeddata', ok) }
    v.addEventListener('loadeddata', ok)
  })

  const seekAndGrab = async (t: number): Promise<string> => {
    const el = thumbVideo
    if (!el) return ''
    if (!await waitReady(el)) return ''
    return grabAt(el, t)
  }

  const grabAt = (v: HTMLVideoElement, t: number): Promise<string> => new Promise(resolve => {
    let done = false
    const finish = (img: string) => { if (done) return; done = true; cleanup(); resolve(img) }
    /**
     * **`seeked` 不等于「新帧已经画出来了」**：seek 完成早于新帧落到元素上，当场抓会抓回上一帧
     * （解析页那个「跳到 120s 了却还是贴片的 1080p」就是同一个坑）。
     * `requestVideoFrameCallback` 正是「这一帧真的呈现了」的信号；没有它就退回一小段延时。
     */
    const shoot = () => {
      const rvfc = (v as any).requestVideoFrameCallback
      if (typeof rvfc === 'function') rvfc.call(v, () => finish(grab(v)))
      else setTimeout(() => finish(grab(v)), 120)
    }
    const onErr = () => finish('')
    const timer = setTimeout(() => finish(''), SEEK_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      v.removeEventListener('seeked', shoot)
      v.removeEventListener('error', onErr)
    }
    v.addEventListener('seeked', shoot)
    v.addEventListener('error', onErr)

    // 目标落进已缓冲区间：截断片只有开头那一小段，硬 seek 到中间就是永远等不到 seeked
    let target = t
    const br = v.buffered
    if (br.length) {
      let inRange = false
      for (let i = 0; i < br.length; i++) {
        if (t >= br.start(i) && t <= br.end(i) - 0.05) { inRange = true; break }
      }
      // 退到第一段的靠前位置（留 0.05s 余量，正好压在边界上时同样取不到帧）
      if (!inRange) target = Math.min(Math.max(br.start(0) + 0.05, 0), Math.max(br.end(0) - 0.05, 0))
    }

    // 目标就是当前位置时**浏览器不会派发 `seeked`**（起播位置恰好是 0 且截断片只剩开头时
    // 必然撞上），那就直接抓——画面本来就已经停在那一帧上了
    if (Math.abs(target - v.currentTime) < 0.02 && v.readyState >= 2) { shoot(); return }
    v.currentTime = target
  })

  /**
   * 解码队列深度 1、latest-wins：用户在进度条上扫过去会点名几十个桶，
   * 排队全解完等于把连接占死，而他只看得到最后停下的那一个。
   */
  let decoding = false
  let wanted = -1

  const decodeAt = async (bucket: number) => {
    wanted = bucket
    if (decoding) return
    decoding = true
    thumbPending.value = true
    try {
      while (wanted >= 0) {
        const b = wanted
        wanted = -1
        const cached = shots.get(b)
        if (cached) { if (bucketOf(hoverTime.value ?? -1) === b) thumbImage.value = cached; continue }
        // 取桶中点：桶边界正好压在分片边界上时，边界那一帧常常是黑的
        const at = b * BUCKET_SECS + BUCKET_SECS / 2
        const frag = fragAt(at)
        if (!frag) continue

        /**
         * 缓存里没有这一片时才去下，而且**要等指针真的停住**（`SETTLE_MS`）。
         *
         * 这道停留判据是「扫过进度条不该下载」和「拖到后面也要有图」之间唯一的分界：
         * 扫过去时每 10 秒一个桶，一趟点名几十个桶，逐个下等于把连接全占死（用户原话是「太慢了」）；
         * 而停在某个位置不动 = 他真的想看那里，这时候花一片的钱是值的。
         * 前方几十秒通常本来就在预取缓存里（那条路零延迟），要下的是更远的位置。
         */
        let ready = false
        if (getSegBuf(frag.url) || ownSegs.has(frag.url)) {
          ready = await loadFrag(frag)
        } else {
          if (!mayFetch()) continue                       // 缓冲吃紧/离线：一片都不下
          await new Promise(r => setTimeout(r, SETTLE_MS))
          // 这段时间里指针挪到别的桶了 → 那一桶才是他要的，这一片不下了
          if (wanted >= 0 || bucketOf(hoverTime.value ?? -1) !== b) continue

          /**
           * **一档一档加量，绝不直接退回整片**：第一档 30KB 解不出来，多半只是这个源的
           * 第一帧比它长一点，翻几倍就够了；而整片动辄 1~2MB，为一张缩略图下完既慢又浪费
           *（踩过：解不出就拉整片，实测 1.2MB / 7.8s）。三档都不行才认输——
           * 那基本是封装本身截断即废（fMP4），再往上加也没用。
           */
          // 两档：**按码率算出来的片头一段 → 不行就整片**。
          // 中间档没有意义——截断能不能解出帧是个「行/不行」的开关（取决于封装和 GOP 长度），
          // 不是「多给点就好」的连续量，多一档只是多叠一轮请求和等待
          for (const limit of [headBytes(frag), Infinity]) {
            if (!await fetchSeg(frag.url, limit)) break
            loadedFragUrl = ''                            // 数据换了，解码器要重新装一次
            if (await loadFrag(frag)) { ready = true; break }
            if (!partialSegs.has(frag.url)) break          // 手上已经是完整的一片，加量也没意义
          }
        }
        if (!ready) continue
        // 迷你清单里只有这一片，时间轴从 0 开始 → seek 的是**片内偏移**
        const img = await seekAndGrab(Math.max(0, at - frag.start))
        if (!img) continue
        remember(b, img)
        // 期间鼠标可能已经移开或移到别的桶了，只有还停在这一桶才换图
        if (bucketOf(hoverTime.value ?? -1) === b) thumbImage.value = img
      }
    } finally {
      decoding = false
      thumbPending.value = false
      armIdleDispose()
    }
  }

  // ── 悬浮入口 ──

  let debounce: ReturnType<typeof setTimeout> | null = null

  watch(hoverTime, t => {
    if (debounce) { clearTimeout(debounce); debounce = null }
    if (t == null) { thumbImage.value = ''; thumbPending.value = false; wanted = -1; armIdleDispose(); return }
    if (!thumbEnabled.value) return
    syncBatch()
    const b = bucketOf(t)
    const hit = shots.get(b)
    // 命中就当场换图，**不走防抖**：扫过进度条时绝大多数点都是命中，等 220ms 会一格一格地卡
    if (hit) { thumbImage.value = hit; thumbPending.value = false; return }
    thumbImage.value = ''
    debounce = setTimeout(() => decodeAt(b), HOVER_DEBOUNCE_MS)
  })

  // 后台标签页是内存回收首选对象（同 useSegmentCache 那条）：解码器立刻拆，缩略图本身留着
  const onVisibility = () => { if (document.visibilityState === 'hidden') disposeDecoder() }
  if (import.meta.client) document.addEventListener('visibilitychange', onVisibility)

  const disposeThumbnails = () => {
    if (debounce) clearTimeout(debounce)
    document.removeEventListener('visibilitychange', onVisibility)
    disposeDecoder()
    shots.clear()
    canvas = null
  }

  return { thumbImage, thumbPending, thumbEnabled, captureTick, disposeThumbnails }
}

export type VideoThumbnails = ReturnType<typeof useVideoThumbnails>
