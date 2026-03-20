<template>
  <!-- 突破 layout main 的 padding，横向占满视口；内层与顶栏同款 max-w-7xl + px，左右与导航内容对齐 -->
  <div class="json-format-bleed w-screen ml-[calc(50%-50vw)] max-w-[100vw] min-w-0 box-border">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <UAlert v-if="error" color="red" class="mb-3">
      <template #title>JSON 解析错误</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <div class="grid gap-4 items-start grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <!-- 左栏：设置、操作（宽度与输入框对齐，不占用树形上方区域） -->
      <div class="min-w-0 flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <UCheckbox v-model="smartParseEnabled" label="智能解析" />
          <UCheckbox v-model="unwrapOuterBrackets" label="去外围括号" />
          <UCheckbox v-model="showTree" label="树形预览" />
          <UCheckbox v-model="editorHighlightEnabled" label="左侧语法高亮" />
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-gray-600 dark:text-gray-400">缩进:</span>
            <USelect v-model="indentSize" :options="indentOptions" size="xs" class="w-[4.5rem]" />
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5 text-xs">
          <UButton size="xs" @click="formatJson" color="primary" title="⌘/Ctrl+Shift+F">
            <UIcon name="i-heroicons-code-bracket" class="w-3.5 h-3.5 mr-0.5" />
            格式化
          </UButton>
          <UButton size="xs" @click="compressJson" variant="outline" title="⌘/Ctrl+Shift+M">
            <UIcon name="i-heroicons-arrows-pointing-in" class="w-3.5 h-3.5 mr-0.5" />
            压缩
          </UButton>
          <UButton size="xs" @click="jumpToJsonExtract" variant="outline" :disabled="!input.trim()" title="⌘/Ctrl+Shift+E">
            <UIcon name="i-heroicons-funnel" class="w-3.5 h-3.5 mr-0.5" />
            去JSON提取
          </UButton>
          <UButton size="xs" @click="copyAll" variant="outline" :disabled="!input.trim()" title="⌘/Ctrl+Shift+C">
            <UIcon name="i-heroicons-clipboard-document" class="w-3.5 h-3.5 mr-0.5" />
            复制
          </UButton>
          <UButton size="xs" @click="clearAll" variant="ghost" color="red" title="⌘/Ctrl+Shift+X">
            <UIcon name="i-heroicons-trash" class="w-3.5 h-3.5 mr-0.5" />
            清空
          </UButton>

          <UDropdown :items="historyMenuItems" :popper="{ placement: 'bottom-start' }" :ui="{ width: 'w-[min(640px,100vw-2rem)]', container: 'w-[min(640px,100vw-2rem)]' }">
            <UButton variant="outline" size="xs" :disabled="historyList.length === 0">
              <UIcon name="i-heroicons-clock" class="w-3.5 h-3.5 mr-0.5" />
              历史 ({{ historyList.length }})
            </UButton>
            <template #item="{ item }">
              <div class="max-w-[min(640px,85vw)]">
                <UTooltip v-if="item.preview" :text="item.preview" :popper="{ placement: 'right' }">
                  <span class="block truncate">{{ item.label }}</span>
                </UTooltip>
                <span v-else class="block truncate">{{ item.label }}</span>
              </div>
            </template>
          </UDropdown>
        </div>
        <p class="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
          编辑区聚焦时：⌘/Ctrl+Z 撤销 · ⌘/Ctrl+Shift+Z 或 Ctrl+Y 重做
        </p>

        <div class="flex justify-between items-center mb-1 min-h-[1.25rem] pt-0.5">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 leading-tight">
            JSON 内容
            <span v-if="stats" class="text-gray-500 font-normal ml-2">({{ stats }})</span>
          </label>
        </div>
        <div
          v-if="editorHighlightEnabled"
          class="json-editor-shell relative rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 h-[780px] overflow-hidden ring-offset-0 focus-within:ring-2 focus-within:ring-primary-500"
        >
          <pre
            ref="preRef"
            class="json-editor-layer font-mono text-xs absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-left leading-relaxed pointer-events-none tab-size-4"
            spellcheck="false"
            v-html="editorHighlightHtml"
          />
          <textarea
            ref="textareaRef"
            v-model="input"
            placeholder="粘贴或输入 JSON 数据..."
            spellcheck="false"
            class="json-editor-layer font-mono text-xs absolute inset-0 w-full h-full resize-none overflow-auto whitespace-pre-wrap break-all px-3 py-2 leading-relaxed bg-transparent text-transparent caret-gray-900 dark:caret-gray-100 selection:bg-primary-400/35 dark:selection:bg-primary-500/40 rounded-lg border-0 focus:outline-none z-[1] tab-size-4"
            @scroll="syncEditorScroll"
            @input="onEditorInput"
            @paste="onPaste"
          />
        </div>
        <textarea
          v-else
          ref="textareaRef"
          v-model="input"
          rows="34"
          placeholder="粘贴或输入 JSON 数据..."
          class="font-mono text-xs w-full h-[780px] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y leading-relaxed whitespace-pre-wrap break-all"
          @input="onEditorInput"
          @paste="onPaste"
        />
      </div>

      <!-- 右侧：候选列表 / 树形预览（占满剩余宽度） -->
      <div class="min-w-0 self-start w-full">
        <!-- 候选 JSON 列表 -->
        <template v-if="candidateJsons.length > 0">
          <div class="flex items-center justify-between mb-1 min-h-[1.25rem]">
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
              检测到 {{ candidateJsons.length }} 个 JSON，点击卡片选择：
            </span>
          </div>
          <div class="space-y-2 max-h-[860px] overflow-auto pr-1">
            <div
              v-for="(candidate, index) in candidateJsons"
              :key="index"
              class="border rounded-xl p-4 cursor-pointer hover:border-primary-400 dark:hover:border-primary-500 hover:shadow-md transition-all dark:border-gray-700 bg-white dark:bg-gray-900"
              @click="selectCandidateJson(candidate)"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <UBadge :color="candidate.type === 'array' ? 'blue' : 'green'" size="sm">
                    {{ candidate.type === 'array' ? '数组' : '对象' }}
                  </UBadge>
                  <span class="text-sm text-gray-600 dark:text-gray-400">{{ candidate.count }}</span>
                  <span v-if="candidate.source" class="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">{{ candidate.source }}</span>
                </div>
                <UButton size="xs" variant="ghost" @click.stop="copyCandidateJson(candidate)" title="复制">
                  <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4" />
                  复制
                </UButton>
              </div>
              <pre class="text-xs font-mono bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all leading-relaxed" v-html="highlightJson(candidate.formatted)"></pre>
            </div>
          </div>
        </template>

        <!-- 树形预览 -->
        <template v-else-if="showTree && parsed">
          <div class="flex flex-wrap justify-between items-center gap-y-1 mb-1 min-h-[1.25rem]">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 leading-tight">
              树形预览
              <span v-if="currentMaxDepth > 0" class="text-gray-500 font-normal ml-2">
                (当前展开{{ currentMaxDepth >= maxDepth ? '全部' : `到第 ${currentMaxDepth} 层` }})
              </span>
            </label>
            <div class="flex flex-wrap gap-0.5 items-center">
              <div class="flex items-center gap-0.5 mr-1">
                <UButton @click="expandToLevel(currentExpandLevel - 1)" variant="ghost" size="xs" :disabled="currentExpandLevel <= 0">
                  <UIcon name="i-heroicons-minus" class="w-3.5 h-3.5" />
                </UButton>
                <span class="text-[11px] text-gray-600 dark:text-gray-400 min-w-[52px] text-center leading-none">
                  {{ currentExpandLevel === maxDepth ? '全部' : `${currentExpandLevel} 层` }}
                </span>
                <UButton @click="expandToLevel(currentExpandLevel + 1)" variant="ghost" size="xs" :disabled="currentExpandLevel >= maxDepth">
                  <UIcon name="i-heroicons-plus" class="w-3.5 h-3.5" />
                </UButton>
              </div>
              <UButton @click="expandAll" variant="ghost" size="xs" title="全部展开">
                <UIcon name="i-heroicons-arrows-pointing-out" class="w-3.5 h-3.5" />
              </UButton>
              <UButton @click="collapseAll" variant="ghost" size="xs" title="全部收起">
                <UIcon name="i-heroicons-arrows-pointing-in" class="w-3.5 h-3.5" />
              </UButton>
              <UButton @click="undoDelete" variant="ghost" size="xs" :disabled="deletedStack.length === 0" class="!px-1.5 text-[11px]">
                撤销删除
              </UButton>
              <UButton @click="restoreAllDeleted" variant="ghost" size="xs" :disabled="deletedPaths.size === 0" class="!px-1.5 text-[11px]">
                恢复全部
              </UButton>
            </div>
          </div>
          <div class="h-[780px] overflow-auto rounded-lg bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-800 shadow-sm p-2">
            <div class="font-mono text-xs json-tree">
              <JsonNode
                :data="parsed"
                :path="''"
                :depth="0"
                :expanded-paths="expandedPaths"
                :deleted-paths="deletedPaths"
                @toggle="togglePath"
                @copy="copyNode"
                @locate="locateInJson"
                @delete="deletePath"
              />
            </div>
          </div>
        </template>

        <!-- 空占位 -->
        <template v-else>
          <div class="h-[780px] flex flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100/80 dark:from-gray-900/40 dark:to-gray-800/20 border border-gray-200 dark:border-gray-700/50">
            <div class="text-center space-y-4 px-10">
              <div class="w-20 h-20 mx-auto rounded-2xl bg-white dark:bg-gray-800 shadow-sm flex items-center justify-center">
                <UIcon name="i-heroicons-code-bracket-square" class="w-10 h-10 text-gray-400 dark:text-gray-500" />
              </div>
              <div>
                <p class="text-gray-600 dark:text-gray-400 font-medium text-base mb-1">在左侧输入 JSON 数据</p>
                <p class="text-gray-400 dark:text-gray-600 text-sm">支持格式化、智能提取、树形预览</p>
              </div>
              <div class="flex flex-col gap-2 text-xs text-gray-400 dark:text-gray-600 bg-white/70 dark:bg-gray-800/40 rounded-xl p-4 text-left">
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  标准 JSON 格式化 &amp; 压缩
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  日志文本中自动提取 JSON 候选
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  识别字段中的转义 JSON（最多 3 层嵌套）
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  messages+time 日志结构自动解析
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDebounceFn, useEventListener } from '@vueuse/core'
import type { HistoryItem } from '~/composables/useHistory'

interface JsonFormatHistory {
  input: string
}

const STORAGE_KEY = 'json-format-settings'
const JSON_EXTRACT_IMPORT_KEY = 'json-extract-import'
const { addToHistory, getHistory, clearHistory } = useHistory<JsonFormatHistory>('json-format')

// ─── 工具：将值解析为 JSON 对象/数组（递归去转义，最多 depth 层）──────────────
const resolveToJson = (val: any, depth = 3): any => {
  // 已经是对象/数组，直接返回
  if (typeof val === 'object' && val !== null) return val
  // 字符串：尝试 JSON.parse，可能多层转义
  if (typeof val === 'string' && depth > 0) {
    const trimmed = val.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      const result = JSON.parse(trimmed)
      // 如果解析结果还是字符串，继续递归
      if (typeof result === 'string') return resolveToJson(result, depth - 1)
      return result
    } catch {
      return null
    }
  }
  return null
}

// ─── 语法高亮 ────────────────────────────────────────────────────────────────
const highlightJson = (json: string): string => {
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-hl-key">${match}</span>`
        return `<span class="json-hl-string">${match}</span>`
      }
      if (/true|false/.test(match)) return `<span class="json-hl-boolean">${match}</span>`
      if (/null/.test(match)) return `<span class="json-hl-null">${match}</span>`
      return `<span class="json-hl-number">${match}</span>`
    }
  )
}

const preRef = ref<HTMLElement | null>(null)

const syncEditorScroll = () => {
  const ta = textareaRef.value as HTMLTextAreaElement | undefined
  const pre = preRef.value
  if (ta && pre) {
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }
}

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

// 从文本中提取所有独立 JSON 片段（子串自动排除：找到父级后跳过其范围）
const extractAllJsonFromText = (text: string): string[] => {
  const results: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '{' || text[i] === '[') {
      const startChar = text[i]
      const endChar = startChar === '{' ? '}' : ']'
      let depth = 1
      let j = i + 1
      let inString = false
      let escaped = false

      while (j < text.length && depth > 0) {
        const char = text[j]
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = !inString
        } else if (!inString) {
          if (char === startChar) depth++
          else if (char === endChar) depth--
        }
        j++
      }

      if (depth === 0) {
        const jsonStr = text.slice(i, j)
        try {
          JSON.parse(jsonStr)
          results.push(jsonStr)
          i = j  // 跳过已匹配区域，子串不会被二次提取
          continue
        } catch {}
      }
    }
    i++
  }
  return results
}

// 提取转义 JSON 字符串（最多递归 3 层）
const extractEscapedJson = (text: string, depth = 3): string[] => {
  if (depth <= 0) return []
  const results: string[] = []
  const pattern = /"(?:[^"\\]|\\.)*"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    try {
      const unescaped = JSON.parse(match[0])
      if (typeof unescaped === 'string') {
        const trimmed = unescaped.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            JSON.parse(trimmed)
            results.push(trimmed)
            if (depth > 1) {
              results.push(...extractEscapedJson(trimmed, depth - 1))
            }
          } catch {}
        }
      }
    } catch {}
  }
  return results
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

const tryUnwrap = (obj: any): any => {
  if (Array.isArray(obj) && obj.length === 1) return obj[0]
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const keys = Object.keys(obj)
    if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
      return obj[keys[0]]
    }
  }
  return obj
}

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

const saveToHistory = () => {
  if (!input.value.trim()) return
  try {
    JSON.parse(input.value)
    addToHistory({ input: input.value })
    refreshHistory()
  } catch {}
}

onMounted(() => { refreshHistory() })

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
const currentExpandLevel = ref(0)
const editorHighlightHtml = ref('')
const bumpEditorHighlight = useDebounceFn(() => {
  editorHighlightHtml.value = highlightJson(input.value)
}, 120)

interface CandidateJson {
  json: string
  formatted: string
  type: 'array' | 'object'
  count: string
  source?: string
}
const candidateJsons = ref<CandidateJson[]>([])

const MAX_INPUT_UNDO = 100
const inputHistorySkip = ref(false)
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])

watch(unwrapOuterBrackets, (newVal) => { if (newVal) smartParseEnabled.value = true })
watch([indentSize, showTree, smartParseEnabled, unwrapOuterBrackets, editorHighlightEnabled], saveSettings)
watch(unwrapOuterBrackets, () => { if (!input.value.trim()) return; formatJson() })

watch([input, editorHighlightEnabled], () => {
  if (editorHighlightEnabled.value) bumpEditorHighlight()
  else editorHighlightHtml.value = ''
}, { immediate: true })

const indentOptions = [
  { label: '2', value: '2' },
  { label: '4', value: '4' },
]

// ─── 路径工具 ────────────────────────────────────────────────────────────────
const getPathDepth = (path: string): number => {
  if (!path) return 0
  let segments = 1
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '.') segments++
    else if (path[i] === '[') segments++
  }
  return segments
}

const getMaxDepthInData = (obj: any, currentDepth = 0): number => {
  if (typeof obj !== 'object' || obj === null) return currentDepth
  const childDepth = currentDepth + 1
  let maxChildDepth = childDepth
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        maxChildDepth = Math.max(maxChildDepth, getMaxDepthInData(item, childDepth))
      }
    })
  } else {
    Object.values(obj).forEach(value => {
      if (typeof value === 'object' && value !== null) {
        maxChildDepth = Math.max(maxChildDepth, getMaxDepthInData(value, childDepth))
      }
    })
  }
  return maxChildDepth
}

const maxDepth = computed(() => {
  if (!parsed.value) return 0
  return getMaxDepthInData(parsed.value)
})

const currentMaxDepth = computed(() => {
  if (expandedPaths.value.size === 0) return 0
  const arr = Array.from(expandedPaths.value)
  if (arr.length === 0) return 0
  return Math.max(...arr.map(p => getPathDepth(p) + 1), 0)
})

const stats = computed(() => {
  if (!parsed.value) return ''
  if (Array.isArray(parsed.value)) return `数组, ${parsed.value.length} 项`
  return `对象, ${Object.keys(parsed.value).length} 个键`
})

const collectPaths = (obj: any, prefix = '', depth = 0): string[] => {
  const paths: string[] = []
  if (Array.isArray(obj)) {
    paths.push(prefix)
    obj.forEach((item, index) => {
      if (typeof item === 'object' && item !== null) {
        paths.push(...collectPaths(item, `${prefix}[${index}]`, depth + 1))
      }
    })
  } else if (typeof obj === 'object' && obj !== null) {
    paths.push(prefix)
    Object.entries(obj).forEach(([key, value]) => {
      const newPath = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'object' && value !== null) {
        paths.push(...collectPaths(value, newPath, depth + 1))
      }
    })
  }
  return paths
}

const expandToLevel = (level: number) => {
  if (!parsed.value) return
  if (level <= 0) {
    expandedPaths.value = new Set()
    currentExpandLevel.value = 0
    return
  }
  if (level > maxDepth.value) level = maxDepth.value
  const allPaths = collectPaths(parsed.value)
  const newExpanded = new Set<string>()
  const levelNum = Number(level)
  for (const path of allPaths) {
    if (getPathDepth(path) < levelNum) newExpanded.add(path)
  }
  expandedPaths.value = new Set(newExpanded)
  currentExpandLevel.value = levelNum
}


const locateInJson = (path: string) => {
  const textarea = textareaRef.value as HTMLTextAreaElement | null
  if (!textarea || !input.value.trim()) return
  // 从路径末尾提取 key 名（非数字）
  const keyMatch = path.match(/(?:^|[.\[])([^\d.\[\]][^\].]*)(?:\].*)?$/)
  const lastKey = keyMatch ? keyMatch[1] : null
  if (!lastKey) {
    useToast().add({ title: '定位暂不支持数组项', color: 'orange', timeout: 1500 })
    return
  }
  const searchStr = `"${lastKey}"`
  const text = input.value
  const idx = text.indexOf(searchStr)
  if (idx === -1) {
    useToast().add({ title: '定位失败', description: '未找到对应键', color: 'orange', timeout: 1500 })
    return
  }
  const line = (text.slice(0, idx).match(/\n/g) || []).length + 1
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(idx, idx + searchStr.length)
    const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20
    textarea.scrollTop = Math.max(0, (line - 4) * lineHeight)
    useToast().add({ title: '已定位', description: `第 ${line} 行`, color: 'blue', timeout: 1500 })
  })
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

const expandAll = () => {
  if (parsed.value) {
    expandedPaths.value = new Set(collectPaths(parsed.value))
    deletedPaths.value = new Set()
    deletedStack.value = []
    currentExpandLevel.value = maxDepth.value
  }
}

const collapseAll = () => {
  expandedPaths.value = new Set()
  currentExpandLevel.value = 0
}

const togglePath = (path: string) => {
  if (expandedPaths.value.has(path)) expandedPaths.value.delete(path)
  else expandedPaths.value.add(path)
  expandedPaths.value = new Set(expandedPaths.value)
}

const deletePath = (path: string) => {
  if (!path) return
  const next = new Set(deletedPaths.value)
  next.add(path)
  deletedPaths.value = next
  deletedStack.value = [...deletedStack.value, path]
  useToast().add({ title: '已删除', color: 'green', timeout: 1500 })
}

const undoDelete = () => {
  const stack = [...deletedStack.value]
  const last = stack.pop()
  if (!last) return
  const next = new Set(deletedPaths.value)
  next.delete(last)
  deletedPaths.value = next
  deletedStack.value = stack
}

const restoreAllDeleted = () => {
  deletedPaths.value = new Set()
  deletedStack.value = []
}

const filterByDeletedPaths = (value: any, path: string): any => {
  if (deletedPaths.value.has(path)) return undefined
  if (Array.isArray(value)) {
    const arr: any[] = []
    value.forEach((item, index) => {
      const childPath = path ? `${path}[${index}]` : `[${index}]`
      const filtered = filterByDeletedPaths(item, childPath)
      if (filtered !== undefined) arr.push(filtered)
    })
    return arr
  }
  if (typeof value === 'object' && value !== null) {
    const obj: Record<string, any> = {}
    Object.entries(value).forEach(([key, val]) => {
      const childPath = path ? `${path}.${key}` : key
      const filtered = filterByDeletedPaths(val, childPath)
      if (filtered !== undefined) obj[key] = filtered
    })
    return obj
  }
  return value
}

const copyNode = async (payload: { data: any; path: string }) => {
  const indent = parseInt(indentSize.value)
  const filtered = filterByDeletedPaths(payload.data, payload.path)
  const text = typeof filtered === 'object' ? JSON.stringify(filtered, null, indent) : String(filtered ?? '')
  await navigator.clipboard.writeText(text)
  useToast().add({ title: '已复制', color: 'green' })
}

const copyAll = async () => {
  if (parsed.value) {
    const filtered = filterByDeletedPaths(parsed.value, '')
    const indent = parseInt(indentSize.value)
    await navigator.clipboard.writeText(JSON.stringify(filtered, null, indent))
  } else {
    await navigator.clipboard.writeText(input.value)
  }
  useToast().add({ title: '已复制', color: 'green' })
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
</script>

<script lang="ts">
const JsonNode = defineComponent({
  name: 'JsonNode',
  props: {
    data: { type: null, required: true },
    path: { type: String, required: true },
    keyName: { type: String, default: '' },
    expandedPaths: { type: Set, required: true },
    deletedPaths: { type: Set, required: true },
    isLast: { type: Boolean, default: true },
    depth: { type: Number, default: 0 }
  },
  emits: ['toggle', 'copy', 'locate', 'delete'],
  setup(props, { emit }) {
    const isExpanded = computed(() => props.expandedPaths.has(props.path))
    const isObject = computed(() => typeof props.data === 'object' && props.data !== null && !Array.isArray(props.data))
    const isArray = computed(() => Array.isArray(props.data))
    const isCollapsible = computed(() => isObject.value || isArray.value)

    const preview = computed(() => {
      if (isArray.value) return `Array(${props.data.length})`
      if (isObject.value) {
        const keys = Object.keys(props.data)
        if (keys.length <= 3) return `{ ${keys.join(', ')} }`
        return `{ ${keys.slice(0, 3).join(', ')}, ... }`
      }
      return ''
    })

    const valueClass = computed(() => {
      if (props.data === null) return 'text-gray-500 dark:text-gray-400'
      if (typeof props.data === 'boolean') return 'text-purple-700 dark:text-purple-300'
      if (typeof props.data === 'number') return 'text-amber-700 dark:text-amber-300'
      if (typeof props.data === 'string') return 'text-emerald-700 dark:text-emerald-300'
      return ''
    })

    const formatValue = (val: any): string => {
      if (val === null) return 'null'
      if (typeof val === 'string') return `"${val}"`
      return String(val)
    }

    const toggle = () => emit('toggle', props.path)
    const copy = () => emit('copy', { data: props.data, path: props.path })
    const locate = () => emit('locate', props.path)
    const remove = () => emit('delete', props.path)

    return () => {
      if (props.deletedPaths.has(props.path)) return null
      const children: VNode[] = []

      const keySpan = props.keyName
        ? h('span', { class: 'text-blue-700 dark:text-blue-300 font-semibold' }, [`"${props.keyName}"`, h('span', { class: 'text-gray-600 dark:text-gray-400' }, ': ')])
        : null

      if (isCollapsible.value) {
        const toggleIcon = h(resolveComponent('UIcon'), {
          name: isExpanded.value ? 'i-heroicons-chevron-down' : 'i-heroicons-chevron-right',
          class: 'w-4 h-4 cursor-pointer text-gray-400 hover:text-gray-600 inline-block mr-1 transition-transform'
        })

        const copyBtn = h(resolveComponent('UButton'), {
          variant: 'ghost',
          size: 'xs',
          class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
          onClick: (e: Event) => { e.stopPropagation(); copy() }
        }, () => '复制')

        const locateBtn = h(resolveComponent('UButton'), {
          variant: 'ghost',
          size: 'xs',
          class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
          onClick: (e: Event) => { e.stopPropagation(); locate() }
        }, () => '定位')

        const deleteBtn = props.path
          ? h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-red-600 dark:text-red-400',
            onClick: (e: Event) => { e.stopPropagation(); remove() }
          }, () => '删除')
          : null

        if (isExpanded.value) {
          const bracket = isArray.value ? '[' : '{'
          const closeBracket = isArray.value ? ']' : '}'

          const headerLine = h('div', {
            class: 'group flex items-center hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-1 -mx-1 cursor-pointer',
            onClick: toggle
          }, [toggleIcon, keySpan, h('span', { class: 'text-gray-600' }, bracket), locateBtn, deleteBtn, copyBtn])

          children.push(headerLine)

          const entries = isArray.value
            ? props.data.map((item: any, index: number) => [index, item])
            : Object.entries(props.data)

          const childNodes = entries.map(([key, value]: [any, any], index: number) => {
            const childPath = isArray.value ? `${props.path}[${key}]` : (props.path ? `${props.path}.${key}` : key)
            return h('div', { class: 'pl-4', key: childPath }, [
              h(JsonNode, {
                data: value,
                path: childPath,
                keyName: isArray.value ? '' : String(key),
                expandedPaths: props.expandedPaths,
                deletedPaths: props.deletedPaths,
                isLast: index === entries.length - 1,
                depth: props.depth + 1,
                onToggle: (p: string) => emit('toggle', p),
                onCopy: (d: any) => emit('copy', d),
                onLocate: (p: string) => emit('locate', p),
                onDelete: (p: string) => emit('delete', p)
              })
            ])
          })

          children.push(...childNodes)
          children.push(h('div', { class: 'text-gray-600' }, [closeBracket, props.isLast ? '' : ',']))
        } else {
          const collapsedLine = h('div', {
            class: 'group flex items-center hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-1 -mx-1 cursor-pointer',
            onClick: toggle
          }, [
            toggleIcon,
            keySpan,
            h('span', { class: 'text-gray-400 italic' }, preview.value),
            locateBtn,
            deleteBtn,
            copyBtn,
            h('span', { class: 'text-gray-600' }, props.isLast ? '' : ',')
          ])
          children.push(collapsedLine)
        }
      } else {
        const locateBtn = h(resolveComponent('UButton'), {
          variant: 'ghost',
          size: 'xs',
          class: '!px-1.5 !py-0.5 text-[11px]',
          onClick: (e: Event) => { e.stopPropagation(); locate() }
        }, () => '定位')
        const deleteBtn = props.path
          ? h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: '!px-1.5 !py-0.5 text-[11px] text-red-600 dark:text-red-400',
            onClick: (e: Event) => { e.stopPropagation(); remove() }
          }, () => '删除')
          : null
        const copyBtn = h(resolveComponent('UButton'), {
          variant: 'ghost',
          size: 'xs',
          class: '!px-1.5 !py-0.5 text-[11px]',
          onClick: (e: Event) => { e.stopPropagation(); copy() }
        }, () => '复制')

        const valueRow = h('div', { class: 'flex flex-wrap items-start gap-x-1 w-full min-w-0' }, [
          h('span', { class: 'w-4 flex-shrink-0' }),
          h('div', { class: 'min-w-0 flex-1 flex flex-wrap items-baseline gap-x-1' }, [
            keySpan,
            h('span', { class: `${valueClass.value} break-all min-w-0` }, formatValue(props.data)),
            h('span', { class: 'text-gray-600 flex-shrink-0' }, props.isLast ? '' : ',')
          ])
        ])

        const actionsRow = h('div', {
          class: 'hidden w-full min-w-0 mt-1 flex-wrap gap-1 items-center group-hover:flex group-focus-within:flex [@media(hover:none)]:flex'
        }, [
          h('span', { class: 'w-4 flex-shrink-0' }),
          h('div', { class: 'flex flex-wrap gap-1 items-center min-w-0 flex-1' }, [
            locateBtn,
            deleteBtn,
            copyBtn
          ].filter(Boolean) as VNode[])
        ])

        const valueLine = h('div', {
          class: 'group json-tree-leaf rounded px-1 -mx-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800'
        }, [valueRow, actionsRow])
        children.push(valueLine)
      }

      return h('div', {}, children)
    }
  }
})
</script>

<style>
.json-tree {
  line-height: 1.6;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 语法高亮颜色 */
.json-hl-key    { color: #2563eb; font-weight: 600; }
.json-hl-string { color: #059669; }
.json-hl-number { color: #d97706; }
.json-hl-boolean{ color: #7c3aed; }
.json-hl-null   { color: #6b7280; font-style: italic; }

.dark .json-hl-key    { color: #93c5fd; }
.dark .json-hl-string { color: #6ee7b7; }
.dark .json-hl-number { color: #fcd34d; }
.dark .json-hl-boolean{ color: #d8b4fe; }
.dark .json-hl-null   { color: #9ca3af; }
</style>
