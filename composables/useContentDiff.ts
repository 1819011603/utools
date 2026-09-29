import { useHistory, type HistoryItem } from '~/composables/useHistory'

interface ContentDiffHistory {
  inputA: string
  inputB: string
}

export function useContentDiff() {
  const STORAGE_KEY = 'content-diff-settings'
  const { addToHistory, getHistory, clearHistory } = useHistory<ContentDiffHistory>('content-diff')

  const historyList = ref<HistoryItem<ContentDiffHistory>[]>([])

  const refreshHistory = () => {
    historyList.value = getHistory()
  }

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const getPreview = (data: ContentDiffHistory) => {
    const textA = data.inputA.trim().replace(/\s+/g, ' ')
    const textB = data.inputB.trim().replace(/\s+/g, ' ')
    const shortA = textA.length > 20 ? textA.slice(0, 20) + '...' : textA
    const shortB = textB.length > 20 ? textB.slice(0, 20) + '...' : textB
    return `A: ${shortA} B: ${shortB}`
  }

  const getPreviewFull = (data: ContentDiffHistory) => {
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
      updateCounts()
      useToast().add({ title: '已恢复', color: 'green', timeout: 1500 })
    }
  }

  const saveToHistory = () => {
    if (!inputA.value.trim() || !inputB.value.trim()) return
    addToHistory({ inputA: inputA.value, inputB: inputB.value })
    refreshHistory()
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
        operation: operation.value,
        separatorType: separatorType.value,
        customSeparator: customSeparator.value
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  const savedSettings = loadSettings()

  const inputA = ref('')
  const inputB = ref('')
  const output = ref('')
  const operation = ref(savedSettings?.operation ?? 'a-b')
  const separatorType = ref(savedSettings?.separatorType ?? 'newline')
  const customSeparator = ref(savedSettings?.customSeparator ?? '')
  const countA = ref(-1)
  const countB = ref(-1)
  const resultCount = ref(-1)

  watch([operation, separatorType, customSeparator], saveSettings)

  const separatorOptions = [
    { label: '换行', value: 'newline' },
    { label: '逗号', value: 'comma' },
    { label: '分号', value: 'semicolon' },
    { label: '空格', value: 'space' },
    { label: 'Tab', value: 'tab' },
    { label: '自定义', value: 'custom' }
  ]

  const operations = [
    { label: 'A - B', value: 'a-b' },
    { label: 'B - A', value: 'b-a' },
    { label: 'A ∩ B', value: 'intersect' },
    { label: 'A ∪ B', value: 'union' }
  ]

  const operationDescription = computed(() => {
    switch (operation.value) {
      case 'a-b': return '−'
      case 'b-a': return '被减去'
      case 'intersect': return '∩'
      case 'union': return '∪'
      default: return ''
    }
  })

  const operationHint = computed(() => {
    switch (operation.value) {
      case 'a-b': return '→ A中有但B中没有'
      case 'b-a': return '→ B中有但A中没有'
      case 'intersect': return '→ 共有元素'
      case 'union': return '→ 所有不重复元素'
      default: return ''
    }
  })

  const getSeparator = () => {
    switch (separatorType.value) {
      case 'newline': return '\n'
      case 'comma': return ','
      case 'semicolon': return ';'
      case 'space': return ' '
      case 'tab': return '\t'
      case 'custom': return customSeparator.value || '\n'
      default: return '\n'
    }
  }

  const parseInput = (input: string): string[] => {
    const sep = getSeparator()
    return input
      .split(sep)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  const updateCounts = () => {
    countA.value = inputA.value.trim() ? parseInput(inputA.value).length : -1
    countB.value = inputB.value.trim() ? parseInput(inputB.value).length : -1
  }

  const execute = () => {
    const setA = new Set(parseInput(inputA.value))
    const setB = new Set(parseInput(inputB.value))

    let result: string[] = []

    switch (operation.value) {
      case 'a-b':
        result = [...setA].filter(x => !setB.has(x))
        break
      case 'b-a':
        result = [...setB].filter(x => !setA.has(x))
        break
      case 'intersect':
        result = [...setA].filter(x => setB.has(x))
        break
      case 'union':
        result = [...new Set([...setA, ...setB])]
        break
    }

    const sep = getSeparator()
    output.value = result.join(sep === '\n' ? '\n' : sep + ' ')
    resultCount.value = result.length
    saveToHistory()
  }

  const swapInputs = () => {
    const temp = inputA.value
    inputA.value = inputB.value
    inputB.value = temp
    updateCounts()
  }

  const sortInput = (which: 'A' | 'B') => {
    const ref = which === 'A' ? inputA : inputB
    const items = parseInput(ref.value)
    items.sort((a, b) => a.localeCompare(b))
    const sep = getSeparator()
    ref.value = items.join(sep === '\n' ? '\n' : sep + ' ')
    updateCounts()
  }

  const uniqueInput = (which: 'A' | 'B') => {
    const ref = which === 'A' ? inputA : inputB
    const items = [...new Set(parseInput(ref.value))]
    const sep = getSeparator()
    ref.value = items.join(sep === '\n' ? '\n' : sep + ' ')
    updateCounts()
  }

  const trimInput = (which: 'A' | 'B') => {
    const ref = which === 'A' ? inputA : inputB
    const items = parseInput(ref.value)
    const sep = getSeparator()
    ref.value = items.join(sep === '\n' ? '\n' : sep + ' ')
    updateCounts()
  }

  const useResultAsA = () => {
    inputA.value = output.value
    updateCounts()
  }

  const useResultAsB = () => {
    inputB.value = output.value
    updateCounts()
  }

  const copyResult = async () => {
    if (output.value) {
      await navigator.clipboard.writeText(output.value)
      useToast().add({ title: '已复制到剪贴板', color: 'green' })
    }
  }

  const clearAll = () => {
    inputA.value = ''
    inputB.value = ''
    output.value = ''
    countA.value = -1
    countB.value = -1
    resultCount.value = -1
  }

  return {
    historyList,
    historyMenuItems,
    inputA,
    inputB,
    output,
    operation,
    separatorType,
    customSeparator,
    countA,
    countB,
    resultCount,
    separatorOptions,
    operations,
    operationDescription,
    operationHint,
    updateCounts,
    execute,
    swapInputs,
    sortInput,
    uniqueInput,
    trimInput,
    useResultAsA,
    useResultAsB,
    copyResult,
    clearAll
  }
}
