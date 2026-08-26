import { markDirty, recordClear } from './cloudSyncLocal'

const MAX_ITEMS = 50
const MAX_ITEM_SIZE = 1 * 1024 * 1024
const MAX_TOTAL_SIZE = 256 * 1024 * 1024

export interface HistoryItem<T> {
  data: T
  timestamp: number
  size: number
}

/**
 * 存储是否已被浏览器「持久化」。**origin 级的状态**，所以放模块级共享，
 * 不随某个页面的 useHistory 实例走。null = 还没查 / 浏览器不支持这套 API。
 */
const storagePersisted = ref<boolean | null>(null)

/**
 * 「尽可能久地保存」在浏览器里只有一个正经答案：`navigator.storage.persist()`。
 *
 * localStorage 自己没有过期时间，但**没拿到持久化授权时它随时可能被整体清掉**：
 *   · Chrome / Edge：磁盘吃紧时按 LRU **整个 origin 一起驱逐**（best-effort 配额）
 *   · Safari（WebKit ITP）：**7 天不访问就删**脚本可写存储，而且它压根不支持 `persist()`——
 *     那边唯一的豁免是「添加到主屏幕」。这条我们兜不住，只能如实告诉用户
 *   · Firefox：`persist()` 会弹一个权限请求
 * 拿到授权后 Chrome/Firefox 就不再自动驱逐（用户自己「清除浏览数据」当然照样清得掉，
 * 那是用户的明确意图，不该也不能拦）。
 *
 * **只在真的要写一条历史时才请求**，不在页面加载时请求：Firefox 那个权限弹窗如果凭空冒出来，
 * 用户既不知道是谁要的、也想不出为什么要给。刚解析成功、正要记一条历史，才是能解释得通的时机。
 */
let persistRequested = false

export async function requestPersistentStorage(): Promise<void> {
  if (persistRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistRequested = true
  try {
    // 先查再求：已经授权还去调 persist() 在 Firefox 上会白弹一次窗
    storagePersisted.value = await navigator.storage.persisted() || await navigator.storage.persist()
  } catch {
    storagePersisted.value = null
  }
}

/** 只读当前状态，不触发任何权限请求（`persisted()` 是纯查询） */
export async function refreshPersistedState(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return
  try { storagePersisted.value = await navigator.storage.persisted() } catch { /* 不支持就当未知 */ }
}

function getStorageKey(page: string): string {
  return `utools-history-${page}`
}

function getByteSizeFromString(str: string): number {
  try {
    return new Blob([str]).size
  } catch {
    return 0
  }
}

export interface HistoryOptions {
  /** 条数上限。默认 50；要「基本不丢」的历史（如解析记录）自己传大值 */
  maxItems?: number
}

export function useHistory<T>(page: string, options: HistoryOptions = {}) {
  const maxItems = options.maxItems ?? MAX_ITEMS

  /**
   * 只有片名搜索这一处历史参与云同步（JSON 那几个工具页的历史留在本机）。
   * 这里刻意**不 import `SYNC_COLLECTIONS`**：那张表里带着合并函数，而这个模块是最底层的存储，
   * 让它去依赖同步那一整套就成了环。清单 id 与 page 同名，对不上时的表现只是「不同步」，不会出错。
   */
  const syncId = page === 'video-search' ? page : ''

  const loadHistory = (): HistoryItem<T>[] => {
    if (typeof window === 'undefined') return []
    try {
      const raw = localStorage.getItem(getStorageKey(page))
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  const saveHistory = (items: HistoryItem<T>[]) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(getStorageKey(page), JSON.stringify(items))
    } catch (e) {
      console.error('Save history failed:', e)
    }
    if (syncId) markDirty(syncId)
  }

  /**
   * `bump`：已存在的同一条**挪到最前**，而不是当重复丢弃。
   *
   * 搜索框需要这个：反复搜同一个片名是常态（今天搜、明天接着看），
   * 默认那套「重复就返回 false」会让常用的词永远停在列表末尾、先被淘汰掉。
   * 默认仍是丢弃 —— 解析历史那类「一条地址就是一条记录」的场景不该被重新排序。
   */
  const addToHistory = (data: T, opts: { bump?: boolean } = {}): boolean => {
    let dataStr = ''
    try {
      dataStr = JSON.stringify(data)
    } catch {
      return false
    }

    const size = getByteSizeFromString(dataStr)
    if (size > MAX_ITEM_SIZE) return false

    let items = loadHistory()
    const sameData = (item: HistoryItem<T>) => {
      try { return JSON.stringify(item.data) === dataStr } catch { return false }
    }
    if (items.some(sameData)) {
      if (!opts.bump) return false
      items = items.filter(item => !sameData(item))   // 摘掉旧的那条，下面按新的时间重新插到最前
    }

    const newItem: HistoryItem<T> = { data, timestamp: Date.now(), size }
    let totalSize = items.reduce((sum, i) => sum + i.size, 0) + size
    let newItems = [newItem, ...items]

    while (newItems.length > maxItems || totalSize > MAX_TOTAL_SIZE) {
      const removed = newItems.pop()
      if (removed) totalSize -= removed.size
      else break
    }

    saveHistory(newItems)
    // 真的写下了东西，才去申请「别清我」——见 requestPersistentStorage 的注释
    void requestPersistentStorage()
    return true
  }

  const getHistory = (): HistoryItem<T>[] => loadHistory()

  /**
   * 清空要记一个「清空时间」，不然它传不出去：另一台设备那份里还有这些词，
   * 下次同步就整份灌回来 —— 表现是「清空了搜索历史，过一会儿又全回来了」。
   */
  const clearHistory = () => {
    if (syncId) recordClear(syncId)
    saveHistory([])
  }

  const applyItem = (item: HistoryItem<T>): T => item.data

  return { addToHistory, getHistory, clearHistory, applyItem, storagePersisted, refreshPersistedState }
}
