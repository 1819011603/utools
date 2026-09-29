/**
 * 本机播放记录：每一集记一条「起播多久 / 卡了几次几秒 / 跳了几片 / 换网后多久恢复 / 平均开几条」。
 *
 * 为什么要有：并发与抗卡那一整套全是按「实测截图」一次次调出来的，改完说不清是变好了
 * 还是把问题挪了个地方——没有前后可比的数。这里只做最小的量：每集一条、只存本机
 * （`video-player-metrics`，最近 50 条），面板里一键复制成 JSON，调参前后各看一眼。
 * **不上传**：这是调参用的尺子，不是埋点。
 *
 * 纯逻辑，时钟与存储可注入（单测用）。一集的边界由引擎给：`arm()` 在 loadVideo 被调用时记下起点，
 * `destroyHls` 里先 `end()` 结算上一集、再 `beginArmed()` 开这一集——loadVideo 自己会调一次 destroyHls，
 * 所以起播耗时天然含「取址后建流」那一段。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */

export interface PlayRecord {
  at: number               // 这一集开始的墙钟时刻（Date.now）
  key: string              // 这一集的稳定键（progressKey，截断到 200 字）
  host: string             // 视频地址的 host：同一个源前后对比用
  startupMs: number | null // loadVideo → 第一次 `playing`；null = 没播起来
  watchSecs: number        // 播放头真的在走的墙钟秒数
  stalls: number           // 真实卡顿次数（useStallTracker 的口径）
  stallSecs: number
  skips: number            // 关键片拿不到而跳过的次数
  netChanges: number       // 这一集里「网络变了」几次（netWatch 的口径）
  recoverMs: number[]      // 每次网络变化后到播放头重新走起来花了多久（当时就在走 = 0）
  avgConn: number          // 在播期间目标并发的平均值（一位小数）
  maxConn: number
}

export const METRICS_KEY = 'video-player-metrics'
export const METRICS_MAX = 50
/** 一拍里播放头至少挪这么多才算「在走」（秒）：挡住 seek 微调与浮点抖动 */
const ADVANCE_EPS = 0.05

export interface MetricsStorage {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
}

export interface MetricsTick {
  currentTime: number
  paused: boolean
  targetConn: number
}

interface Session {
  startedAt: number
  at: number
  key: string
  host: string
  startupMs: number | null
  watchMs: number
  skips: number
  netChanges: number
  recoverMs: number[]
  /** 网络变化那一刻播放头没在走 → 等它走起来再记恢复耗时；在走则当场记 0 */
  recoverFrom: number
  connSum: number
  connTicks: number
  maxConn: number
  lastTickAt: number
  lastTime: number
  advancing: boolean
}

const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return '' }
}

export function createPlayMetrics(opts: {
  now?: () => number
  wallNow?: () => number
  storage?: () => MetricsStorage | null
} = {}) {
  const now = opts.now ?? (() => performance.now())
  const wallNow = opts.wallNow ?? (() => Date.now())
  const storage = opts.storage ?? (() => (typeof localStorage !== 'undefined' ? localStorage : null))

  let armedAt = 0
  let cur: Session | null = null

  const loadRecords = (): PlayRecord[] => {
    try {
      const raw = storage()?.getItem(METRICS_KEY)
      const list = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  const saveRecord = (rec: PlayRecord) => {
    const list = loadRecords()
    list.push(rec)
    try { storage()?.setItem(METRICS_KEY, JSON.stringify(list.slice(-METRICS_MAX))) } catch { /* 配额满了就丢这一条，别影响播放 */ }
  }

  /** loadVideo 被调用那一刻：记起点，真正开集要等它里面那次 destroyHls（见文件头） */
  const arm = () => { armedAt = now() }

  const beginArmed = (key: string, url: string) => {
    if (!armedAt) return
    const t = armedAt
    armedAt = 0
    cur = {
      startedAt: t, at: wallNow(), key: key.slice(0, 200), host: hostOf(url),
      startupMs: null, watchMs: 0, skips: 0, netChanges: 0, recoverMs: [], recoverFrom: 0,
      connSum: 0, connTicks: 0, maxConn: 0, lastTickAt: 0, lastTime: -1, advancing: false,
    }
  }

  const notePlaying = () => {
    if (cur && cur.startupMs === null) cur.startupMs = Math.round(now() - cur.startedAt)
  }

  const noteSkip = () => { if (cur) cur.skips++ }

  const noteNetChange = () => {
    if (!cur) return
    cur.netChanges++
    if (cur.advancing) cur.recoverMs.push(0)
    else if (!cur.recoverFrom) cur.recoverFrom = now()   // 连着变几次只从第一次算起
  }

  /** 引擎心跳每秒调一次 */
  const tick = (s: MetricsTick) => {
    if (!cur) return
    const t = now()
    const advancing = !s.paused && cur.lastTime >= 0 && s.currentTime > cur.lastTime + ADVANCE_EPS
    if (advancing && cur.lastTickAt) cur.watchMs += t - cur.lastTickAt
    if (advancing && cur.recoverFrom) {
      cur.recoverMs.push(Math.round(t - cur.recoverFrom))
      cur.recoverFrom = 0
    }
    // 并发只在「在播」时计：暂停/卡着时目标并发的含义不同，混进来平均值就没法跨集比
    if (advancing) {
      cur.connSum += s.targetConn
      cur.connTicks++
      if (s.targetConn > cur.maxConn) cur.maxConn = s.targetConn
    }
    cur.advancing = advancing
    cur.lastTime = s.currentTime
    cur.lastTickAt = t
  }

  /**
   * 结算当前这一集并落库。`stalls`/`stallSecs` 由调用方从卡顿记录读（它在 destroyHls 里紧接着被 reset）。
   * **什么都没发生的不记**（没起播、也没心跳过——典型是 MP4/FLV 那条路、或刚建就被切走），
   * 否则列表会被一堆全零的行淹掉。
   */
  const end = (stalls: number, stallMs: number): PlayRecord | null => {
    const s = cur
    cur = null
    if (!s || (s.startupMs === null && s.connTicks === 0 && s.lastTickAt === 0)) return null
    const rec: PlayRecord = {
      at: s.at, key: s.key, host: s.host, startupMs: s.startupMs,
      watchSecs: Math.round(s.watchMs / 1000),
      stalls, stallSecs: Math.round(stallMs / 100) / 10,
      skips: s.skips, netChanges: s.netChanges, recoverMs: s.recoverMs,
      avgConn: s.connTicks ? Math.round((s.connSum / s.connTicks) * 10) / 10 : 0,
      maxConn: s.maxConn,
    }
    saveRecord(rec)
    return rec
  }

  const clearRecords = () => { try { storage()?.removeItem(METRICS_KEY) } catch { /* 同 saveRecord */ } }

  return { arm, beginArmed, notePlaying, noteSkip, noteNetChange, tick, end, loadRecords, clearRecords }
}

export type PlayMetrics = ReturnType<typeof createPlayMetrics>

/** 面板那一行的汇总：最近 N 条的起播中位数、每小时卡顿次数、跳片总数 */
export function summarizeRecords(list: PlayRecord[]): { count: number; startupP50Ms: number | null; stallsPerHour: number; skips: number } {
  const startups = list.map(r => r.startupMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
  const watch = list.reduce((s, r) => s + r.watchSecs, 0)
  const stalls = list.reduce((s, r) => s + r.stalls, 0)
  return {
    count: list.length,
    startupP50Ms: startups.length ? startups[Math.floor((startups.length - 1) / 2)]! : null,
    stallsPerHour: watch > 0 ? Math.round((stalls / (watch / 3600)) * 10) / 10 : 0,
    skips: list.reduce((s, r) => s + r.skips, 0),
  }
}
