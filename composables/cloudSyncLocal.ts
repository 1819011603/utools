/**
 * 同步的**本机侧账本**（localStorage 一个键 `cloud-sync-meta`），以及各模块往里记事的入口。
 *
 * 存三类东西：
 *   · `rev` —— 每份清单上次同步到的版本号，提交时带上去做乐观并发
 *   · `dirty` —— 哪几份清单本地改过。**「有变更才同步」的唯一依据**，空的时候一个请求都不发
 *   · `tomb` / `clearedAt` —— 删除墓碑（理由见 cloudSyncMerge.ts 顶部）
 *
 * 这个模块**故意不 import 同步引擎**：记事的一方是 `useWatchHistory` / `useHistory` 这类
 * 最底层的存储模块，让它们去依赖一个会发网络请求的引擎就成了环，而且那几个模块在没登录时也要照常工作。
 * 引擎反过来订阅（`onDirty`），方向是单向的。
 *
 * `dirty` 必须落 localStorage 而不是放内存：改一下就关标签页是最常见的操作，
 * 放内存的话那次改动等于没记，下次同步也就不会带上它。
 */
import type { Tomb } from './cloudSyncMerge'

const KEY = 'cloud-sync-meta'

export interface SyncMeta {
  /** 这份账本属于谁。换账号登录时整份重置——上一个账号的版本号和墓碑对新账号毫无意义 */
  uid: string
  rev: Record<string, number>
  /** 值是标脏的时间，只为排查时看得出「什么时候改的」 */
  dirty: Record<string, number>
  tomb: Record<string, Tomb>
  clearedAt: Record<string, number>
  /** 上次**尝试**同步的时间，节流看的是这个（失败也算，否则出错时会每次改动都重试） */
  lastSyncAt: number
  /** 上次**成功**同步的时间，界面上显示的是这个 */
  lastOkAt: number
}

const blank = (uid = ''): SyncMeta => ({ uid, rev: {}, dirty: {}, tomb: {}, clearedAt: {}, lastSyncAt: 0, lastOkAt: 0 })

export function readMeta(): SyncMeta {
  if (typeof window === 'undefined') return blank()
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { ...blank(), ...raw, rev: raw.rev ?? {}, dirty: raw.dirty ?? {}, tomb: raw.tomb ?? {}, clearedAt: raw.clearedAt ?? {} }
  } catch { return blank() }
}

export function writeMeta(m: SyncMeta): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* 配额满了就算了，下次同步会重新算 */ }
}

export function patchMeta(fn: (m: SyncMeta) => void): SyncMeta {
  const m = readMeta()
  fn(m)
  writeMeta(m)
  return m
}

// ── 改动通知（引擎订阅，存储模块只管发） ──

type Listener = () => void
const dirtyListeners: Listener[] = []

export function onDirty(cb: Listener): void {
  dirtyListeners.push(cb)
}

const fireDirty = () => { for (const cb of dirtyListeners) { try { cb() } catch { /* 一个订阅者炸了不该带走别人 */ } } }

/** 本地改了某份清单。**存储模块的每个写盘点都要调**，漏一处的表现是「那一类数据永远同步不上去」 */
export function markDirty(collId: string): void {
  if (typeof window === 'undefined' || !collId) return
  patchMeta(m => { m.dirty[collId] = Date.now() })
  fireDirty()
}

/**
 * 「现在就同步一次」的请求信号。
 *
 * 与 `markDirty` 的区别是**时机**而不是内容：markDirty 只说「有东西改了」，
 * 引擎按自己的节奏（5 秒防抖 + 5 分钟节流）挑时间；这个说的是「**此刻**是个好时机」。
 *
 * 发起方只有三种**用户主动**的动作：按下暂停、手动拖进度、切换集数。
 * 它们的共同点是「看到哪儿」刚刚被用户自己改过、而且改完往往就要走开或换设备，
 * 那一刻进度已落库、网络也闲着，正该把它推上去。引擎收到后豁免节流跑一轮，
 * 跑完节流时钟自然从那一刻重新开始算。
 *
 * **绝不能由自动行为触发**：抗卡主动 pause、播完自动切下一集、跳过片尾——
 * 那些每分钟都可能发生好几次，一发就同步等于把网络往火上浇。
 *
 * 同样走「存储模块只管发、引擎订阅」的单向依赖（见文件头）：播放器不认识同步引擎。
 */
const flushListeners: Listener[] = []
/** 两次「现在就同步」之间的最小间隔。去重放在这里而不是各调用方，免得三处各写一份必然漂移 */
const FLUSH_GAP_MS = 30_000
let lastFlushAt = 0

export function onFlushRequest(cb: Listener): void {
  flushListeners.push(cb)
}

export function requestSyncFlush(): void {
  if (typeof window === 'undefined') return
  // 连着拖几下进度条、连点两下「下一集」不该发好几轮请求
  const now = Date.now()
  if (now - lastFlushAt < FLUSH_GAP_MS) return
  lastFlushAt = now
  for (const cb of flushListeners) { try { cb() } catch { /* 一个订阅者炸了不该带走别人 */ } }
}

/** 删了某一条。记墓碑，否则别的设备会把它推回来 */
export function recordDelete(collId: string, key: string): void {
  if (typeof window === 'undefined' || !collId || !key) return
  patchMeta(m => {
    (m.tomb[collId] ??= {})[key] = Date.now()
    m.dirty[collId] = Date.now()
  })
  fireDirty()
}

/** 整份清空。等同于「给当时所有条目一次性发墓碑」，只占一个时间戳 */
export function recordClear(collId: string): void {
  if (typeof window === 'undefined' || !collId) return
  patchMeta(m => {
    m.clearedAt[collId] = Date.now()
    m.dirty[collId] = Date.now()
  })
  fireDirty()
}

/** 换账号：版本号、脏标记、墓碑全是上一个账号的，留着只会把两个人的数据搅在一起 */
export function resetMetaFor(uid: string): void {
  if (typeof window === 'undefined') return
  if (readMeta().uid === uid) return
  writeMeta(blank(uid))
}

// ── 合并结果落盘后通知界面重读 ──

/**
 * 有些清单被持在组件自己的 ref 里（两处搜索历史都是 `ref(getHistory())` 的快照），
 * 引擎直接改 localStorage 它们是不会知道的，表现是「另一台设备的搜索记录要刷新页面才出现」。
 * 用事件而不是让引擎去 import 那些组件：方向同样保持单向。
 */
const APPLIED = 'cloud-sync-applied'

export function notifyApplied(collId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(APPLIED, { detail: collId }))
}

/** 返回退订函数，组件在 `onBeforeUnmount` 里调 */
export function onSyncApplied(collId: string, cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => { if ((e as CustomEvent).detail === collId) cb() }
  window.addEventListener(APPLIED, h)
  return () => window.removeEventListener(APPLIED, h)
}
