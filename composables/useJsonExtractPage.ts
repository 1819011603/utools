import { useDebounceFn } from '@vueuse/core'
import type { HistoryItem } from '~/composables/useHistory'
import { useHistory } from '~/composables/useHistory'
import { useJsonExtract } from '~/composables/useJsonExtract'

export interface JsonExtractHistory {
  input: string
  fieldPath: string
}

const JSON_EXTRACT_IMPORT_KEY = 'json-extract-import'
const STORAGE_KEY = 'json-extract-settings'

/**
 * json-extract 页面的全部状态与逻辑（从 `pages/json-extract.vue` 下沉）。
 */
export function useJsonExtractPage() {
  const { addToHistory, getHistory, clearHistory } = useHistory<JsonExtractHistory>('json-extract')
  const { analyzePaths, parseJqPath } = useJsonExtract()
  const route = useRoute()

  const historyList = ref<HistoryItem<JsonExtractHistory>[]>([])

  const refreshHistory = () => {
    historyList.value = getHistory()
  }

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const getPreview = (data: JsonExtractHistory) => {
    const text = data.input.trim().replace(/\s+/g, ' ')
    const shortText = text.length > 30 ? text.slice(0, 30) + '...' : text
    return `${data.fieldPath} - ${shortText}`
  }

  const getPreviewFull = (data: JsonExtractHistory) => {
    const text = data.input.trim().replace(/\s+/g, ' ')
    const fullText = text.length > 200 ? text.slice(0, 200) + '...' : text
    return `${data.fieldPath} - ${fullText}`
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
      input.value = item.data.input
      fieldPath.value = item.data.fieldPath
      extract()
      useToast().add({ title: '已恢复', color: 'green', timeout: 1500 })
    }
  }

  const saveToHistory = () => {
    if (!input.value.trim() || !fieldPath.value.trim()) return
    try {
      JSON.parse(input.value)
      addToHistory({ input: input.value, fieldPath: fieldPath.value })
      refreshHistory()
    } catch {}
  }

  onMounted(() => {
    refreshHistory()
    if (typeof window === 'undefined') return
    if (route.query.from === 'json-format') {
      const imported = localStorage.getItem(JSON_EXTRACT_IMPORT_KEY)
      if (imported) {
        input.value = imported
        debouncedExtract()
        localStorage.removeItem(JSON_EXTRACT_IMPORT_KEY)
      }
    }
  })

  const input = ref('')
  const fieldPath = ref('')
  const output = ref('')
  const error = ref('')
  const showHelp = ref(false)
  const resultCount = ref(-1)

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
        options: { ...options },
        outputFormat: outputFormat.value
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  const savedSettings = loadSettings()

  const options = reactive({
    unique: savedSettings?.options?.unique ?? true,
    sort: savedSettings?.options?.sort ?? false,
    reverse: savedSettings?.options?.reverse ?? false,
    compact: savedSettings?.options?.compact ?? true
  })

  const outputFormat = ref(savedSettings?.outputFormat ?? 'lines')
  const formatOptions = [
    { label: '每行一个', value: 'lines' },
    { label: 'JSON 数组', value: 'json' },
    { label: '逗号分隔', value: 'csv' }
  ]

  const suggestedPaths = ref<string[]>([])

  const syntaxExamples = [
    { syntax: '.field', desc: '获取字段值' },
    { syntax: '.field1.field2', desc: '获取嵌套字段' },
    { syntax: '.array[]', desc: '展开数组' },
    { syntax: '.array[].field', desc: '获取数组中每个元素的字段' },
    { syntax: '.array[0]', desc: '获取数组第一个元素' },
    { syntax: '.array[-1]', desc: '获取数组最后一个元素' },
    { syntax: '.array[0:3]', desc: '获取数组前3个元素' },
    { syntax: '.[].field1,field2', desc: '获取多个字段' }
  ]

  const exampleJson = `{
  "users": [
    { "id": 1, "name": "Alice", "age": 25, "city": "北京" },
    { "id": 2, "name": "Bob", "age": 30, "city": "上海" },
    { "id": 3, "name": "Charlie", "age": 25, "city": "北京" }
  ],
  "total": 3,
  "meta": { "version": "1.0" }
}`

  const extractExamples = [
    { path: '.users[].name', result: 'Alice, Bob, Charlie' },
    { path: '.users[].id', result: '1, 2, 3' },
    { path: '.users[0].name', result: 'Alice' },
    { path: '.users[].city', result: '北京, 上海, 北京 (去重后: 北京, 上海)' },
    { path: '.meta.version', result: '1.0' }
  ]

  const extract = () => {
    error.value = ''
    output.value = ''
    resultCount.value = -1

    if (!input.value.trim()) {
      error.value = '请输入 JSON 数据'
      return
    }

    if (!fieldPath.value.trim()) {
      error.value = '请输入字段路径'
      return
    }

    try {
      const obj = JSON.parse(input.value)
      let results = parseJqPath(fieldPath.value.trim(), obj)

      if (options.compact) {
        results = results.filter(v => v !== null && v !== undefined && v !== '')
      }

      if (options.unique) {
        const seen = new Set()
        results = results.filter(v => {
          const key = typeof v === 'object' ? JSON.stringify(v) : String(v)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }

      if (options.sort) {
        results.sort((a, b) => {
          if (typeof a === 'number' && typeof b === 'number') return a - b
          return String(a).localeCompare(String(b))
        })
      }

      if (options.reverse) {
        results.reverse()
      }

      resultCount.value = results.length

      switch (outputFormat.value) {
        case 'json':
          output.value = JSON.stringify(results, null, 2)
          break
        case 'csv':
          output.value = results.map(v =>
            typeof v === 'object' ? JSON.stringify(v) : String(v)
          ).join(', ')
          break
        default:
          output.value = results.map(v =>
            typeof v === 'object' ? JSON.stringify(v) : String(v)
          ).join('\n')
      }

      suggestedPaths.value = analyzePaths(obj)
      saveToHistory()
    } catch (e: any) {
      error.value = `解析错误: ${e.message}`
    }
  }

  const debouncedExtract = useDebounceFn(() => {
    if (input.value.trim()) {
      try {
        const obj = JSON.parse(input.value)
        suggestedPaths.value = analyzePaths(obj)
        if (fieldPath.value.trim()) {
          extract()
        }
      } catch {
        suggestedPaths.value = []
      }
    }
  }, 500)

  const usePath = (path: string) => {
    fieldPath.value = path
    extract()
  }

  const autoExtract = () => {
    if (input.value.trim() && fieldPath.value.trim()) {
      extract()
    }
    saveSettings()
  }

  const loadExample = () => {
    input.value = exampleJson
    fieldPath.value = '.users[].name'
    showHelp.value = false
    extract()
  }

  const copyResult = async () => {
    if (output.value) {
      await navigator.clipboard.writeText(output.value)
      useToast().add({ title: '已复制到剪贴板', color: 'green' })
    }
  }

  const clearAll = () => {
    input.value = ''
    fieldPath.value = ''
    output.value = ''
    error.value = ''
    resultCount.value = -1
    suggestedPaths.value = []
  }

  return {
    input, fieldPath, output, error, showHelp, resultCount, options, outputFormat, formatOptions,
    suggestedPaths, syntaxExamples, exampleJson, extractExamples, historyList, historyMenuItems,
    debouncedExtract, extract, usePath, autoExtract, loadExample, copyResult, clearAll, saveSettings,
  }
}
