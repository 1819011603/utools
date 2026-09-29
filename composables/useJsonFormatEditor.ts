import { useDebounceFn, useEventListener } from '@vueuse/core'
import { useJsonFormat } from '~/composables/useJsonFormat'
import type { CandidateJson, useJsonFormatState } from '~/composables/useJsonFormatState'
import type { useJsonFormatTree } from '~/composables/useJsonFormatTree'

/**
 * json-format 页面的编辑区逻辑：智能解析/候选、格式化/压缩、撤销重做、
 * 语法高亮、快捷键、历史菜单应用、清空。
 * 依赖 state 与 tree（state → tree → editor）。
 */
export function useJsonFormatEditor(
  state: ReturnType<typeof useJsonFormatState>,
  tree: ReturnType<typeof useJsonFormatTree>,
) {
  const { resolveToJson, highlightJson, extractAllJsonFromText, extractEscapedJson, tryUnwrap } = useJsonFormat()
  const {
    input, parsed, error, indentSize, unwrapOuterBrackets, editorHighlightEnabled, smartParseEnabled,
    candidateJsons, expandedPaths, deletedPaths, deletedStack, currentExpandLevel,
    editorHighlightHtml, textareaRef, historyList, refreshHistory, formatTime, getPreview,
    getPreviewFull, clearHistory, saveToHistory, jumpToJsonExtract, inputHistorySkip,
    undoStack, redoStack, MAX_INPUT_UNDO,
  } = state
  const { collectPaths, maxDepth, copyAll, syncEditorScroll } = tree

  const bumpEditorHighlight = useDebounceFn(() => {
    editorHighlightHtml.value = highlightJson(input.value)
  }, 120)

  // ─── 粘贴 & 智能解析 ─────────────────────────────────────────────────────────
  const onPaste = (_e: ClipboardEvent) => {
    if (!smartParseEnabled.value) return
    setTimeout(() => { autoSmartParse() }, 50)
  }

  const autoSmartParse = () => {
    error.value = ''
    candidateJsons.value = []
    if (!input.value.trim()) return

    const text = input.value.trim()

    // 尝试直接解析整个文本
    try {
      let obj = JSON.parse(text)

      // messages+time 特殊处理：只关注 messages 字段
      if (
        obj && typeof obj === 'object' && !Array.isArray(obj) &&
        'messages' in obj && 'time' in obj
      ) {
        const messagesResolved = resolveToJson(obj.messages)
        if (messagesResolved !== null) {
          // messages 本身就是 JSON
          applyJson(JSON.stringify(messagesResolved))
          return
        }
        // messages 是纯文本，从文本中提取 JSON 候选
        if (typeof obj.messages === 'string') {
          const msgText = obj.messages
          const msgCandidates: CandidateJson[] = []
          extractAllJsonFromText(msgText).forEach(s => addCandidate(msgCandidates, s))
          extractEscapedJson(msgText).forEach(s => addCandidate(msgCandidates, s, '转义'))
          msgCandidates.sort((a, b) => b.json.length - a.json.length)
          if (msgCandidates.length > 20) msgCandidates.splice(20)
          if (msgCandidates.length === 1) {
            applyJson(msgCandidates[0].json)
            return
          } else if (msgCandidates.length > 1) {
            candidateJsons.value = msgCandidates
            return
          }
        }
        // messages 中也没有 JSON，正常处理整个对象
      }

      // 检测字符串字段中的转义 JSON（如 uid、data 等字段）
      const embedded = extractEscapedJson(text)
      if (embedded.length > 0) {
        const embCandidates: CandidateJson[] = []
        addCandidate(embCandidates, JSON.stringify(obj))
        embedded.forEach(s => addCandidate(embCandidates, s, '转义'))
        embCandidates.sort((a, b) => b.json.length - a.json.length)
        if (embCandidates.length > 20) embCandidates.splice(20)
        if (embCandidates.length > 1) {
          candidateJsons.value = embCandidates
          return
        }
      }

      if (unwrapOuterBrackets.value) {
        obj = tryUnwrap(obj)
      }
      input.value = JSON.stringify(obj, null, Number(indentSize.value))
      parsed.value = obj
      expandedPaths.value = new Set(collectPaths(obj))
      deletedPaths.value = new Set()
      deletedStack.value = []
      currentExpandLevel.value = maxDepth.value
      saveToHistory()
      return
    } catch {}

    // 不是有效 JSON，从文本中提取候选
    const candidates: CandidateJson[] = []
    extractAllJsonFromText(text).forEach(jsonStr => addCandidate(candidates, jsonStr))
    extractEscapedJson(text).forEach(jsonStr => addCandidate(candidates, jsonStr, '转义'))

    candidates.sort((a, b) => b.json.length - a.json.length)
    if (candidates.length > 20) candidates.splice(20)

    if (candidates.length === 0) {
      parseAndShow(false)
    } else if (candidates.length === 1) {
      // 单候选直接 apply
      applyJson(candidates[0].json)
    } else {
      candidateJsons.value = candidates
    }
  }

  const addCandidate = (candidates: CandidateJson[], jsonStr: string, source?: string) => {
    try {
      let data = JSON.parse(jsonStr)
      if (unwrapOuterBrackets.value) {
        data = tryUnwrap(data)
      }
      const normalized = JSON.stringify(data)
      const formatted = JSON.stringify(data, null, Number(indentSize.value))
      const isArray = Array.isArray(data)
      const count = isArray ? `${data.length} 项` : `${Object.keys(data).length} 个键`

      const isDuplicate = candidates.some(c => {
        try {
          let candidateData = JSON.parse(c.json)
          if (unwrapOuterBrackets.value) candidateData = tryUnwrap(candidateData)
          return JSON.stringify(candidateData) === normalized
        } catch { return false }
      })

      if (!isDuplicate) {
        candidates.push({ json: jsonStr, formatted, type: isArray ? 'array' : 'object', count, source })
      }
    } catch {}
  }

  const applyJson = (jsonStr: string) => {
    try {
      let data = JSON.parse(jsonStr)
      if (unwrapOuterBrackets.value) {
        data = tryUnwrap(data)
      }
      input.value = JSON.stringify(data, null, Number(indentSize.value))
      parsed.value = data
      expandedPaths.value = new Set(collectPaths(data))
      deletedPaths.value = new Set()
      deletedStack.value = []
      currentExpandLevel.value = maxDepth.value
      candidateJsons.value = []
      saveToHistory()
    } catch (e: any) {
      error.value = e.message
    }
  }

  const selectCandidateJson = (candidate: CandidateJson) => {
    applyJson(candidate.json)
    useToast().add({ title: '已应用', color: 'green', timeout: 1200 })
  }

  const copyCandidateJson = (candidate: CandidateJson) => {
    navigator.clipboard.writeText(candidate.formatted)
    useToast().add({ title: '已复制', color: 'green', timeout: 1200 })
  }

  // ─── 历史 ────────────────────────────────────────────────────────────────────
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
      parseAndShow(false)
      useToast().add({ title: '已恢复', color: 'green', timeout: 1500 })
    }
  }

  // ─── 解析 & 格式化 ────────────────────────────────────────────────────────────
  // 不修改 input.value，仅更新右侧展示（树形或候选列表）
  const parseAndShow = (saveHistory = false) => {
    error.value = ''
    candidateJsons.value = []
    if (!input.value.trim()) { parsed.value = null; return }

    const text = input.value.trim()

    try {
      let obj = JSON.parse(text)

      // messages+time 特殊处理：只关注 messages 字段
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'messages' in obj && 'time' in obj) {
        const messagesResolved = resolveToJson(obj.messages)
        if (messagesResolved !== null) {
          // messages 本身就是 JSON
          parsed.value = messagesResolved
          expandedPaths.value = new Set(collectPaths(messagesResolved))
          deletedPaths.value = new Set()
          deletedStack.value = []
          currentExpandLevel.value = maxDepth.value
          if (saveHistory) saveToHistory()
          return
        }
        // messages 是纯文本，从文本中提取 JSON 候选
        if (typeof obj.messages === 'string') {
          const msgText = obj.messages
          const msgCandidates: CandidateJson[] = []
          extractAllJsonFromText(msgText).forEach(s => addCandidate(msgCandidates, s))
          extractEscapedJson(msgText).forEach(s => addCandidate(msgCandidates, s, '转义'))
          msgCandidates.sort((a, b) => b.json.length - a.json.length)
          if (msgCandidates.length > 20) msgCandidates.splice(20)
          if (msgCandidates.length === 1) {
            parsed.value = JSON.parse(msgCandidates[0].json)
            expandedPaths.value = new Set(collectPaths(parsed.value))
            deletedPaths.value = new Set()
            deletedStack.value = []
            currentExpandLevel.value = maxDepth.value
            if (saveHistory) saveToHistory()
            return
          } else if (msgCandidates.length > 1) {
            candidateJsons.value = msgCandidates
            parsed.value = null
            return
          }
        }
        // messages 中也没有 JSON，正常处理整个对象
      }

      // 检测字符串字段中的转义 JSON（如 uid、data 等字段）
      const embedded = extractEscapedJson(text)
      if (embedded.length > 0) {
        const embCandidates: CandidateJson[] = []
        addCandidate(embCandidates, JSON.stringify(obj))
        embedded.forEach(s => addCandidate(embCandidates, s, '转义'))
        embCandidates.sort((a, b) => b.json.length - a.json.length)
        if (embCandidates.length > 20) embCandidates.splice(20)
        if (embCandidates.length > 1) {
          candidateJsons.value = embCandidates
          parsed.value = null
          return
        }
      }

      if (unwrapOuterBrackets.value) obj = tryUnwrap(obj)
      parsed.value = obj
      if (expandedPaths.value.size === 0) {
        expandedPaths.value = new Set(collectPaths(obj))
        deletedPaths.value = new Set()
        deletedStack.value = []
        currentExpandLevel.value = maxDepth.value
      }
      if (saveHistory) saveToHistory()
      return
    } catch {}

    // 不是合法 JSON：智能提取候选
    const candidates: CandidateJson[] = []
    extractAllJsonFromText(text).forEach(jsonStr => addCandidate(candidates, jsonStr))
    extractEscapedJson(text).forEach(jsonStr => addCandidate(candidates, jsonStr, '转义'))
    candidates.sort((a, b) => b.json.length - a.json.length)
    if (candidates.length > 20) candidates.splice(20)

    if (candidates.length === 0) {
      // 无候选才报解析错误
      try { JSON.parse(text) } catch (e: any) { error.value = e.message }
      parsed.value = null
    } else if (candidates.length === 1) {
      // 单候选：直接在右侧展示树形，不改左侧文本
      try {
        let data = JSON.parse(candidates[0].json)
        if (unwrapOuterBrackets.value) data = tryUnwrap(data)
        parsed.value = data
        expandedPaths.value = new Set(collectPaths(data))
        deletedPaths.value = new Set()
        deletedStack.value = []
        currentExpandLevel.value = maxDepth.value
      } catch {}
    } else {
      candidateJsons.value = candidates
      parsed.value = null
    }
  }

  const debouncedParse = useDebounceFn(() => parseAndShow(false), 300)

  const onEditorInput = () => {
    debouncedParse()
  }

  watch(unwrapOuterBrackets, () => { if (!input.value.trim()) return; formatJson() })

  watch([input, editorHighlightEnabled], () => {
    if (editorHighlightEnabled.value) bumpEditorHighlight()
    else editorHighlightHtml.value = ''
  }, { immediate: true })

  watch(input, (_nv, ov) => {
    if (inputHistorySkip.value) return
    if (ov === undefined) return
    undoStack.value.push(ov)
    if (undoStack.value.length > MAX_INPUT_UNDO) undoStack.value.shift()
    redoStack.value = []
  })

  const undoInput = () => {
    if (undoStack.value.length === 0) return false
    inputHistorySkip.value = true
    const prev = undoStack.value.pop()!
    redoStack.value.push(input.value)
    input.value = prev
    parseAndShow(false)
    nextTick(() => {
      inputHistorySkip.value = false
      syncEditorScroll()
    })
    return true
  }

  const redoInput = () => {
    if (redoStack.value.length === 0) return false
    inputHistorySkip.value = true
    const next = redoStack.value.pop()!
    undoStack.value.push(input.value)
    input.value = next
    parseAndShow(false)
    nextTick(() => {
      inputHistorySkip.value = false
      syncEditorScroll()
    })
    return true
  }

  const jsonTextareaFocused = () => {
    const ta = textareaRef.value as HTMLTextAreaElement | undefined
    return !!(ta && document.activeElement === ta)
  }

  useEventListener(() => (typeof window !== 'undefined' ? window : null), 'keydown', (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return

    if (e.key === 'z' || e.key === 'Z') {
      if (!jsonTextareaFocused()) return
      if (e.shiftKey) {
        if (redoStack.value.length > 0) {
          e.preventDefault()
          redoInput()
        }
      } else if (undoStack.value.length > 0) {
        e.preventDefault()
        undoInput()
      }
      return
    }
    if ((e.key === 'y' || e.key === 'Y') && !e.shiftKey) {
      if (!jsonTextareaFocused()) return
      if (redoStack.value.length > 0) {
        e.preventDefault()
        redoInput()
      }
      return
    }

    if (!e.shiftKey) return
    const k = e.key.toLowerCase()
    if (k === 'f') {
      e.preventDefault()
      formatJson()
      return
    }
    if (k === 'm') {
      e.preventDefault()
      compressJson()
      return
    }
    if (k === 'c') {
      e.preventDefault()
      void copyAll()
      return
    }
    if (k === 'x') {
      e.preventDefault()
      clearAll()
      return
    }
    if (k === 'e') {
      e.preventDefault()
      jumpToJsonExtract()
    }
  })

  const formatJson = () => {
    error.value = ''
    if (!input.value.trim()) return
    parseAndShow(true)
  }

  const compressJson = () => {
    error.value = ''
    if (!input.value.trim()) return
    try {
      const obj = JSON.parse(input.value)
      input.value = JSON.stringify(obj)
      parsed.value = obj
      saveToHistory()
    } catch (e: any) { error.value = e.message }
  }

  const clearAll = () => {
    input.value = ''
    parsed.value = null
    error.value = ''
    expandedPaths.value = new Set()
    candidateJsons.value = []
    undoStack.value = []
    redoStack.value = []
  }

  return {
    formatJson, compressJson, onEditorInput, onPaste, selectCandidateJson, copyCandidateJson,
    historyMenuItems, clearAll, undoInput, redoInput, highlightJson, bumpEditorHighlight,
  }
}
