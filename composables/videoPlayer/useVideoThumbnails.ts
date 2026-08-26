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
 *   ② 悬浮到没截过的位置，才起一个隐藏解码器去解那一片，而且**先吃主播放已经下过的分片**
 *      （`getSegBuf`，预取缓存里那几十秒都算），真 miss 才下，且缓冲吃紧/濒卡/离线时整块让路。
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
/** 解一帧的耐心。超了就放弃这一桶——缩略图没有比播放更重要 */
const SEEK_TIMEOUT_MS = 6000
/** 离开进度条这么久就把解码器拆掉：一个 MediaSource + 解码器不算小，留着白占 */
const IDLE_DISPOSE_MS = 30_000
const JPEG_Q = 0.62

export interface VideoThumbnailsDeps {
  media: VideoMediaState
  /** 主播放已经下过的分片（预取缓存 + 播过的都在里面）→ 命中即零网络 */
  getSegBuf: (url: string) => ArrayBuffer | null
  /** 必须跟主播放**完全一致**的连接配置：清单地址不一致，分片 URL 就对不上缓存，还多半 403 */
  getProxyUrl: (url: string) => string
  /** 缓冲健康区。吃紧/濒卡时一片都不许为缩略图下 */
  healthZone: () => string
}

export function useVideoThumbnails(deps: VideoThumbnailsDeps) {
  const { media, getSegBuf, getProxyUrl, healthZone } = deps
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
  let decoderFor = ''          // 解码器当前装的是哪个地址
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
  }

  const armIdleDispose = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(disposeDecoder, IDLE_DISPOSE_MS)
  }

  /** 两道闸：缓冲吃紧一律让路（缩略图永远不该是画面卡住的原因），没网就别白试 */
  const mayFetch = () => {
    const z = healthZone()
    return z !== 'panic' && z !== 'low' && !isOffline()
  }

  /**
   * 缩略图专用 loader（清单 / 密钥 / 分片**全都走它**）：命中主播放的分片缓存就直接交货，
   * miss 才自己下，而且下的方式必须跟主播放**完全同形**。
   *
   * 踩过：miss 时直接 `super.load()` 交给 hls.js 默认的 XHR loader，结果分片一律 **403**
   *（缩略图空白，Network 里那一条写着 `strict-origin-when-cross-origin`）。两个原因缺一不可：
   *   · **XHR 发得出 Referer**，而这些 CDN 认防盗链 —— 主播放那条路是
   *     `fetch(..., { referrerPolicy: 'no-referrer' })`，从来不带；
   *   · **没过连接策略**：该走 `/api/proxy` 注入 Origin/Referer 的源，直连必然被拒。
   * 所以这里自己 `fetch`：先 `getProxyUrl`（幂等，已经是代理地址就原样返回）、再 `no-referrer`。
   * 这也顺带让缩略图能吃到浏览器对主播放那些分片的 HTTP 缓存 —— 两边 URL 一模一样。
   *
   * 回调里的 `url` 用 **`res.url`（重定向后的最终地址）**：hls.js 拿它当基准还原相对分片 URI，
   * 传原始地址的话，一旦清单 302 到别的 host/端口，解出来的分片地址全是错的（CLAUDE.md 里那条）。
   *
   * **交货必须延到下一个宏任务**——跟主播放那份 fLoader 是同一个坑（见 prefetch/fragLoader.ts
   * 里那段长注释）：hls.js 在 `load()` **返回之后**才把这一片记成「在加载中」，
   * 同步回调等于在它记账之前把结果交出去，那一片被当成无主的丢掉，而它永远停在「还在等」。
   */
  const makeLoader = (Hls: any) => class ThumbLoader extends (Hls.DefaultConfig.loader as any) {
    thumbAbort: AbortController | null = null

    load(context: any, config: any, callbacks: any) {
      // 分片要的是二进制，清单要的是文本。这个 loader 三种请求都接，按它分流
      const isSeg = context.responseType === 'arraybuffer'
      this.context = context
      this.stats.loading.start = performance.now()

      const hit = isSeg ? getSegBuf(context.url) : null
      if (hit) {
        setTimeout(() => {
          if (this.stats.aborted) return
          this.stats.loaded = this.stats.total = hit.byteLength
          this.stats.chunkCount = 1
          this.stats.loading.first = this.stats.loading.end = performance.now()
          callbacks.onSuccess({ data: hit, url: context.url }, this.stats, context)
        }, 0)
        return
      }

      // 让路只拦分片：清单和密钥各只有一发、几 KB，拦掉它们等于整个解码器建不起来
      if (isSeg && !mayFetch()) {
        setTimeout(() => callbacks.onError({ code: 0, text: '缩略图让路：缓冲吃紧' }, context, null, this.stats), 0)
        return
      }

      const ctrl = new AbortController()
      this.thumbAbort = ctrl
      let finalUrl = context.url
      fetch(getProxyUrl(context.url), { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          finalUrl = res.url || context.url
          return isSeg ? res.arrayBuffer() : res.text()
        })
        .then((data: ArrayBuffer | string) => {
          if (this.stats.aborted) return
          const len = typeof data === 'string' ? data.length : data.byteLength
          this.stats.loaded = this.stats.total = len
          this.stats.chunkCount = 1
          this.stats.loading.first = this.stats.loading.end = performance.now()
          callbacks.onSuccess({ data, url: finalUrl }, this.stats, context)
        })
        .catch((e: any) => {
          // 中止是我们自己干的（换桶/拆解码器），不是失败，报上去只会让 hls.js 走一轮重试
          if (this.stats.aborted || ctrl.signal.aborted) return
          callbacks.onError({ code: 0, text: '缩略图取片失败：' + (e?.message || e) }, context, null, this.stats)
        })
    }

    abort() {
      try { this.thumbAbort?.abort() } catch { /* 已经中止过 */ }
      super.abort()
    }

    destroy() {
      try { this.thumbAbort?.abort() } catch { /* 同上 */ }
      super.destroy()
    }
  }

  const ensureDecoder = async (): Promise<boolean> => {
    if (thumbHls && thumbVideo && decoderFor === videoUrl.value) return true
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
      // 只为抽一帧，窗口开到最小，别跟主播放抢内存
      maxBufferLength: 2,
      maxMaxBufferLength: 4,
      // 自动起播会白下一串分片；我们只在 seek 那一刻要一片
      autoStartLoad: true,
      // **给 `loader` 而不是只给 `fLoader`**：清单和 AES 密钥走的也是它。
      // 只换分片那一个的话，另外两种请求仍是默认 XHR（带 Referer、不过连接策略），
      // 防盗链的源上表现是「分片明明能下，却卡在清单或密钥的 403 上，一张图都出不来」
      loader: makeLoader(Hls),
    })
    // 多档流一律锁最低码率那档：缩略图 240px 宽，拿高码率那档纯属白花带宽
    hls.on(Hls.Events.MANIFEST_PARSED, (_: unknown, data: any) => {
      const levels: any[] = data?.levels ?? []
      if (levels.length > 1) {
        let lo = 0
        for (let i = 1; i < levels.length; i++) if ((levels[i].bitrate ?? 0) < (levels[lo].bitrate ?? 0)) lo = i
        hls.currentLevel = lo
      }
    })
    // 缩略图解不出来不该在控制台刷屏，也绝不能影响主播放的任何判断
    hls.on(Hls.Events.ERROR, () => { /* 静默：失败就是这一桶没有图 */ })

    hls.attachMedia(v)
    hls.loadSource(getProxyUrl(videoUrl.value))
    thumbHls = hls
    thumbVideo = v
    decoderFor = videoUrl.value

    // 等到能 seek 为止（拿不到元数据就没有 duration，seek 无从下手）
    const ready = await new Promise<boolean>(resolve => {
      const ok = () => { cleanup(); resolve(true) }
      const timer = setTimeout(() => { cleanup(); resolve(false) }, SEEK_TIMEOUT_MS)
      const cleanup = () => { clearTimeout(timer); v.removeEventListener('loadedmetadata', ok) }
      if (v.readyState >= 1) { clearTimeout(timer); resolve(true); return }
      v.addEventListener('loadedmetadata', ok)
    })
    if (!ready) { disposeDecoder(); return false }
    return true
  }

  const seekAndGrab = (t: number): Promise<string> => new Promise(resolve => {
    const v = thumbVideo
    if (!v) { resolve(''); return }
    let done = false
    const finish = (img: string) => { if (done) return; done = true; cleanup(); resolve(img) }
    /**
     * **`seeked` 不等于「新帧已经画出来了」**：seek 完成早于新帧落到元素上，当场抓会抓回上一帧
     * （解析页那个「跳到 120s 了却还是贴片的 1080p」就是同一个坑）。
     * `requestVideoFrameCallback` 正是「这一帧真的呈现了」的信号；没有它就退回一小段延时。
     */
    const onSeeked = () => {
      const rvfc = (v as any).requestVideoFrameCallback
      if (typeof rvfc === 'function') rvfc.call(v, () => finish(grab(v)))
      else setTimeout(() => finish(grab(v)), 120)
    }
    const onErr = () => finish('')
    const timer = setTimeout(() => finish(''), SEEK_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('error', onErr)
    }
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('error', onErr)
    v.currentTime = t
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
        if (!await ensureDecoder()) break
        // 取桶中点：桶边界正好压在分片边界上时，边界那一帧常常是黑的
        const img = await seekAndGrab(b * BUCKET_SECS + BUCKET_SECS / 2)
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
