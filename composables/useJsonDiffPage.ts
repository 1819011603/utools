import { useDebounceFn } from '@vueuse/core'
import type { HistoryItem } from '~/composables/useHistory'
import { useHistory } from '~/composables/useHistory'
import { useJsonDiff, type DiffItem, type ArrayPathInfo } from '~/composables/useJsonDiff'

export interface JsonDiffHistory {
  inputA: string
  inputB: string
}

const STORAGE_KEY = 'json-diff-settings'

/**
 * json-diff 页面的全部状态与逻辑（从 `pages/json-diff.vue` 下沉）。
 */
export function useJsonDiffPage() {
  const { addToHistory, getHistory, clearHistory } = useHistory<JsonDiffHistory>('json-diff')
  const { getKeyOptions, analyzeArrayPaths, deepCompare } = useJsonDiff()

  const historyList = ref<HistoryItem<JsonDiffHistory>[]>([])

  const refreshHistory = () => {
    historyList.value = getHistory()
  }

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const getPreview = (data: JsonDiffHistory) => {
    const textA = data.inputA.trim().replace(/\s+/g, ' ')
    const textB = data.inputB.trim().replace(/\s+/g, ' ')
    const shortA = textA.length > 20 ? textA.slice(0, 20) + '...' : textA
    const shortB = textB.length > 20 ? textB.slice(0, 20) + '...' : textB
    return `A: ${shortA} B: ${shortB}`
  }

  const getPreviewFull = (data: JsonDiffHistory) => {
    const textA = data.inputA.trim().replace(/\s+/g, ' ')
    const textB = data.inputB.trim().replace(/\s+/g, ' ')
    const fullA = textA.length > 200 ? textA.slice(0, 200) + '...' : textA
    const fullB = textB.length > 200 ? textB.slice(0, 200) + '...' : textB
    return `A: ${fullA} B: ${fullB}`
  }

  const historyMenuItems = computed(() => {
    if (historyList.value.length === 0) return []

    return [
      historyList.value.map((item, index) => ({
        label: `${formatTime(item.timestamp)} - ${getPreview(item.data)}`,
        preview: getPreviewFull(item.data),
        click: () => applyHistory(index)
      })),
      [{ label: '清空历史', icon: 'i-heroicons-trash', click: () => { clearHistory(); refreshHistory() } }]
    ]
  })

  const applyHistory = (index: number) => {
    const item = historyList.value[index]
    if (item) {
      inputA.value = item.data.inputA
      inputB.value = item.data.inputB
      analyze()
      useToast().add({ title: '已恢复', color: 'green', timeout: 1500 })
    }
  }

  const saveToHistory = () => {
    if (!inputA.value.trim() || !inputB.value.trim()) return
    try {
      JSON.parse(inputA.value)
      JSON.parse(inputB.value)
      addToHistory({ inputA: inputA.value, inputB: inputB.value })
      refreshHistory()
    } catch {}
  }

  onMounted(() => {
    refreshHistory()
  })

  const loadSettings = () => {
    if (typeof window === 'undefined') return null
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  }

  const saveSettings = () => {
    if (typeof window === 'undefined') return
    try {
      const settings = {
        sortOrder: sortOrder.value,
        activeFilters: activeFilters.value
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  const savedSettings = loadSettings()

  const inputA = ref('')
  const inputB = ref('')
  const error = ref('')
  const diffResult = ref<DiffItem[]>([])
  const compared = ref(false)
  const arrayPaths = ref<ArrayPathInfo[]>([])
  const sortOrder = ref(savedSettings?.sortOrder ?? 'changed-removed-added')
  const activeFilters = ref<string[]>(savedSettings?.activeFilters ?? ['changed', 'removed', 'added'])

  watch([sortOrder, activeFilters], saveSettings)

  const sortOptions = [
    { label: '修改 → 删除 → 新增', value: 'changed-removed-added' },
    { label: '修改 → 新增 → 删除', value: 'changed-added-removed' },
    { label: '删除 → 修改 → 新增', value: 'removed-changed-added' },
    { label: '新增 → 修改 → 删除', value: 'added-changed-removed' },
    { label: '默认顺序', value: 'default' },
    { label: '按路径排序', value: 'path' },
  ]

  const filterOptions = [
    { label: '修改', value: 'changed', color: 'yellow' as const },
    { label: '删除', value: 'removed', color: 'red' as const },
    { label: '新增', value: 'added', color: 'green' as const },
  ]

  const analyze = () => {
    if (!inputA.value.trim() || !inputB.value.trim()) {
      arrayPaths.value = []
      return
    }

    try {
      const objA = JSON.parse(inputA.value)
      const objB = JSON.parse(inputB.value)
      const newPaths = analyzeArrayPaths(objA, objB)

      arrayPaths.value.forEach(oldPath => {
        const newPath = newPaths.find(np => np.path === oldPath.path)
        if (newPath && oldPath.matchKey) {
          newPath.matchKey = oldPath.matchKey
        }
      })

      arrayPaths.value = newPaths
      error.value = ''
    } catch {
      arrayPaths.value = []
    }
  }

  const debouncedAnalyze = useDebounceFn(analyze, 500)

  const compareJson = () => {
    error.value = ''
    diffResult.value = []
    compared.value = false

    if (!inputA.value.trim() || !inputB.value.trim()) {
      error.value = '请输入两个 JSON 进行对比'
      return
    }

    try {
      const objA = JSON.parse(inputA.value)
      const objB = JSON.parse(inputB.value)
      diffResult.value = deepCompare(objA, objB, '', arrayPaths.value)
      compared.value = true
      saveToHistory()
    } catch (e: any) {
      error.value = `JSON 解析错误: ${e.message}`
    }
  }

  const getCountByType = (type: string) => diffResult.value.filter(d => d.type === type).length

  const toggleFilter = (type: string) => {
    const index = activeFilters.value.indexOf(type)
    if (index >= 0) {
      if (activeFilters.value.length > 1) {
        activeFilters.value.splice(index, 1)
      }
    } else {
      activeFilters.value.push(type)
    }
  }

  const sortedAndFilteredResult = computed(() => {
    let result = diffResult.value.filter(d => activeFilters.value.includes(d.type))

    if (sortOrder.value === 'default') return result
    if (sortOrder.value === 'path') return [...result].sort((a, b) => a.path.localeCompare(b.path))

    const orderMap: Record<string, Record<string, number>> = {
      'changed-removed-added': { changed: 0, removed: 1, added: 2 },
      'changed-added-removed': { changed: 0, added: 1, removed: 2 },
      'removed-changed-added': { removed: 0, changed: 1, added: 2 },
      'added-changed-removed': { added: 0, changed: 1, removed: 2 },
    }

    const order = orderMap[sortOrder.value]
    return order ? [...result].sort((a, b) => order[a.type] - order[b.type]) : result
  })

  const diffStats = computed(() => {
    const changed = diffResult.value.filter(d => d.type === 'changed').length
    const removed = diffResult.value.filter(d => d.type === 'removed').length
    const added = diffResult.value.filter(d => d.type === 'added').length
    return `修改 ${changed}, 删除 ${removed}, 新增 ${added}`
  })

  const swapInputs = () => {
    const temp = inputA.value
    inputA.value = inputB.value
    inputB.value = temp
    analyze()
  }

  const clearAll = () => {
    inputA.value = ''
    inputB.value = ''
    error.value = ''
    diffResult.value = []
    compared.value = false
    arrayPaths.value = []
  }

  const getDiffRowClass = (type: string) => {
    switch (type) {
      case 'added': return 'bg-green-50 dark:bg-green-900/20'
      case 'removed': return 'bg-red-50 dark:bg-red-900/20'
      case 'changed': return 'bg-yellow-50 dark:bg-yellow-900/20'
      default: return ''
    }
  }

  const getDiffBadgeColor = (type: string) => {
    switch (type) {
      case 'added': return 'green'
      case 'removed': return 'red'
      case 'changed': return 'yellow'
      default: return 'gray'
    }
  }

  const getDiffTypeLabel = (type: string) => {
    switch (type) {
      case 'added': return '新增'
      case 'removed': return '删除'
      case 'changed': return '修改'
      default: return type
    }
  }

  const formatValue = (value: any) => {
    if (value === undefined) return '-'
    if (typeof value === 'object') {
      const str = JSON.stringify(value)
      return str.length > 100 ? str.substring(0, 100) + '...' : str
    }
    return String(value)
  }

  const copyDiff = async () => {
    const text = sortedAndFilteredResult.value
      .map(d => `${d.path}\t${getDiffTypeLabel(d.type)}\t${formatValue(d.valueA)}\t${formatValue(d.valueB)}`)
      .join('\n')
    await navigator.clipboard.writeText(text)
    useToast().add({ title: '已复制到剪贴板', color: 'green' })
  }

  return {
    getKeyOptions,
    inputA, inputB, error, diffResult, compared, arrayPaths, sortOrder, activeFilters,
    sortOptions, filterOptions, historyList, historyMenuItems, debouncedAnalyze,
    compareJson, getCountByType, toggleFilter, sortedAndFilteredResult, diffStats,
    swapInputs, clearAll, getDiffRowClass, getDiffBadgeColor, getDiffTypeLabel,
    formatValue, copyDiff,
  }
}
