/**
 * 下载队列：**模块级单例**，一次只跑一个任务。
 *
 * 为什么是模块级（同 `useSegmentCache` 的理由，但这里更要紧）：抽屉关掉、切集、
 * 甚至在 SPA 内离开这一页，下载都得接着跑 —— 一集要几分钟到十几分钟，
 * 挂在组件生命周期上等于「点开选集面板顺手关掉，下载就没了」。
 *
 * **串行**：并行下两集等于把同 host 那 6 条连接的账算两遍，两集都慢，还要跟正在播的抢。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import { downloadHlsEpisode } from './hlsEpisode'
import { createSink, safeFileName, supportsDiskSink, BLOB_WARN_BYTES } from './fileSink'

export type DlState = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface DlTask {
  id: string
  /** 任务行上显示的集名（「2」「上」这种）。**不参与文件名**，见 fileBase */
  epName: string
  /**
   * 文件名主体（不含扩展名），由上层拼好传进来：**集数在前、剧名在后**且数字集名已补零
   * （`02-现在不是出轨的问题`）。在这里拼的话就要把剧名和补零规则也搬进来，
   * 而它们是上层（认识 playlist 和剧名）的事
   */
  fileBase: string
  /** 列表里那条地址：按需取址的站点是占位地址，真实地址开跑前现取 */
  placeholder: string
  state: DlState
  segDone: number
  segTotal: number
  bytes: number
  /** 最近一拍的下载速度（KB/s） */
  kbps: number
  /** 当下几条连接在下。摆在界面上是为了让「勾了全速也没快」这种问题一眼能归因 */
  conn: number
  /** 取不回来、直接跨过去的片数 */
  skipped: number
  error: string
  /** 落定后的文件名（含扩展名），成功那行显示它 */
  fileName: string
}

export interface QueueRuntime {
  /** 占位地址 → 真实播放地址（静默、给前台让路的那一版，见 lazyUrlResolver.peekLazyUrl） */
  resolveUrl: (placeholder: string) => Promise<string>
  /** 防盗链候选值 */
  origin: () => string
  referer: () => string
  getSegBuf: (url: string) => ArrayBuffer | null
  concurrency: () => number
  holdReason: () => string
  /** 输出 MP4（重封装）还是 .ts。**开跑那一刻读一次**，中途改设置不影响在飞的任务 */
  wantMp4: () => boolean
}

/**
 * 运行时依赖来自播放器 ctx。**离开播放页之后不清空**：那些闭包读到的 ref 仍然持有值，
 * 而下载本来就该接着跑（清掉等于「切去搜索页看看，下载全断」）。
 * 下次进播放页会覆盖成新的一份。
 */
let runtime: QueueRuntime | null = null
export const setQueueRuntime = (rt: QueueRuntime) => { runtime = rt }

/** 用户授权过的下载目录（一个手势覆盖整个队列，见 fileSink.pickDownloadDir） */
let dirHandle: any = null
export const setDownloadDir = (h: any) => { dirHandle = h }
export const hasDownloadDir = () => !!dirHandle

export const tasks = reactive<DlTask[]>([])
/** 有任务在跑（UI 上那枚徽标和 beforeunload 提示都看它） */
export const running = ref(false)

const aborts = new Map<string, AbortController>()
let pumping = false

/** 队列里还没落定的任务数 —— 徽标显示「3/10」用的就是它 */
export const pendingCount = () => tasks.filter(t => t.state === 'queued' || t.state === 'running').length

export const enqueue = (items: Array<{ epName: string; fileBase: string; placeholder: string }>) => {
  for (const it of items) {
    // 同一集已经在队列里（或已经下好了）就别重复排：勾选面板上看得见状态，重复排纯属误触
    if (tasks.some(t => t.placeholder === it.placeholder
      && (t.state === 'queued' || t.state === 'running' || t.state === 'done'))) continue
    tasks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      epName: it.epName, fileBase: it.fileBase, placeholder: it.placeholder,
      state: 'queued', segDone: 0, segTotal: 0, bytes: 0, kbps: 0, conn: 0, skipped: 0,
      error: '', fileName: '',
    })
  }
  void pump()
}

export const cancel = (id: string) => {
  const t = tasks.find(x => x.id === id)
  if (!t) return
  aborts.get(id)?.abort()
  aborts.delete(id)
  if (t.state === 'queued' || t.state === 'running') t.state = 'canceled'
}

export const clearFinished = () => {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i]!.state !== 'queued' && tasks[i]!.state !== 'running') tasks.splice(i, 1)
  }
}

/**
 * 关页面前提示一句。**内存里的 Blob 和文件句柄都活不过刷新**，不提示就是静默丢掉
 * 十几分钟的下载。挂/摘都跟着队列走，不挂在组件上（组件早就可能卸载了）。
 */
const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }

const pump = async () => {
  if (pumping) return
  pumping = true
  window.addEventListener('beforeunload', beforeUnload)
  try {
    for (;;) {
      const task = tasks.find(t => t.state === 'queued')
      if (!task) break
      running.value = true
      await runOne(task)
    }
  } finally {
    pumping = false
    running.value = false
    window.removeEventListener('beforeunload', beforeUnload)
  }
}

const runOne = async (task: DlTask) => {
  if (!runtime) { task.state = 'failed'; task.error = '播放器还没就绪'; return }
  const rt = runtime
  const ctrl = new AbortController()
  aborts.set(task.id, ctrl)
  task.state = 'running'
  task.error = ''

  // 速度：按「上一拍以来的字节数 ÷ 时间」现算。装在这儿而不是引擎里——
  // 下载器绝不能往 useHlsPrefetch 的带宽账本里写数（会污染它的分档采样）
  let lastAt = performance.now()
  let lastBytes = 0
  const onProgress = (p: { segDone: number; segTotal: number; bytes: number; conn: number }) => {
    task.segDone = p.segDone
    task.segTotal = p.segTotal
    task.bytes = p.bytes
    task.conn = p.conn
    const now = performance.now()
    if (now - lastAt >= 1000) {
      task.kbps = Math.round((p.bytes - lastBytes) / 1024 / ((now - lastAt) / 1000))
      lastAt = now
      lastBytes = p.bytes
    }
  }

  try {
    // 按需取址的站点：真实地址带时效签名，只能开跑前现取（提前批量取会被站点限流）
    const realUrl = await rt.resolveUrl(task.placeholder)
    if (!realUrl) throw new Error('拿不到播放地址（站点可能在限流）')
    if (ctrl.signal.aborted) throw new DOMException('已取消', 'AbortError')

    const res = await downloadHlsEpisode(realUrl, async ext => {
      // 再 sanitize 一次：fileBase 上层已经洗过，但扩展名是这里定的，两处规则别分叉
      task.fileName = safeFileName(task.fileBase || '视频') + '.' + ext
      return createSink(dirHandle, task.fileName)
    }, {
      origin: rt.origin(),
      referer: rt.referer(),
      getSegBuf: rt.getSegBuf,
      concurrency: rt.concurrency,
      holdReason: rt.holdReason,
      wantMp4: rt.wantMp4(),
      onProgress,
      signal: ctrl.signal,
    })

    task.skipped = res.skipped
    task.state = 'done'
    console.log(`下载完成 ${task.fileName}：${(res.bytes / 1024 / 1024).toFixed(1)}MB`
      + (res.skipped ? `，跳过 ${res.skipped} 片` : ''))
  } catch (e: any) {
    if (e?.name === 'AbortError' || ctrl.signal.aborted) {
      task.state = 'canceled'
    } else {
      task.state = 'failed'
      task.error = e?.message || '未知错误'
      console.warn('下载失败', task.epName, task.error)
    }
  } finally {
    aborts.delete(task.id)
    task.kbps = 0
    task.conn = 0
  }
}

/** 这个环境下大文件会不会有麻烦（没有流式写盘 → 整集攒内存） */
export const diskModeInfo = () => ({
  streaming: supportsDiskSink(),
  warnBytes: BLOB_WARN_BYTES,
})
