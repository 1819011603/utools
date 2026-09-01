/**
 * 下载一集 HLS：解析清单 → 并发拉分片 → AES-128 解密 → **按顺序**写进文件。
 *
 * 解析和解密全部复用 `useM3u8`（`getM3u8DownloadPlan` / `decryptHlsSegment` 就是为这件事写的），
 * 这里只管「怎么把字节稳稳地取回来、按什么节奏取」。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import { isOffline, waitForNet } from '../engine/netWatch'
import { createTsRemuxer, type TsRemuxer } from './tsToMp4'
import { createMp4Writer, type Mp4Writer } from './mp4Writer'
import type { FileSink } from './fileSink'
import type { HlsSegment } from '../useM3u8'

export interface EpisodeDeps {
  /** 防盗链候选值（任务创建时的快照，见 downloadQueue 里的说明） */
  origin: string
  referer: string
  /** 正在播的这一集已经下过的分片，白捡。拿不到就返回 null */
  getSegBuf: (url: string) => ArrayBuffer | null
  /** 这一拍允许几条并发（每片开工前问一次，所以让路能立刻生效） */
  concurrency: () => number
  /** 返回非空字符串表示「先停一下」（濒卡 / 用户按了暂停），内容只用于展示 */
  holdReason: () => string
  /** 要不要把 TS 重封装成 MP4（用户设置；已经是 fMP4 的源无需也不会走这条） */
  wantMp4: boolean
  onProgress: (p: { segDone: number; segTotal: number; bytes: number; conn: number }) => void
  signal: AbortSignal
}

/** 单片重试次数与退避。离网期间的失败不算在内（见下面 fetchOne） */
const RETRY_BACKOFF = [300, 900, 2700]
/** 整集连续失败这么多片就放弃：偶发失败靠重试兜，连着倒下就是源站/地址的问题 */
const MAX_CONSECUTIVE_FAIL = 6
/** 允许跳过的分片数上限（跳掉的那几秒画面会直接跨过去，所以要如实报出来） */
const MAX_SKIP = 3
/** 攒够几片就按均值预估总量（Blob 兜底要靠它提前劝退） */
const ESTIMATE_AFTER = 3
/**
 * 开满几条 worker（**上限**，实际几条干活由 `deps.concurrency()` 每拍决定）。
 *
 * 原来是 6，理由抄的是播放那边「同 host 只给 6 条连接」—— **在这儿是错的**：
 * 那条限制只对 HTTP/1.1 成立，而这些分片 CDN 走的是 **HTTP/2**（一条连接上多路复用，
 * 浏览器允许上百个并发流）。实测 `file.icve.com.cn`（curl，逐档量聚合）：
 *   1 条 0.47 MB/s ｜ 4 条 1.89 ｜ 8 条 2.67 ｜ **16 条 6.00**
 * 也就是说源站是**按连接限速**的，聚合几乎线性涨 —— 卡在 6 就是自己把速度锁死了
 *（用户报「勾了全速下载也没快多少」，2.12 MB/s 正好是 6~8 条的量）。
 */
const MAX_WORKERS = 16
/** 被并发数收窄掉的 worker 多久回头看一眼。要短：勾上「全速」得马上有反应 */
const IDLE_POLL_MS = 250
/** 让路（濒卡）时的等待。这个要长：让路的意义就是别去抢那几条连接 */
const HOLD_POLL_MS = 700

const TS_PACKET = 188

/**
 * **把分片开头那段伪装字节剥掉**，让写进文件的第一个字节就是 TS 同步字节 0x47。
 *
 * 实测 4kvm 那条线路（`file.icve.com.cn`）把每一片都伪装成 PNG：**73 字节 PNG 头 + 完整 TS 流**
 * （`(总长 - 73) % 188 === 0`）。播放时看不出来 —— hls.js 的 TS 解复用自己会扫同步点；
 * 但下载是**首尾相接拼成一个文件**，不剥的话 590 片就有 590 段 73 字节的垃圾散在里面，
 * ffprobe / VLC 要么报错要么花屏，而症状会被当成「解密错了」（最难查的那一类）。
 *
 * 三条纪律：判据要**连续三个包**（单个 0x47 太容易撞上）；窗口封在 64KB 内
 * （再往后就不是「一层壳」而是别的格式了）；**找不到就原样交出去** —— 猜不准就别改字节。
 */
const stripToTsSync = (buf: ArrayBuffer): ArrayBuffer => {
  const u8 = new Uint8Array(buf)
  if (u8.length < TS_PACKET * 3) return buf
  if (u8[0] === 0x47 && u8[TS_PACKET] === 0x47 && u8[TS_PACKET * 2] === 0x47) return buf
  const limit = Math.min(u8.length - TS_PACKET * 3, 64 * 1024)
  for (let i = 1; i < limit; i++) {
    if (u8[i] === 0x47 && u8[i + TS_PACKET] === 0x47 && u8[i + TS_PACKET * 2] === 0x47) return buf.slice(i)
  }
  return buf
}

/** 三条取字节的通道。直连排第一：它不花我们的服务器流量，而多数分片 CDN 本来就不校验防盗链 */
type Lane = 'direct' | 'headers' | 'noref'
const LANE_ORDER: Lane[] = ['direct', 'headers', 'noref']

const laneUrl = (lane: Lane, url: string, origin: string, referer: string): string => {
  if (url.includes('/api/proxy?')) return url
  if (lane === 'direct') return url
  const params = new URLSearchParams({ url })
  if (lane === 'noref') params.set('noref', '1')
  else {
    if (origin) params.set('origin', origin)
    if (referer) params.set('referer', referer)
    // 一个头都没有的「headers 通道」跟 noref 是同一发请求，直接跳过（由调用方过滤）
  }
  return '/api/proxy?' + params.toString()
}

export interface EpisodeResult {
  /** 有 fMP4 初始化段就出 .mp4，否则 .ts */
  ext: 'ts' | 'mp4'
  bytes: number
  /** 取不回来、直接跨过去的片数（>0 时任务行上要说一句） */
  skipped: number
}

/**
 * 下载一集。抛错即失败（错误文案直接给用户看），`signal` 取消时抛 `DOMException: AbortError`。
 *
 * 落盘器由调用方**按解析出来的扩展名**现造（`makeSink`）：文件名里带 `.ts` / `.mp4`，
 * 而是哪一种要等清单解析完才知道，先造好就只能事后改名（流式写盘那边改不了）。
 * 造出来之后**由本函数负责 `abort()`**（含清掉写了一半的文件）。
 */
export const downloadHlsEpisode = async (
  m3u8Url: string, makeSink: (ext: 'ts' | 'mp4') => Promise<FileSink>, deps: EpisodeDeps,
): Promise<EpisodeResult> => {
  const { origin, referer, signal } = deps

  /**
   * 交给 `useM3u8` 的取址器：**一律走代理 + `noseg=1`**。
   *
   * 两件事同时要成立：清单必须能跨域读到（所以走代理），而清单里的分片地址必须保持**裸 CDN 地址**
   * （所以 `noseg=1`）—— 否则服务端会把每一行都改写成 `/api/proxy?...`，
   * 下面那套「先直连、不行再换通道」压根就没有直连可试，整集流量全从我们的 Worker 过一遍。
   * 密钥同理保持裸地址，由 `fetchHlsKey` 自己套代理（它就是用这个函数）。
   */
  const proxyForManifest = (url: string): string => {
    if (url.includes('/api/proxy?')) return url
    const params = new URLSearchParams({ url, noseg: '1' })
    if (origin) params.set('origin', origin)
    if (referer) params.set('referer', referer)
    if (!origin && !referer) params.set('noref', '1')   // 没有候选头时 noseg 需要 noref 才生效
    return '/api/proxy?' + params.toString()
  }

  const m3u8 = useM3u8(proxyForManifest)
  m3u8.clearKeyCache()

  const plan = await m3u8.getM3u8DownloadPlan(m3u8Url, signal)
  /*
   * **音视频分轨的线路直接拒掉。**
   *
   * 两条流各自完整、但拼不到一个文件里（要真的 mux 一遍）。下一个只有画面没声音的文件
   * 比明说不支持糟得多——用户会以为下载功能坏了，而实际上换条线路就好。
   */
  if (plan.audioSegments.length > 0) {
    throw new Error('这条线路音视频分轨（需要转码合并），暂不支持下载 —— 换条线路再试')
  }
  const segments = plan.videoSegments
  if (!segments.length) throw new Error('清单里没有解析出分片')

  // fMP4 的初始化段由 extractMediaSegmentsWithMeta 塞在最前面。判据宽松没关系：
  // 认错只影响要不要多走一层 remux，字节本身是一样的
  const sourceIsMp4 = /\.(mp4|m4s)(\?|$)/i.test(segments[0]!.url)
  /** 源是 TS 且用户要 MP4 → 多走一层重封装（不重编码）。源本来就是 fMP4 就直接写 */
  const remuxing = !sourceIsMp4 && deps.wantMp4
  const ext: 'ts' | 'mp4' = sourceIsMp4 || remuxing ? 'mp4' : 'ts'
  // 重依赖动态 import，且**赶在建文件之前**：mux.js 要是加载不上，别先在磁盘上留个空文件
  const remuxer: TsRemuxer | null = remuxing ? await createTsRemuxer() : null
  const sink = await makeSink(ext)

  // ── 取一片字节（含通道降级与重试）──

  /** 哪条通道成过就一直用它：一集几百片，每片都从直连重试一轮等于把失败乘以片数 */
  let stickyLane: Lane | null = null

  const lanesToTry = (): Lane[] => {
    const usable = LANE_ORDER.filter(l => l !== 'headers' || origin || referer)
    if (!stickyLane) return usable
    return [stickyLane, ...usable.filter(l => l !== stickyLane)]
  }

  const fetchOne = async (seg: HlsSegment): Promise<ArrayBuffer> => {
    // 白捡：正在播的这一集，播放路径已经把这些分片下过了。缓存键是播放那条路拼出的完整 URL，
    // 所以三种形态都问一遍；命中不了就照常下，不做花活
    for (const lane of LANE_ORDER) {
      const hit = deps.getSegBuf(laneUrl(lane, seg.url, origin, referer))
      if (hit) return hit
    }

    let lastErr: any
    for (let attempt = 0; attempt <= RETRY_BACKOFF.length; attempt++) {
      /*
       * **离网期间一律不计失败次数**（同 CLAUDE.md 那条「每一个失败额度都必须是连续失败」）：
       * 断网 20 秒能把三次重试和整集的连续失败额度一起烧光，而那跟源站没有半点关系，
       * 症状是「网络早恢复了，下载却已经失败了」。
       */
      if (isOffline()) {
        await new Promise<void>(r => waitForNet(() => r()))
        attempt--
        continue
      }
      for (const lane of lanesToTry()) {
        try {
          const res = await fetch(laneUrl(lane, seg.url, origin, referer), {
            signal, referrerPolicy: 'no-referrer',
          })
          if (!res.ok) { lastErr = new Error(`分片 ${res.status}`); continue }
          const buf = await res.arrayBuffer()
          if (!buf.byteLength) { lastErr = new Error('分片是空的'); continue }
          /*
           * **200 + 一页 HTML 是真实存在的**：实测这个 CDN 对 URL 里多一个 `%0D` 就回
           * 300 来字节的 `<!DOCTYPE HTML>`，状态码照旧 200。写进文件不会报任何错，
           * 只会在播的时候花屏 —— 而那时已经查不到源头了。**直连通道尤其要自己把这刀落下**
           *（走代理那条有服务端的诱饵图/下线检测兜着，直连没有）。
           */
          if (new Uint8Array(buf)[0] === 0x3c) { lastErr = new Error('拿回来的是网页不是分片'); continue }
          stickyLane = lane
          return buf
        } catch (e: any) {
          if (signal.aborted) throw e
          lastErr = e
        }
      }
      // 整轮通道都没成 → 这条通道结论也不算准了，下一轮从头试
      stickyLane = null
      if (attempt < RETRY_BACKOFF.length) {
        await new Promise(r => setTimeout(r, RETRY_BACKOFF[attempt]))
      }
    }
    throw lastErr ?? new Error('分片取不回来')
  }

  // ── 并发拉 + 顺序写 ──

  /*
   * 乱序窗口只允许比写入位置超前几片：**内存占用因此恒等于「并发数 × 分片大小」**。
   * 不封窗口的话，第 1 片卡住而后面几百片全下完了，就等于把整集攒在了内存里
   * ——那正是流式写盘想避开的事。
   */
  const done = new Map<number, ArrayBuffer>()
  let writeCursor = 0
  let nextToFetch = 0
  let bytes = 0
  let consecutiveFail = 0
  let skipped = 0
  let failure: any = null
  let estimated = false
  let strippedOnce = false   // 伪装头只报一次，别在控制台刷 590 行
  let writer: Mp4Writer | null = null   // 普通 MP4 的样本表攒在它里面（只在 remux 那条路上）

  const doFlush = async () => {
    while (done.has(writeCursor)) {
      const buf = done.get(writeCursor)!
      done.delete(writeCursor)
      if (buf.byteLength) {
        /*
         * **重封装只能放在这条串行的写入链上**：mux.js 的 Transmuxer 是有状态的、
         * 靠喂进去的顺序维持时间线。放到并行的 worker 里就是「第 7 片先于第 3 片进去」，
         * 出来的文件时间戳全乱（能播、但进度乱跳）。
         */
        if (remuxer) {
          /*
           * TS →（mux.js）→ fMP4 片段 →（mp4Writer）→ **普通 MP4**。
           * 中间那层不能省，理由见 `mp4Writer.ts` 的头注释（AVFoundation 算不对 fMP4 的时长）。
           */
          const { init, fragments } = remuxer.push(buf)
          if (init && !writer) {
            writer = createMp4Writer(init)
            await sink.write(writer.header())     // ftyp + 占位的 mdat 头
          }
          if (!writer) throw new Error('remux 没有给出 init 段，无法写 MP4')
          for (const frag of fragments) await sink.write(writer.addFragment(frag))
        } else {
          await sink.write(buf)
        }
      }
      writeCursor++
      // 线程数一并报出去：「勾了全速也没快」这类问题，不把当下几条摆在界面上就只能靠猜
      deps.onProgress({ segDone: writeCursor, segTotal: segments.length, bytes, conn: deps.concurrency() })
    }
  }
  /*
   * 写入必须**串起来**：几条 worker 同时交货就会同时进 flush，而
   * `FileSystemWritableFileStream` 被两处同时 write 会直接抛「locked」，
   * Blob 那边则会把片序写乱（拼出来的文件能播前几分钟，之后花屏 —— 极难归因）。
   * 写失败（磁盘满 / 超了 Blob 上限）一律记进 failure，别让链子保持 rejected 状态，
   * 否则后面每一次 flush 都立刻拒，会被 worker 的 catch 误记成「分片失败」。
   */
  let flushChain: Promise<void> = Promise.resolve()
  const flush = () => {
    flushChain = flushChain.then(doFlush).catch(e => { failure = failure || e })
    return flushChain
  }

  /**
   * 并发数是**动态**的（濒卡要收、用户勾了全速要放），所以固定开满 `MAX_WORKERS` 条，
   * 每条自己看「我这条还该不该干活」。按当下的并发数重开 worker 会把在途请求全丢掉。
   */
  const worker = async (myIndex: number) => {
    while (!failure && !signal.aborted) {
      /*
       * **「片都发完了」这一条必须排在所有等待之前。**
       * 否则被收窄掉的那几条 worker（`myIndex >= concurrency()`）会在让路的循环里
       * 一直转下去 —— 它们永远走不到下面那句 `i >= segments.length`，于是 `Promise.all`
       * 永远不 resolve：**分片全下完了，任务却停在 590/590 不落定**。
       */
      if (nextToFetch >= segments.length) return

      // 两种停一停：并发收窄到我这条之外 / 濒卡让路。停在这儿而不是继续发请求
      // —— 让路的全部意义就是不去抢正在播的那一集的连接
      if (deps.holdReason()) { await new Promise(r => setTimeout(r, HOLD_POLL_MS)); continue }
      if (myIndex >= deps.concurrency()) { await new Promise(r => setTimeout(r, IDLE_POLL_MS)); continue }
      // 乱序窗口满了：等写入追上来（不然内存里会攒下整集）
      if (nextToFetch - writeCursor >= deps.concurrency() + 2) {
        await new Promise(r => setTimeout(r, 120))
        continue
      }
      const i = nextToFetch++

      try {
        const raw = await fetchOne(segments[i]!)
        const plain = await m3u8.decryptHlsSegment(raw, segments[i]!, signal)
        // 伪装壳只可能出现在 TS 上（fMP4 那条压根没有同步字节可找），所以判据是**源**的格式，
        // 不是输出的扩展名 —— 要 remux 成 MP4 时源仍然是 TS，那层壳照样得先剥掉
        const data = sourceIsMp4 ? plain : stripToTsSync(plain)
        if (data.byteLength !== plain.byteLength && !strippedOnce) {
          strippedOnce = true
          console.log(`分片带 ${plain.byteLength - data.byteLength} 字节伪装头（如 PNG），已剥掉再写入`)
        }
        bytes += data.byteLength
        consecutiveFail = 0
        done.set(i, data)

        // 预估总量：Blob 兜底要在这儿劝退，而不是等它下到 80% 再崩
        if (!estimated && writeCursor + done.size >= ESTIMATE_AFTER) {
          estimated = true
          const projected = (bytes / (writeCursor + done.size)) * segments.length
          const reject = sink.checkProjected(projected)
          if (reject) { failure = new Error(reject); return }
        }
        await flush()
      } catch (e: any) {
        if (signal.aborted) return
        if (++consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
          failure = new Error(`连续 ${MAX_CONSECUTIVE_FAIL} 片取不回来：${e?.message || e}`)
          return
        }
        /*
         * 单片彻底失败（三次重试 × 三条通道都没成）：**记一笔跳过，别让整集陪葬**。
         * 一集八百片，为其中一片把二十分钟的下载判死太狠；但也不能默默跳
         * ——跳掉的那几秒画面会直接跨过去，所以跳过数要如实报到任务行上。
         * 超过 MAX_SKIP 就说明不是偶发，整集失败。
         */
        if (++skipped > MAX_SKIP) {
          failure = new Error(`有 ${skipped} 片取不回来（超过容忍上限），换条线路再试`)
          return
        }
        done.set(i, new ArrayBuffer(0))
        console.warn(`分片 ${i} 取不回来，跳过（累计跳过 ${skipped}）:`, e?.message || e)
        await flush()
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: MAX_WORKERS }, (_, i) => worker(i)))
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    await flush()
    if (failure) throw failure
    if (writeCursor < segments.length) throw new Error(`只写进 ${writeCursor}/${segments.length} 片`)
    // 每片都 flush 过，正常这里拿不到东西；留着是为了不依赖 mux.js 的内部攒包时机
    if (remuxer && writer) {
      for (const frag of remuxer.finish().fragments) await sink.write(writer.addFragment(frag))
      // 收尾：样本表（`moov`）追在 `mdat` 后面，再回头把 `mdat` 的真实长度填上。
      // `moov` 排在 `mdat` 之后完全合法（ffmpeg 不加 +faststart 就是这个布局）
      const { moov, patch } = writer.finish()
      await sink.write(moov)
      await sink.patchAt(patch.position, patch.data)
    }
    await sink.close()
  } catch (e) {
    // 写了一半的文件必须清掉：留着就是「下过了但播不了」，比没下更糟
    await sink.abort().catch(() => {})
    throw e
  } finally {
    m3u8.clearKeyCache()
  }
  return { ext, bytes, skipped }
}
