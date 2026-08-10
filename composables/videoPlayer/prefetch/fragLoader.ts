/**
 * hls.js 的自定义分片加载器（`fLoader`）。
 *
 * 两件事：命中预取缓存就**同步**返回（零网络等待），miss 就走「对冲竞速 + 硬超时跳片」——
 * 这一片是 hls.js 正在等的关键分片，直接决定能不能播下去，所以它可以抢连接，
 * **不受「存货不够就少开线程」那条预取上限约束**（见 useHlsPrefetch 的 SAFE_WALL_SECS）。
 *
 * 从 useHlsPrefetch 拆出来单独放：它是一整个类 + 一套竞速状态机，跟「预取哪一片」的调度逻辑
 * 只通过下面这组依赖打交道。内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import type { TierParams } from '../../videoSiteRules'
import type { LaneControl } from './lanes'
import type { useSegmentCache } from '../useSegmentCache'

export interface FragLoaderDeps {
  cache: ReturnType<typeof useSegmentCache>
  lanes: LaneControl
  /** 当前档位参数：对冲延迟 hedgeMs / 跳片超时 skipMs / 竞速上限 maxRacers */
  tier: () => TierParams
  /** 采样一次下载速度（喂带宽模型） */
  sampleSpeed: (bytes: number, ms: number, concurrency?: number) => void
  /** 在途下载计时表（诊断「哪个分片卡住、下了多久」），与预取共用同一份 */
  segInflightStart: Map<string, number>
  /** 关键分片久拿不到 → 把播放头挪过去，返回是否真的跳了 */
  skipSegment: (frag: any) => boolean
}

export function createFragLoaderFactory(deps: FragLoaderDeps) {
  const { segPrefetchCache, segPrefetching, prefetchInfo, getPrefetchedBuf, evictPrefetchCache } = deps.cache
  const { acquireLane, releaseLane, markLaneOk, markLaneFail } = deps.lanes
  const { tier, sampleSpeed, segInflightStart, skipSegment } = deps

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

        // 2 & 3. 关键分片（hls.js 正在等的这片，直接决定能不能播）→ 限时保障加载：
        //   对冲竞速（换连接绕开死连接）+ 硬超时跳过（绝不整段冻结）。见 hedgedLoad。
        this.hedgedLoad(url, context, succeed, fail)
      }

      // 关键分片加载：一条不行就再起一条并行抢，谁先回用谁；久拿不到就跳过。
      //   · 已有预取在途 → 先让它参与竞速（不新开连接），但只等 hedgeMs，不无限等死连接；
      //   · 每 hedgeMs 追加一条新连接并行竞速（对冲单条死连接）；单条失败立刻换一条重试；
      //   · skipMs 仍拿不到 → 跳过该片（挪播放头到下一片），避免多分钟冻结。（超时值取自当前档位）
      private hedgedLoad(url: string, context: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void) {
        if (this.stats.aborted) return
        let settled = false
        let racers = 0
        const ctrls: AbortController[] = []
        const timers: ReturnType<typeof setTimeout>[] = []
        const cleanup = () => {
          timers.forEach(clearTimeout)
          ctrls.forEach(c => { try { c.abort() } catch {} })
          segInflightStart.delete(url)
        }
        this._cancelHedge = () => { if (!settled) { settled = true; cleanup() } }

        const win = (buf: ArrayBuffer) => {
          if (settled || this.stats.aborted) return
          settled = true
          cleanup()
          segPrefetchCache.set(url, { buf, ts: Date.now() })   // 存缓存，后续命中不再下载
          segPrefetching.delete(url)
          prefetchInfo.value.cached = segPrefetchCache.size
          prefetchInfo.value.pending = segPrefetching.size
          evictPrefetchCache()
          if (!this.stats.loading.first) this.stats.loading.first = performance.now()
          succeed(buf)
        }

        const tp = tier()   // 本次加载用当前档位的对冲/跳片超时（hedgeMs/skipMs/maxRacers）
        // 起一条新竞速连接（换 lane、换连接，绕开卡死的那条）
        const race = () => {
          if (settled || this.stats.aborted || racers >= tp.maxRacers) return
          racers++
          const ctrl = new AbortController(); ctrls.push(ctrl)
          const { lane, laneUrl, laneCount } = acquireLane(url)
          const t = performance.now()
          if (!segInflightStart.has(url)) segInflightStart.set(url, t)   // 计时：登记在途（诊断用）
          const conc = racers   // 采样时的并发（竞速条数），供聚合可并行探针分档
          fetch(laneUrl, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); if (!this.stats.loading.first) this.stats.loading.first = performance.now(); return r.arrayBuffer() })
            .then(buf => { releaseLane(lane); markLaneOk(lane); sampleSpeed(buf.byteLength, performance.now() - t, conc); win(buf) })
            .catch(() => {
              releaseLane(lane)
              // 主动取消（竞速已有赢家 / seek）不算这条 lane 的账
              if (!ctrl.signal.aborted) markLaneFail(lane, laneCount)
              if (!settled && !this.stats.aborted) timers.push(setTimeout(race, 500))   // 这条失败 → 快速换一条
            })
        }

        // 已有预取在途：先让它竞速（省一条连接），但别无限等——hedgeMs 后照常追加新连接抢。
        //
        // **搭的车翻了必须当场自己上**（原来这里没有 else，是「有缓存却卡两三秒」的真凶）：
        // `spawnPrefetch` 失败时 resolve 的是**空 ArrayBuffer**（不是 reject），于是 `byteLength > 0`
        // 不成立、`catch` 也不触发，整个回调静默地什么都不做，只能等下面那个 `setTimeout(race, hedgeMs)`
        // ——差档 3s、中档 5s。而**拖进度恰好会批量制造这种失败**：`onSeeked` 先 `abortAllPrefetches()`
        // 把在途预取全中止（各自以空 buffer 收场），紧接着 `primePrefetch()` 重起一批，
        // hls.js 这时来要新位置那一片，搭上任何一趟被中止的车就白等一个 hedgeMs。
        // 表现是「预取缓存明明还有几十秒，拖完进度却转两三秒圈」——因为卡住的是**关键那一片**，
        // 它走对冲路径、不读缓存，跟缓存里有多少毫无关系。
        const pf = segPrefetching.get(url)
        const pfFailed = () => { if (!settled && !this.stats.aborted) race() }
        if (pf) pf.then(buf => { if (buf && buf.byteLength > 0) win(buf); else pfFailed() }).catch(pfFailed)
        else race()

        timers.push(setTimeout(race, tp.hedgeMs))         // 还没赢 → 加一条并行（对冲死连接）
        timers.push(setTimeout(race, tp.hedgeMs * 2))     // 再加一条
        timers.push(setTimeout(() => {                    // 硬超时 → 跳过，别冻结
          if (settled || this.stats.aborted) return
          settled = true
          cleanup()
          const skipped = skipSegment(context?.frag)
          fail(new Error(skipped ? 'segment skipped (too slow)' : 'segment fetch timeout'))
        }, tp.skipMs))
      }

      private _cancelHedge: (() => void) | null = null
      abort(): void {
        this.ctrl?.abort()
        this._cancelHedge?.()
        if (this.stats) this.stats.aborted = true
      }
      destroy(): void { this.abort() }
    }
  }

  return { createHlsFragLoader }
}
