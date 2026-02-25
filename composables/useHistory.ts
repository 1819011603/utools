const MAX_ITEMS = 50
const MAX_ITEM_SIZE = 1 * 1024 * 1024
const MAX_TOTAL_SIZE = 256 * 1024 * 1024

export interface HistoryItem<T> {
  data: T
  timestamp: number
  size: number
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

export function useHistory<T>(page: string) {
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
  }

  const addToHistory = (data: T): boolean => {
    let dataStr = ''
    try {
      dataStr = JSON.stringify(data)
    } catch {
      return false
    }

    const size = getByteSizeFromString(dataStr)
    if (size > MAX_ITEM_SIZE) return false

    const items = loadHistory()
    const isDuplicate = items.some(item => {
      try {
        return JSON.stringify(item.data) === dataStr
      } catch {
        return false
      }
    })
    if (isDuplicate) return false

    const newItem: HistoryItem<T> = { data, timestamp: Date.now(), size }
    let totalSize = items.reduce((sum, i) => sum + i.size, 0) + size
    let newItems = [newItem, ...items]

    while (newItems.length > MAX_ITEMS || totalSize > MAX_TOTAL_SIZE) {
      const removed = newItems.pop()
      if (removed) totalSize -= removed.size
      else break
    }

    saveHistory(newItems)
    return true
  }

  const getHistory = (): HistoryItem<T>[] => loadHistory()

  const clearHistory = () => saveHistory([])

  const applyItem = (item: HistoryItem<T>): T => item.data

  return { addToHistory, getHistory, clearHistory, applyItem }
}
