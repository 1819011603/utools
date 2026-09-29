import type { HistoryItem } from '~/composables/useHistory'
import { useHistory } from '~/composables/useHistory'

export interface JsonFormatHistory {
  input: string
}

export interface CandidateJson {
  json: string
  formatted: string
  type: 'array' | 'object'
  count: string
  source?: string
}

const STORAGE_KEY = 'json-format-settings'
const JSON_EXTRACT_IMPORT_KEY = 'json-extract-import'
const MAX_INPUT_UNDO = 100

/**
 * json-format 页面的状态、设置持久化与历史存储。
 * 不依赖 tree / editor，是拆分链的最底层（state → tree → editor）。
 */
export function useJsonFormatState() {
  const { addToHistory, getHistory, clearHistory } = useHistory<JsonFormatHistory>('json-format')

  // ─── 设置持久化 ──────────────────────────────────────────────────────────────
  const loadSettings = () => {
    if (typeof window === 'undefined') return null
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  }

  const saveSettings = () => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        indentSize: indentSize.value,
        showTree: showTree.value,
        smartParseEnabled: smartParseEnabled.value,
        unwrapOuterBrackets: unwrapOuterBrackets.value,
        editorHighlightEnabled: editorHighlightEnabled.value
      }))
    } catch (e) { console.error('保存设置失败:', e) }
  }

  const savedSettings = loadSettings()

  // ─── 状态 ────────────────────────────────────────────────────────────────────
  const input = ref('')
  const parsed = ref<any>(null)
  const error = ref('')
  const indentSize = ref(savedSettings?.indentSize ?? '2')
  const showTree = ref(savedSettings?.showTree ?? true)
  const smartParseEnabled = ref(savedSettings?.smartParseEnabled ?? true)
  const unwrapOuterBrackets = ref(savedSettings?.unwrapOuterBrackets ?? false)
  const editorHighlightEnabled = ref(savedSettings?.editorHighlightEnabled ?? true)

  const expandedPaths = ref<Set<string>>(new Set())
  const deletedPaths = ref<Set<string>>(new Set())
  const deletedStack = ref<string[]>([])
  const textareaRef = ref<any>(null)
  const preRef = ref<HTMLElement | null>(null)
  const currentExpandLevel = ref(0)
  const editorHighlightHtml = ref('')

  const candidateJsons = ref<CandidateJson[]>([])

  const inputHistorySkip = ref(false)
  const undoStack = ref<string[]>([])
  const redoStack = ref<string[]>([])

  const indentOptions = [
    { label: '2', value: '2' },
    { label: '4', value: '4' },
  ]

  // ─── 历史 ────────────────────────────────────────────────────────────────────
  const historyList = ref<HistoryItem<JsonFormatHistory>[]>([])

  const refreshHistory = () => { historyList.value = getHistory() }

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const getPreview = (data: JsonFormatHistory) => {
    const text = data.input.trim().replace(/\s+/g, ' ')
    return text.length > 50 ? text.slice(0, 50) + '...' : text
  }

  const getPreviewFull = (data: JsonFormatHistory) => {
    const text = data.input.trim().replace(/\s+/g, ' ')
    return text.length > 200 ? text.slice(0, 200) + '...' : text
  }

  const saveToHistory = () => {
    if (!input.value.trim()) return
    try {
      JSON.parse(input.value)
      addToHistory({ input: input.value })
      refreshHistory()
    } catch {}
  }

  const jumpToJsonExtract = () => {
    if (!input.value.trim()) return
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(JSON_EXTRACT_IMPORT_KEY, input.value)
      navigateTo({ path: '/json-extract', query: { from: 'json-format' } })
    } catch {
      useToast().add({ title: '跳转失败，请重试', color: 'red', timeout: 2000 })
    }
  }

  watch(unwrapOuterBrackets, (newVal) => { if (newVal) smartParseEnabled.value = true })
  watch([indentSize, showTree, smartParseEnabled, unwrapOuterBrackets, editorHighlightEnabled], saveSettings)

  onMounted(() => { refreshHistory() })

  return {
    MAX_INPUT_UNDO, addToHistory, getHistory, clearHistory,
    input, parsed, error, indentSize, showTree, smartParseEnabled, unwrapOuterBrackets,
    editorHighlightEnabled, expandedPaths, deletedPaths, deletedStack, textareaRef, preRef,
    currentExpandLevel, editorHighlightHtml, candidateJsons, inputHistorySkip, undoStack, redoStack,
    indentOptions, historyList, refreshHistory, formatTime, getPreview, getPreviewFull,
    saveToHistory, jumpToJsonExtract,
  }
}
