import type HlsType from 'hls.js'
import type { useSegmentCache } from './useSegmentCache'

/**
 * HLS 自适应并行预取：
 *  - createHlsFragLoader：自定义 fLoader，命中预取缓存即时返回，miss 则 fetch
 *  - triggerAdaptivePrefetch：每次 FRAG_BUFFERED 后按缓冲健康度补预取
 *  - startOnePrefetch：完成 1 个补 1 个
 *
 * 通过 getHls/getVideoEl 惰性读取播放器实例（避免持有过期引用），
 * 缓存读写委托给 useSegmentCache。
 */
export interface HlsPrefetchOptions {
  getHls: () => HlsType | null
  getVideoEl: () => HTMLVideoElement | undefined
  getProxyUrl: (url: string) => string
  cache: ReturnType<typeof useSegmentCache>
  // 站点规则的 playbackConcurrency：作为并发「下限/手动兜底」（默认 3），引擎可按需再往上到 6
  getConcurrencyCap: () => number
  // 当前倍速（倍速越高需要越大带宽），默认 1
  getPlaybackRate?: () => number
}

export interface StrategySnapshot {
  perConnKBps: number   // 实测每连接速度
  segMbps: number       // 实测视频码率
  targetConn: number    // 当前目标并发
  maxFluentRate: number // 当前带宽最高可流畅倍速
}

const MAX_CONN = 6          // 浏览器同 host 连接上限（HTTP/1.1）
const SAFETY = 1.3          // 带宽安全系数

export function useHlsPrefetch(opts: HlsPrefetchOptions) {
  const { getProxyUrl, cache, getConcurrencyCap } = opts
  const getPlaybackRate = opts.getPlaybackRate ?? (() => 1)
  const {
    segPrefetchCache, segPrefetching, segPrefetchAborts,
    prefetchInfo, getPrefetchedBuf, evictPrefetchCache,
  } = cache

  // ── 实测采样（EWMA）：每连接速度 + 视频码率，驱动动态并发 ──
  let perConnBps = 0   // 实测每连接速度（bps）
  let segBitrate = 0   // 实测视频码率（bps）
  const ewma = (prev: number, cur: number) => (prev ? prev * 0.7 + cur * 0.3 : cur)
  const sampleSpeed = (bytes: number, ms: number) => {
    // 只采样真实网络传输：过滤缓存命中（极快）、过小分片、离谱值，避免污染实测
    if (bytes < 100_000 || ms < 50) return
    const bps = (bytes * 8) / (ms / 1000)
    if (bps > 500_000_000) return   // >500Mbps 基本是缓存/异常，丢弃
    perConnBps = ewma(perConnBps, bps)
  }
  const sampleBitrate = (bytes: number, sec: number) => {
    if (bytes > 0 && sec > 0) segBitrate = ewma(segBitrate, (bytes * 8) / sec)
  }

  // ── 可持续倍速：直接看缓冲的增长/消失速度（最直接、最跟手）──
  // 以倍速 R 播放、前向缓冲每墙钟秒变化 Δ 秒，则每墙钟秒实际"下载"了 (R+Δ) 秒视频，
  // 即当前可持续倍速 = R + Δ。Δ<0（缓冲在掉）说明追不上，可持续倍速 < 当前倍速。
  let growthEwma = 0        // 缓冲增长率（秒/秒），快速 EWMA
  let lastGrowthAhead = -1  // 上次采样的前向缓冲
  let lastGrowthT = 0       // 上次采样墙钟时间
  const resetGrowth = () => { growthEwma = 0; lastGrowthAhead = -1; lastGrowthT = 0 }
  const updateGrowth = (ahead: number) => {
    const now = performance.now()
    if (lastGrowthAhead < 0) { lastGrowthAhead = ahead; lastGrowthT = now; return }
    const dt = (now - lastGrowthT) / 1000
    if (dt < 0.5) return
    const rate = (ahead - lastGrowthAhead) / dt
    lastGrowthAhead = ahead
    lastGrowthT = now
    if (Math.abs(rate) > 10) return          // seek 等跳变，跳过不污染
    growthEwma = growthEwma ? growthEwma * 0.5 + rate * 0.5 : rate  // 0.5 权重：跟手
  }

  const strategy = ref<StrategySnapshot>({ perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0 })

  // 并发上限：默认单 host 6；多 CDN（分片跨多个 host）时按 host 数放宽（每 host 6，封顶 12）
  let hostConcurrencyCap = MAX_CONN

  // 闭环控制状态：以「缓冲是否在掉」为反馈调并发，比开环测速更抗卡顿、天然适配倍速
  let ctrlConn = 0       // 当前受控并发（0=未初始化）
  let lastAhead = -1     // 上次的前向缓冲秒数

  // 切换视频/CDN 时重置实测与控制器，避免用上个流的数据误判新流
  const resetStrategy = () => {
    perConnBps = 0
    segBitrate = 0
    hostConcurrencyCap = MAX_CONN
    ctrlConn = 0
    lastAhead = -1
    resetGrowth()
    strategy.value = { perConnKBps: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0 }
  }

  // 实测驱动的目标并发：需要带宽 = 码率 × 倍速 × 安全系数；并发 = ⌈需要 / 每连接速度⌉
  const computeTargetConcurrency = (): number => {
    const floor = Math.max(1, getConcurrencyCap())
    if (!perConnBps || !segBitrate) return Math.min(hostConcurrencyCap, Math.max(floor, 4))  // 冷启动：乐观
    const required = segBitrate * getPlaybackRate() * SAFETY
    const need = Math.ceil(required / perConnBps)
    return Math.min(hostConcurrencyCap, Math.max(2, need, floor))
  }

  // 刷新对外策略快照（供 UI 展示与倍速可行性判断）
  const refreshStrategy = (targetConn: number) => {
    // 可持续倍速 = 当前倍速 + 缓冲增长率，留 0.15x 安全余量；至少 1x
    const sustainable = lastGrowthAhead < 0
      ? 0
      : Math.max(1, Math.round((getPlaybackRate() + growthEwma - 0.15) * 10) / 10)
    strategy.value = {
      perConnKBps: Math.round(perConnBps / 8 / 1024),
      segMbps: Math.round((segBitrate / 1e6) * 10) / 10,
      targetConn,
      maxFluentRate: sustainable,
    }
  }

  // 计算当前播放位置前方的缓冲秒数
  const getAheadBuffered = (video: HTMLVideoElement): number => {
    const ct = video.currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= ct + 0.1 && ct <= video.buffered.end(i)) {
        return video.buffered.end(i) - ct
      }
    }
    return 0
  }

  // 闭环控制步进：按缓冲趋势调整受控并发（每分片缓冲事件调用一次，节奏 ~每几秒）
  //   濒临卡顿 → 直接拉满；偏低或正在掉 → +1；很充足 → −1（省带宽）；中间维持。
  const stepControl = (bufferSecs: number) => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()   // 冷启动用实测估算作初值
    const drained = lastAhead >= 0 && bufferSecs < lastAhead - 0.5
    lastAhead = bufferSecs
    if (bufferSecs < 15) ctrlConn = hostConcurrencyCap                                   // 濒临卡顿：拉满
    else if (bufferSecs < 45 || drained) ctrlConn = Math.min(hostConcurrencyCap, ctrlConn + 1) // 偏低/在掉：加
    else if (bufferSecs > 180) ctrlConn = Math.max(2, ctrlConn - 1)                      // 很充足：省
    // 45–180 且未在掉：维持
  }

  // 返回当前目标并发（受控值，双重钳制在 [2, hostCap]）。只读，供两个预取入口共用。
  const getAdaptivePrefetchCount = (_bufferSecs?: number): number => {
    if (ctrlConn === 0) ctrlConn = computeTargetConcurrency()
    const target = Math.min(hostConcurrencyCap, Math.max(2, ctrlConn))
    refreshStrategy(target)
    return target
  }

  // 预取"触达距离"（秒）：缓冲不足时只预取播放头附近的分片，把带宽/连接集中在紧邻分片上，
  // 不去抢跑更远的分片（否则共享带宽会拖慢当前急需的那几个）；缓冲越充足才往更远预读。
  const CRITICAL_LEAD = 20
  const prefetchReachSec = (bufferSecs: number) => Math.max(CRITICAL_LEAD, bufferSecs * 1.5)

  // 创建自定义 HLS 分片加载器（fLoader）
  // 优先从预取缓存返回数据，cache miss 时走 fetch 正常加载
  const createHlsFragLoader = () => {
    return class PrefetchFragLoader {
      context: any
      // hls.js 在创建 loader 实例后立刻执行 frag.stats = loader.stats，
      // 时机早于 load() 调用。若此处不提前初始化，frag.stats 会是 undefined，
      // AbrController 的 setInterval 轮询时读 frag.stats.loading 直接崩溃。
      stats: any = {
        aborted: false, loaded: 0, total: 0,
        retry: 0, chunkCount: 0, bwEstimate: 0,
        loading:   { start: 0, first: 0, end: 0 },
        parsing:   { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      private ctrl: AbortController | null = null

      load(context: any, config: any, callbacks: any): void {
        this.context = context
        const url: string = context.url
        const t0 = performance.now()

        // 重置 stats 字段（必须原地修改，不能替换整个对象）
        // frag.stats 持有的是同一个对象引用，替换会导致 frag.stats 仍指向旧的 undefined
        this.stats.aborted = false
        this.stats.loaded = 0
        this.stats.total = 0
        this.stats.retry = 0
        this.stats.chunkCount = 0
        this.stats.bwEstimate = 0
        this.stats.loading.start = t0
        this.stats.loading.first = 0
        this.stats.loading.end   = 0
        this.stats.parsing.start = 0
        this.stats.parsing.end   = 0
        this.stats.buffering.start = 0
        this.stats.buffering.first = 0
        this.stats.buffering.end   = 0

        const succeed = (data: ArrayBuffer) => {
          // seek/换源后 hls.js 会 abort 旧 loader；此时再回调 onSuccess
          // 会污染 hls.js 的内部状态，让播放卡住几十秒。必须在这里短路。
          if (this.stats.aborted) return
          const t1 = performance.now()
          this.stats.loaded = data.byteLength
          this.stats.total  = data.byteLength
          this.stats.chunkCount = 1
          if (!this.stats.loading.first) this.stats.loading.first = t0 + 1
          this.stats.loading.end = t1
          callbacks.onSuccess({ data, url }, this.stats, context)
        }

        const fail = (e: Error) => {
          if (this.stats.aborted) return
          this.stats.loading.end = performance.now()
          callbacks.onError({ code: 0, text: e.message }, context, null, this.stats)
        }

        // 1. 命中预取缓存（且未过期）→ 即时返回，并刷新 LRU 顺序与访问时间
        const cachedBuf = getPrefetchedBuf(url)
        if (cachedBuf) {
          segPrefetchCache.delete(url)
          segPrefetchCache.set(url, { buf: cachedBuf, ts: Date.now() })
          prefetchInfo.value.cached = segPrefetchCache.size
          succeed(cachedBuf)
          return
        }

        // 2. 正在预取中 → 等待 Promise，完成后也存入缓存
        if (segPrefetching.has(url)) {
          segPrefetching.get(url)!
            .then(buf => {
              if (this.stats.aborted) return
              if (buf.byteLength > 0) {
                succeed(buf)
              } else {
                this.doFetch(url, config, succeed, fail)
              }
            })
            .catch(() => {
              if (this.stats.aborted) return
              this.doFetch(url, config, succeed, fail)
            })
          return
        }

        // 3. 普通加载
        this.doFetch(url, config, succeed, fail)
      }

      private doFetch(url: string, config: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void, attempt = 0) {
        if (this.stats.aborted) return   // seek/换源后不再发起（含重试路径）

        // 去重：若同一分片已在预取/加载中，复用其结果，绝不重复下载
        const inflight = segPrefetching.get(url)
        if (inflight) {
          inflight
            .then(buf => { if (this.stats.aborted) return; buf.byteLength > 0 ? succeed(buf) : this.rawFetch(url, config, succeed, fail, attempt) })
            .catch(() => { if (!this.stats.aborted) this.rawFetch(url, config, succeed, fail, attempt) })
          return
        }
        this.rawFetch(url, config, succeed, fail, attempt)
      }

      // 真正发起网络请求：登记为在途（供去重）+ 成功后写入缓存（避免同分片再次下载）
      private rawFetch(url: string, config: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void, attempt = 0) {
        if (this.stats.aborted) return
        this.ctrl = new AbortController()
        const timeout = config?.timeout ?? 30000
        const timer = setTimeout(() => this.ctrl?.abort(), timeout)
        const MAX_RETRY = 2   // cache-miss 时最多重试 2 次，避免偶发 502 直接触发 hls.js fatal
        const fStart = performance.now()

        const tracked = fetch(getProxyUrl(url), { signal: this.ctrl.signal })
          .then(r => {
            clearTimeout(timer)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            this.stats.loading.first = performance.now()   // 首字节时间
            return r.arrayBuffer()
          })
          .then(buf => {
            sampleSpeed(buf.byteLength, performance.now() - fStart)
            segPrefetchCache.set(url, { buf, ts: Date.now() })   // 存缓存，后续命中不再下载
            segPrefetching.delete(url)
            prefetchInfo.value.cached = segPrefetchCache.size
            prefetchInfo.value.pending = segPrefetching.size
            evictPrefetchCache()
            return buf
          })
          .catch(e => { clearTimeout(timer); segPrefetching.delete(url); throw e })

        segPrefetching.set(url, tracked)   // 登记在途，prefetch/其他 loader 复用而非重复下载

        tracked
          .then(buf => { if (!this.stats.aborted) succeed(buf) })
          .catch(e => {
            if (this.stats.aborted || e?.name === 'AbortError') return
            if (attempt < MAX_RETRY) {
              setTimeout(() => this.doFetch(url, config, succeed, fail, attempt + 1), 300 * 2 ** attempt)
              return
            }
            fail(e instanceof Error ? e : new Error(String(e)))
          })
      }

      abort(): void {
        this.ctrl?.abort()
        if (this.stats) this.stats.aborted = true
      }
      destroy(): void { this.abort() }
    }
  }

  // 发起一个分片预取请求（带 1 次轻量重试，减少「空洞」导致的临播卡顿）
  // durationSec = 该分片代表的视频秒数，用于实测码率
  const spawnPrefetch = (url: string, durationSec: number, onDone: () => void) => {
    const attemptFetch = (attempt: number): Promise<ArrayBuffer> => {
      const ctrl = new AbortController()
      segPrefetchAborts.set(url, ctrl)
      const aStart = performance.now()
      return fetch(getProxyUrl(url), { signal: ctrl.signal })
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(buf => { sampleSpeed(buf.byteLength, performance.now() - aStart); return buf })
        .catch(e => {
          if (e?.name === 'AbortError' || attempt >= 1) throw e
          return new Promise<ArrayBuffer>((resolve, reject) => {
            setTimeout(() => {
              // seek 后 abortAllPrefetches 会清空 segPrefetching；此时不再重试，避免占用连接池
              if (!segPrefetching.has(url)) { reject(new DOMException('aborted', 'AbortError')); return }
              attemptFetch(attempt + 1).then(resolve, reject)
            }, 400)
          })
        })
    }
    const promise = attemptFetch(0)
      .then(buf => {
        sampleBitrate(buf.byteLength, durationSec)   // 实测视频码率
        segPrefetchAborts.delete(url)
        segPrefetchCache.set(url, { buf, ts: Date.now() })
        segPrefetching.delete(url)
        prefetchInfo.value.cached = segPrefetchCache.size
        prefetchInfo.value.pending = segPrefetching.size
        evictPrefetchCache()
        onDone()
        return buf
      })
      .catch(() => {
        segPrefetchAborts.delete(url)
        segPrefetching.delete(url)
        prefetchInfo.value.pending = segPrefetching.size
        return new ArrayBuffer(0)
      })
    segPrefetching.set(url, promise)
  }

  // 触发自适应预取（每次 FRAG_BUFFERED 后调用）
  const triggerAdaptivePrefetch = (lastFragSn: number) => {
    const hls = opts.getHls()
    const video = opts.getVideoEl()
    if (!hls || !video) return

    // 取当前画质的分片列表
    const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
    const levelDetails = (hls as any).levels?.[level]?.details
    if (!levelDetails) return

    const frags: any[] = levelDetails.fragments
    const startIdx = frags.findIndex((f: any) => f.sn === lastFragSn) + 1
    if (startIdx <= 0) return

    // 探测未来分片的 host 分布：多 CDN 时放宽并发上限（每 host 6 连接，封顶 12）
    const lookahead = frags.slice(startIdx, startIdx + 24)
    const hosts = new Set<string>()
    for (const f of lookahead) { try { hosts.add(new URL(f.url).host) } catch {} }
    hostConcurrencyCap = Math.min(12, Math.max(1, hosts.size) * MAX_CONN)

    // 用 getAheadBuffered 拿"当前播放位置往后"的缓冲秒数，避免多缓冲段时取错
    const bufferSecs = getAheadBuffered(video)
    stepControl(bufferSecs)                       // 闭环：按缓冲趋势调整并发
    const count = getAdaptivePrefetchCount(bufferSecs)

    prefetchInfo.value = {
      bufferSecs: Math.round(bufferSecs * 10) / 10,
      threads: count,
      cached: segPrefetchCache.size,
      pending: segPrefetching.size,
    }

    if (count === 0) return

    // 计算还能发起几个新请求（不超过并发上限）
    const canStart = Math.max(0, count - segPrefetching.size)
    if (canStart === 0) return

    // 候选窗口：从 startIdx 往后扫描，最多看 count*3 个，足以跳过已缓存/下载中的
    const candidates = frags.slice(startIdx, startIdx + count * 3)
    const reachEnd = video.currentTime + prefetchReachSec(bufferSecs)  // 触达距离：缓冲不足只预取附近

    let started = 0
    for (const frag of candidates) {
      if (started >= canStart) break
      if (frag.start > reachEnd) break  // 超出触达距离的远处分片先不下，集中带宽给近处
      const url: string = frag.url
      if (!url || getPrefetchedBuf(url) !== null || segPrefetching.has(url)) continue
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      started++
    }

    prefetchInfo.value.pending = segPrefetching.size

    // 按内存上限 LRU 淘汰（在新分片加入后检查）
    evictPrefetchCache()
  }

  // 完成1个分片后补充1个，基于当前播放进度定位下一个未下载分片
  const startOnePrefetch = () => {
    const hls = opts.getHls()
    const video = opts.getVideoEl()
    if (!hls || !video) return
    const bufferSecs = getAheadBuffered(video)
    const count = getAdaptivePrefetchCount(bufferSecs)

    prefetchInfo.value.bufferSecs = Math.round(bufferSecs * 10) / 10
    prefetchInfo.value.threads = count
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.pending = segPrefetching.size

    if (count === 0 || segPrefetching.size >= count) return

    const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = (hls as any).levels?.[level]?.details?.fragments ?? []
    if (!frags.length) return

    // 从当前播放时间往后找第一个未缓存、未下载中的分片
    const currentTime = video.currentTime
    const reachEnd = currentTime + prefetchReachSec(bufferSecs)  // 触达距离：缓冲不足只预取附近
    for (const frag of frags) {
      if (frag.start < currentTime) continue
      if (frag.start > reachEnd) break  // 超出触达距离先不下，集中带宽给近处分片
      const url: string = frag.url
      if (!url || getPrefetchedBuf(url) !== null || segPrefetching.has(url)) continue
      spawnPrefetch(url, frag.duration ?? 0, startOnePrefetch)
      prefetchInfo.value.pending = segPrefetching.size
      break  // 只补1个
    }
  }

  // 实时心跳：由定时器/视频事件驱动（不依赖 FRAG_BUFFERED，避免卡顿时停更）。
  // 刷新缓冲读数、跑闭环控制、把在途预取补足到目标并发。
  const tick = () => {
    const video = opts.getVideoEl()
    if (!video) return
    const bufferSecs = getAheadBuffered(video)
    updateGrowth(bufferSecs)               // 按固定 1s 节奏更新缓冲增长率 → 可持续倍速
    stepControl(bufferSecs)
    const count = getAdaptivePrefetchCount(bufferSecs)
    prefetchInfo.value.bufferSecs = Math.round(bufferSecs * 10) / 10
    prefetchInfo.value.threads = count
    prefetchInfo.value.cached = segPrefetchCache.size
    prefetchInfo.value.pending = segPrefetching.size
    // 补足到目标并发（startOnePrefetch 同步占位，循环安全）
    let guard = 0
    while (segPrefetching.size < count && guard++ < count) {
      const before = segPrefetching.size
      startOnePrefetch()
      if (segPrefetching.size === before) break   // 没有可补的分片了
    }
  }

  // 起播预热：playlist 就绪后立刻并行预取前若干分片，
  // 让分片 1..N 与 hls.js 加载分片 0 同时进行，避免"首片单连接"拖慢起播。
  const primePrefetch = () => {
    const count = getAdaptivePrefetchCount()
    let guard = 0
    while (segPrefetching.size < count && guard++ < count) {
      const before = segPrefetching.size
      startOnePrefetch()
      if (segPrefetching.size === before) break
    }
  }

  return { getAheadBuffered, getAdaptivePrefetchCount, createHlsFragLoader, triggerAdaptivePrefetch, startOnePrefetch, strategy, resetStrategy, tick, primePrefetch }
}
