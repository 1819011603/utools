/**
 * 下载控制器：把队列里的曲目落成本地文件。
 *
 * **绝不走 `/api/proxy`**（这是本模块和 videoPlayer 最大的分歧，别照搬那边）：
 * 实测两个音频 CDN（酷我 `kw-*.kuwo.cn`、网易云 `*.music.126.net`）都给
 * `access-control-allow-origin: *` + `access-control-expose-headers: *` + 认 `Range`，
 * 浏览器直连完全够用。绕一跳服务端只会把几十上百 MB 的流量全灌进我们自己的出口，
 * 而且 CF Workers 上还有请求时长上限，反而更容易半路断。
 *
 * 依赖方向单向：download → types/display。需要「取址」这种上层能力时一律走 `deps.resolve`
 * 回调，反向 import 站点适配层会立刻循环依赖（同 useMusicEngine 的处置）。
 */
import type { Track, TrackResolver } from './types'
import { buildFileName } from './display'

/**
 * 分块大小。**分块不是为了并发**（我们全程串行），是为了两件事：
 *   · 拿到总长：`content-range` 里的 `/N` 比 `content-length` 可靠——后者在某些边缘节点上缺席，
 *     缺了就只能显示「已下 xx MB」而没有百分比，而这里最大的文件能到 115MB，
 *     没有百分比的等待跟卡死长得一模一样；
 *   · 让单次请求短一些：一条连接扛完 115MB，中途被节点掐掉就是整份重来。
 * 4MB 是取的折中：115MB 约 29 发请求，握手开销可以忽略，单发也不会长到容易被掐。
 */
const CHUNK_SIZE = 4 * 1024 * 1024

/**
 * 地址过期后允许重取址的次数。**只给 1 次**：
 * 「签名真过期」和「站点真限流」表现完全一样（都是取不到），反复取只会
 * 「取址 → 失败 → 再取址」原地打转（同 useMusicEngine 的 `refetchedFor`、
 * video-parse 那边的同名教训）。
 */
const MAX_URL_REFETCH = 1

/** 触发保存后隔多久回收 objectURL。太早撤会让下载起不来，太晚则白占住一份几十 MB 的堆内存 */
const REVOKE_DELAY = 10_000

/**
 * 下载状态。`canceled` 与 `error` 必须分开：
 * 前者是用户自己按的，界面上不该染成红色报错——把用户的主动操作画成故障只会让人以为出了 bug。
 */
export type MusicDownloadStatus =
  | 'queued'       // 排在队里，还没轮到
  | 'resolving'    // 正在取址（曲目手上没有 url）
  | 'downloading'  // 正在拉字节
  | 'done'
  | 'error'
  | 'canceled'

/** 队列里的一行。字段就是界面上那一行要显示的全部内容，不多不少 */
export interface MusicDownloadItem {
  /**
   * 稳定标识，**同时也是去重键**。
   * 绝不能用 url：24bit 的地址约 20 分钟一换，同一首歌前后两次取到的地址完全不同，
   * 按 url 去重等于不去重（见 types.ts 的 Track.key）。
   */
  key: string
  name: string
  artist?: string
  /** 落盘用的扩展名来源。取址时站点可能给回更准的值，所以它会被覆盖 */
  format?: string
  status: MusicDownloadStatus
  receivedBytes: number
  /** 0 = 还不知道（`content-range` 和 `content-length` 都没读到）。界面据此画成不确定进度条 */
  totalBytes: number
  /** 0~100。总长未知时恒为 0，别拿它当「没开始」判据 */
  percent: number
  error?: string
}

export interface MusicDownloadDeps {
  /**
   * 取址回调。**它自带节流闸门（`useMusicResolveGate`），这里绝不能再加一层**——
   * 两层节流叠起来只会让「等多久」变得没法预测，而且闸门的额度是全局的，
   * 下载和播放共用同一份，在这里另起一套等于把额度算重。
   */
  resolve?: TrackResolver
}

export function useMusicDownload(deps: MusicDownloadDeps = {}) {
  /** 界面直接渲染这一份。ref 对对象数组是深响应的，所以逐字段改 item 就能刷新进度条 */
  const downloads = ref<MusicDownloadItem[]>([])

  /**
   * 每条在途下载的中止器，按 key 存。
   * 放在闭包里而不是 item 上：AbortController 不该进响应式系统（它没有任何需要渲染的字段，
   * 却会被 Vue 递归代理一遍）。
   */
  const controllers = new Map<string, AbortController>()

  /** 还没轮到的曲目。**串行**的全部实现就是这一条队列 + 下面的 `running` 闸 */
  const pending: Track[] = []
  let running = false

  /** 正在下载/取址的那一首。界面用它决定「全部中断」按钮亮不亮 */
  const activeKey = ref('')

  const hasActiveDownloads = computed(() =>
    downloads.value.some(d => d.status === 'queued' || d.status === 'resolving' || d.status === 'downloading'),
  )

  const finishedCount = computed(() =>
    downloads.value.filter(d => d.status === 'done' || d.status === 'error' || d.status === 'canceled').length,
  )

  const findItem = (key: string) => downloads.value.find(d => d.key === key)

  // ── 入队 ──

  /**
   * 排一首。返回 false = 被去重挡下了（同一首已经在队里或正在下）。
   *
   * 已经 done/error/canceled 的那一行**允许原地重来**：用户点第二次的意图很明确，
   * 而挡下来又不给任何反馈的话，看着就是「按钮点了没反应」。
   */
  const downloadTrack = (track: Track): boolean => {
    const exist = findItem(track.key)
    if (exist && (exist.status === 'queued' || exist.status === 'resolving' || exist.status === 'downloading')) {
      return false
    }
    if (exist) {
      // 复用同一行而不是再插一行：一首歌在列表里出现两次，用户根本分不清哪行是这次的
      exist.status = 'queued'
      exist.receivedBytes = 0
      exist.totalBytes = 0
      exist.percent = 0
      exist.error = undefined
    } else {
      downloads.value.push({
        key: track.key,
        name: track.name,
        artist: track.artist,
        format: track.format,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: 0,
        percent: 0,
      })
    }
    pending.push(track)
    void pump()
    return true
  }

  /** 批量排队。返回真正入队的条数（去重挡下的不算），调用方拿它写 toast */
  const downloadTracks = (tracks: Track[]): number =>
    tracks.reduce((n, t) => n + (downloadTrack(t) ? 1 : 0), 0)

  /**
   * 串行泵。**绝不并发**：CDN 对单 IP 的并发下载会限速甚至直接掐（同一份带宽拆成 N 份，
   * 总时长一点没省），而且几十 MB 的 Blob 同时攒好几份，内存峰值是按并发数翻倍的。
   */
  const pump = async () => {
    if (running) return
    running = true
    try {
      while (pending.length) {
        const track = pending.shift()!
        const item = findItem(track.key)
        // 排队期间被单条取消了 → 那一行的状态已经是 canceled，这里直接跳过
        if (!item || item.status === 'canceled') continue
        activeKey.value = item.key
        await runOne(track, item)
        activeKey.value = ''
      }
    } finally {
      running = false
    }
  }

  // ── 单曲流程 ──

  const runOne = async (track: Track, item: MusicDownloadItem) => {
    const ac = new AbortController()
    controllers.set(item.key, ac)
    try {
      let url = track.url
      let format = track.format || item.format

      // 曲目手上没有地址（列表里存的是占位）→ 现取。取址可能要好几秒，界面上得有交代
      if (!url) {
        item.status = 'resolving'
        url = await resolveUrl(track, r => { format = r.format || format })
      }

      item.status = 'downloading'
      let blob: Blob | null = null
      // 地址带时效签名（约 20 分钟），排队久了轮到它时多半已经过期。这种失败靠重试同一条
      // 地址永远救不回来，唯一的出路是重新取址；而额度只有 1 次，理由见 MAX_URL_REFETCH
      for (let refetched = 0; ; refetched++) {
        try {
          blob = await fetchInChunks(url, item, ac.signal)
          break
        } catch (e) {
          if (refetched >= MAX_URL_REFETCH || !isExpiredLike(e) || !deps.resolve || !track.resolver) throw e
          item.status = 'resolving'
          item.receivedBytes = 0
          item.percent = 0
          item.totalBytes = 0
          url = await resolveUrl(track, r => { format = r.format || format })
          item.status = 'downloading'
        }
      }

      // 文件名必须自己拼：实测 CDN 的 `content-disposition` 是 `inline`，
      // `content-type` 还谎报成 audio/mpeg（内容其实常是 flac）——跟着它走会存下一个
      // 扩展名错误、名字是一串 hash 的文件（见 display.ts 的 buildFileName）
      saveBlob(blob!, buildFileName(track.name, track.artist, format))

      item.format = format
      item.status = 'done'
      item.percent = 100
      // 总长一直没读到的话，收工时用实际收到的字节数补上，别让界面停在「0 B / 未知」
      if (!item.totalBytes) item.totalBytes = item.receivedBytes
    } catch (e: any) {
      // 用户按的取消也是从 fetch 里抛出来的，但它不是故障 —— 染成红色报错会让人以为出了 bug
      if (ac.signal.aborted || e?.name === 'AbortError') item.status = 'canceled'
      else {
        item.status = 'error'
        item.error = describeError(e)
      }
    } finally {
      controllers.delete(item.key)
    }
  }

  /** 取址并做一次形状校验。resolver 缺席时的报错要说清是「页面没接」而不是「这首没资源」 */
  const resolveUrl = async (
    track: Track,
    onMeta: (r: { format?: string }) => void,
  ): Promise<string> => {
    if (!deps.resolve) throw new Error('这首曲目没有直链，而当前页面没有接入取址器')
    const r = await deps.resolve(track)
    if (!r?.url) throw new Error('没能取到下载地址，可能是站点限流，过一会儿再试')
    onMeta(r)
    return r.url
  }

  // ── 字节搬运 ──

  /**
   * 按 `Range` 逐块拉，边拉边累加进度。
   *
   * **必须容忍 CDN 不认 Range**：这时它回 200 + 整份内容，不能当成一块处理
   * （否则 4MB 之后的字节会被当成「下一块」再请求一遍，等于把整首歌下 N 遍）。
   * 判据是**状态码 206**，不是「有没有 content-range」——有的节点会回 200 却带着这个头。
   */
  const fetchInChunks = async (url: string, item: MusicDownloadItem, signal: AbortSignal): Promise<Blob> => {
    const parts: BlobPart[] = []
    let offset = 0

    for (;;) {
      // 总长已知时把末字节钉死，免得最后一块越界（多数 CDN 会自动截断，但不能指望）
      const end = item.totalBytes
        ? Math.min(offset + CHUNK_SIZE, item.totalBytes) - 1
        : offset + CHUNK_SIZE - 1

      const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
        signal,
        // CDN 实测不校验 Referer，那就干脆不发：少泄露一个来源，也少一个被将来加规则误伤的点
        referrerPolicy: 'no-referrer',
      })
      if (!res.ok) throw new HttpStatusError(res.status)

      if (res.status !== 206) {
        // 整份返回：把已攒的块全扔掉重来（它们和这份内容重叠），改成流式读完这一条
        parts.length = 0
        item.receivedBytes = 0
        item.totalBytes = Number(res.headers.get('content-length')) || 0
        await pumpBody(res, item, parts)
        break
      }

      if (!item.totalBytes) item.totalBytes = parseRangeTotal(res.headers.get('content-range'))

      const got = await pumpBody(res, item, parts)
      offset += got

      if (item.totalBytes) {
        if (offset >= item.totalBytes) break
      } else if (got < CHUNK_SIZE) {
        // 连总长都读不到时，只能靠「这一块没装满」判定到底了
        break
      }
      // 服务端一个字节都不给却回了 206 → 再循环就是死循环，就地收工交给上层判断
      if (got === 0) break
    }

    return new Blob(parts)
  }

  /**
   * 把一条响应体读干净，顺带刷进度。
   *
   * 不用 `res.arrayBuffer()`：那样一整块 4MB 到齐前进度条一动不动，
   * 慢网上就是「卡住 → 突然跳一格」。流式读能每几十 KB 刷一次。
   */
  const pumpBody = async (res: Response, item: MusicDownloadItem, parts: BlobPart[]): Promise<number> => {
    const reader = res.body?.getReader()
    if (!reader) {
      // 极老的实现没有 body 流，退回一次性读取（进度就没那么细，但总比下不下来强）
      const buf = await res.arrayBuffer()
      parts.push(buf)
      bumpProgress(item, buf.byteLength)
      return buf.byteLength
    }
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      parts.push(value)
      got += value.byteLength
      bumpProgress(item, value.byteLength)
    }
    return got
  }

  /**
   * 累加进度。百分比**只在真的变了才写**：115MB 按 64KB 一片算有近两千次回调，
   * 每次都赋值等于让整个面板重渲染两千遍，而肉眼分辨不出小数点后第二位。
   */
  const bumpProgress = (item: MusicDownloadItem, delta: number) => {
    item.receivedBytes += delta
    if (!item.totalBytes) return
    const p = Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 1000) / 10)
    if (p !== item.percent) item.percent = p
  }

  // ── 落盘 ──

  /**
   * Blob → 文件。`<a download>` 是唯一在所有浏览器上都成立的做法
   * （File System Access API 只有 Chromium 有，且要用户手势，批量下载凑不齐）。
   */
  const saveBlob = (blob: Blob, filename: string) => {
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    // 不 append 进 DOM 也能点，但 Firefox 上必须在文档里才生效
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 会让下载起不来（浏览器还没来得及把 blob 交给下载器）。
    // 但也不能不 revoke —— 一首无损几十 MB，攒几首就把标签页的堆吃穿了
    setTimeout(() => URL.revokeObjectURL(href), REVOKE_DELAY)
  }

  // ── 中断 ──

  /**
   * 取消一条。**在途和排队中要分开处理**：
   * 在途的靠 abort（fetch 会抛 AbortError，由 runOne 收尾成 canceled）；
   * 排队中的这会儿还没人在跑它，只能自己就地标掉 + 从 pending 里摘走。
   */
  const cancelDownload = (key: string) => {
    const item = findItem(key)
    if (!item) return
    if (item.status === 'done' || item.status === 'error' || item.status === 'canceled') return

    const i = pending.findIndex(t => t.key === key)
    if (i >= 0) pending.splice(i, 1)

    const ac = controllers.get(key)
    if (ac) ac.abort()
    // 取址阶段没有 fetch 可 abort（resolve 是外部回调），所以这里也要直接标：
    // runOne 回来时会看到 canceled，不会再往下走
    item.status = 'canceled'
  }

  /**
   * 全部中断。**已完成的必须原样保留**——那是用户已经拿到手的文件，
   * 把它们一起清掉会让人以为下载失败了。
   */
  const cancelAll = () => {
    pending.length = 0
    for (const d of downloads.value) {
      if (d.status === 'queued' || d.status === 'resolving' || d.status === 'downloading') d.status = 'canceled'
    }
    for (const ac of controllers.values()) ac.abort()
    controllers.clear()
  }

  /** 清掉已收工的行（done/error/canceled），在途的留着 */
  const clearFinished = () => {
    downloads.value = downloads.value.filter(
      d => d.status === 'queued' || d.status === 'resolving' || d.status === 'downloading',
    )
  }

  return {
    downloads, activeKey, hasActiveDownloads, finishedCount,
    downloadTrack, downloadTracks,
    cancelDownload, cancelAll, clearFinished,
  }
}

// ── 纯函数 ──

/** 带状态码的错误，给上面的「是不是签名过期」判断用（Error 本身没地方放状态码） */
class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * 像不像「地址过期」。403/410 是签名失效的典型回法；401 也算（有的节点用它表示令牌不对）。
 * 404 **不算**：那是资源本身没了，重取址只会再拿到一条同样打不开的地址。
 */
function isExpiredLike(e: unknown): boolean {
  return e instanceof HttpStatusError && (e.status === 401 || e.status === 403 || e.status === 410)
}

/** 从 `bytes 0-4194303/120586240` 里取总长。取不到返回 0（界面据此画不确定进度条） */
function parseRangeTotal(header: string | null): number {
  const n = Number(header?.split('/')[1])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 错误 → 给人看的一句话。**按类别分开写**：
 * 「地址过期了」和「网络断了」需要用户做的事完全不同，混成一句「下载失败」等于没说。
 */
function describeError(e: any): string {
  if (e instanceof HttpStatusError) {
    if (e.status === 401 || e.status === 403 || e.status === 410) return '下载地址已过期，重新下载一次即可'
    if (e.status === 404) return '这个地址在源站上已经不存在了'
    if (e.status === 429) return '被源站限流了，过一会儿再试'
    return `源站返回 ${e.status}`
  }
  // fetch 的网络层失败一律是 TypeError，本机断网和源站掐连接都长这样，分不出来就别猜
  if (e?.name === 'TypeError') return '网络中断，检查连接后重新下载'
  return e?.message || '下载失败'
}
