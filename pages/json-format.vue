<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        JSON 格式化
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        格式化、编辑 JSON 数据，支持树形预览和节点复制
      </p>
    </div>

    <div class="flex flex-wrap gap-2 mb-4">
      <UButton @click="formatJson" color="primary">
        <UIcon name="i-heroicons-code-bracket" class="w-4 h-4 mr-1" />
        格式化
      </UButton>
      <UButton @click="compressJson" variant="outline">
        <UIcon name="i-heroicons-arrows-pointing-in" class="w-4 h-4 mr-1" />
        压缩
      </UButton>
      <UButton @click="jumpToJsonExtract" variant="outline" :disabled="!input.trim()">
        <UIcon name="i-heroicons-funnel" class="w-4 h-4 mr-1" />
        去JSON提取
      </UButton>
      <UButton @click="copyAll" variant="outline" :disabled="!input.trim()">
        <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
        复制
      </UButton>
      <UButton @click="clearAll" variant="ghost" color="red">
        <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
        清空
      </UButton>

      <UDropdown :items="historyMenuItems" :popper="{ placement: 'bottom-start' }" :ui="{ width: 'w-[640px]', container: 'w-[640px]' }">
        <UButton variant="outline" size="sm" :disabled="historyList.length === 0">
          <UIcon name="i-heroicons-clock" class="w-4 h-4 mr-1" />
          历史 ({{ historyList.length }})
        </UButton>
        <template #item="{ item }">
          <div class="w-[640px]">
            <UTooltip v-if="item.preview" :text="item.preview" :popper="{ placement: 'right' }">
              <span class="block truncate max-w-[640px]">{{ item.label }}</span>
            </UTooltip>
            <span v-else class="block truncate max-w-[640px]">{{ item.label }}</span>
          </div>
        </template>
      </UDropdown>

      <div class="flex items-center ml-auto space-x-4">
        <UCheckbox v-model="smartParseEnabled" label="智能解析" />
        <UCheckbox v-model="unwrapOuterBrackets" label="去外围括号" />
        <UCheckbox v-model="showTree" label="树形预览" />
        <div class="flex items-center space-x-2">
          <span class="text-sm text-gray-600 dark:text-gray-400">缩进:</span>
          <USelect v-model="indentSize" :options="indentOptions" size="sm" class="w-20" />
        </div>
      </div>
    </div>

    <UAlert v-if="error" color="red" class="mb-4">
      <template #title>JSON 解析错误</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <div class="grid gap-4" :class="showTree && parsed ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'">
      <div>
        <div class="flex justify-between items-center mb-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            JSON 内容
            <span v-if="stats" class="text-gray-500 font-normal ml-2">({{ stats }})</span>
          </label>
        </div>
        <textarea
          ref="textareaRef"
          v-model="input"
          rows="24"
          placeholder="粘贴或输入 JSON 数据..."
          class="font-mono text-sm w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
          @input="debouncedParse"
          @paste="onPaste"
        />
      </div>

      <!-- 候选 JSON 列表 -->
      <div v-if="candidateJsons.length > 1" class="mt-4">
        <div class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          检测到 {{ candidateJsons.length }} 个 JSON，请选择：
        </div>
        <div :class="candidateJsons.length > 3 ? 'space-y-2 max-h-64 overflow-auto' : 'space-y-2'">
          <div
            v-for="(candidate, index) in candidateJsons"
            :key="index"
            class="p-3 border rounded-lg dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <UBadge :color="candidate.type === 'array' ? 'blue' : 'green'" size="xs">
                  {{ candidate.type === 'array' ? '数组' : '对象' }} {{ candidate.count }}
                </UBadge>
                <span v-if="candidate.source" class="text-xs text-gray-500">{{ candidate.source }}</span>
              </div>
              <div class="flex gap-1">
                <UButton
                  v-if="candidate.isLong"
                  size="xs"
                  variant="ghost"
                  @click="toggleCandidatePreview(index)"
                >
                  {{ expandedCandidateIndexes.has(index) ? '收起' : '展开' }}
                </UButton>
                <UButton size="xs" variant="ghost" @click="copyCandidateJson(candidate)" title="复制">
                  <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4" />
                </UButton>
                <UButton size="xs" color="primary" @click="selectCandidateJson(candidate)">
                  选择
                </UButton>
              </div>
            </div>

            <div
              class="mt-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-900/40 rounded border border-gray-100 dark:border-gray-800 p-2 font-mono whitespace-pre-wrap break-all"
              :class="candidate.isLong && !expandedCandidateIndexes.has(index) ? 'max-h-28 overflow-auto' : ''"
            >
              {{ candidate.formatted }}
            </div>
            <div v-if="candidate.isLong && !expandedCandidateIndexes.has(index)" class="mt-1 text-[11px] text-gray-400">
              可滚动预览全部内容
            </div>
          </div>
        </div>
      </div>

      <div v-if="showTree && parsed">
        <div class="flex justify-between items-center mb-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            树形预览
            <span v-if="currentMaxDepth > 0" class="text-gray-500 font-normal ml-2">
              (当前展开{{ currentMaxDepth >= maxDepth ? '全部' : `到第 ${currentMaxDepth} 层` }})
            </span>
          </label>
          <div class="flex gap-1 items-center">
            <div class="flex items-center gap-1 mr-2">
              <UButton @click="expandToLevel(currentExpandLevel - 1)" variant="ghost" size="xs" :disabled="currentExpandLevel <= 0">
                <UIcon name="i-heroicons-minus" class="w-4 h-4" />
              </UButton>
              <span class="text-xs text-gray-600 dark:text-gray-400 min-w-[60px] text-center">
                {{ currentExpandLevel === maxDepth ? '全部' : `${currentExpandLevel} 层` }}
              </span>
              <UButton @click="expandToLevel(currentExpandLevel + 1)" variant="ghost" size="xs" :disabled="currentExpandLevel >= maxDepth">
                <UIcon name="i-heroicons-plus" class="w-4 h-4" />
              </UButton>
            </div>
            <UButton @click="expandAll" variant="ghost" size="xs" title="全部展开">
              <UIcon name="i-heroicons-arrows-pointing-out" class="w-4 h-4" />
            </UButton>
            <UButton @click="collapseAll" variant="ghost" size="xs" title="全部收起">
              <UIcon name="i-heroicons-arrows-pointing-in" class="w-4 h-4" />
            </UButton>
            <UButton @click="undoDelete" variant="ghost" size="xs" :disabled="deletedStack.length === 0">
              撤销删除
            </UButton>
            <UButton @click="restoreAllDeleted" variant="ghost" size="xs" :disabled="deletedPaths.size === 0">
              恢复全部
            </UButton>
          </div>
        </div>
        <UCard class="h-[720px] overflow-auto">
          <div class="font-mono text-sm json-tree">
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
        </UCard>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'
import type { HistoryItem } from '~/composables/useHistory'

interface JsonFormatHistory {
  input: string
}

const STORAGE_KEY = 'json-format-settings'
const JSON_EXTRACT_IMPORT_KEY = 'json-extract-import'
const { addToHistory, getHistory, clearHistory } = useHistory<JsonFormatHistory>('json-format')

const onPaste = (e: ClipboardEvent) => {
  if (!smartParseEnabled.value) return
  
  // 延迟执行，等 v-model 更新
  setTimeout(() => {
    autoSmartParse()
  }, 50)
}

const autoSmartParse = () => {
  error.value = ''
  candidateJsons.value = []
  if (!input.value.trim()) return

  let text = input.value.trim()
  const candidates: CandidateJson[] = []

  // 尝试去掉转义符后解析
  const unescaped = tryUnescape(text)
  if (unescaped && unescaped !== text) {
    addCandidate(candidates, unescaped, '去转义')
  }

  // 尝试直接解析整个文本
  try {
    const obj = JSON.parse(text)
    // 如果有 messages 字段，只处理 messages 中的内容，不需要原始 JSON
    if (obj && typeof obj === 'object' && 'messages' in obj && typeof obj.messages === 'string') {
      const messagesContent = obj.messages
      const extracted = extractAllJsonFromText(messagesContent)
      extracted.forEach(jsonStr => {
        addCandidate(candidates, jsonStr, 'messages')
        // 尝试递归解析嵌套的转义 JSON
        extractNestedEscapedJson(jsonStr, candidates)
      })
      
      // 只处理 messages 提取的结果
      candidates.sort((a, b) => b.json.length - a.json.length)
      if (candidates.length > 20) candidates.splice(20)
      if (candidates.length === 0) {
        error.value = 'messages 字段中未找到有效的 JSON'
      } else {
        candidateJsons.value = candidates
      }
      return
    }
    
    // 没有 messages 字段，尝试解析嵌套转义 JSON（如 rawContent）
    const nestedCandidates: CandidateJson[] = []
    // 原始 JSON 也作为候选
    addCandidate(nestedCandidates, text, '原始')
    extractNestedEscapedJson(JSON.stringify(obj), nestedCandidates)
    if (nestedCandidates.length > 0) {
      nestedCandidates.sort((a, b) => b.json.length - a.json.length)
      if (nestedCandidates.length > 20) nestedCandidates.splice(20)
      candidateJsons.value = nestedCandidates
      return
    }

    // 没有嵌套 JSON，直接格式化当前 JSON
    let result = obj
    if (unwrapOuterBrackets.value) {
      result = tryUnwrap(result)
    }
    input.value = JSON.stringify(result, null, Number(indentSize.value))
    parsed.value = result
    expandedPaths.value = new Set(collectPaths(result))
    deletedPaths.value = new Set()
    deletedStack.value = []
    currentExpandLevel.value = maxDepth.value
    saveToHistory()
    return
  } catch {
    // 不是有效 JSON，尝试从文本中提取所有 JSON
    const extracted = extractAllJsonFromText(text)
    extracted.forEach(jsonStr => {
      addCandidate(candidates, jsonStr)
      extractNestedEscapedJson(jsonStr, candidates)
    })
  }

  candidates.sort((a, b) => b.json.length - a.json.length)
  if (candidates.length > 20) candidates.splice(20)

  if (candidates.length === 0) {
    // 没有找到任何 JSON，尝试普通解析
    parseJson()
  } else {
    // 有候选时始终显示列表让用户选择
    candidateJsons.value = candidates
  }
}

const tryUnescape = (text: string): string | null => {
  // 检测是否包含转义的 JSON（如 {\"key\":\"value\"} 或 {\\\"key\\\":\\\"value\\\"}）
  if (!text.includes('\\"') && !text.includes('\\\\')) {
    return null
  }
  
  try {
    // 方法1: 尝试作为 JSON 字符串解析（处理 \" 转义）
    // 如果文本是 {"key":"value"}，包裹后变成 "{\"key\":\"value\"}"
    const wrapped = `"${text}"`
    try {
      const parsed = JSON.parse(wrapped)
      if (typeof parsed === 'string') {
        // 验证解析结果是否为有效 JSON
        JSON.parse(parsed)
        return parsed
      }
    } catch {}
    
    // 方法2: 直接替换转义符（处理 \\" 这种格式）
    let unescaped = text
    // 先处理双重转义 \\" -> \"，然后 \" -> "
    while (unescaped.includes('\\\\"') || unescaped.includes('\\"')) {
      const prev = unescaped
      unescaped = unescaped
        .replace(/\\\\"/g, '\\"')
        .replace(/\\"/g, '"')
      if (prev === unescaped) break
    }
    // 处理反斜杠
    unescaped = unescaped.replace(/\\\\/g, '\\')
    
    // 验证去转义后是否为有效 JSON
    if (unescaped !== text) {
      JSON.parse(unescaped)
      return unescaped
    }
    
    return null
  } catch {
    return null
  }
}

const extractNestedEscapedJson = (jsonStr: string, candidates: CandidateJson[]) => {
  try {
    const obj = JSON.parse(jsonStr)
    
    // 遍历对象的所有字符串值，查找转义的 JSON 或直接嵌入的 JSON
    const processValue = (value: any, path: string) => {
      if (typeof value === 'string') {
        const trimmed = value.trim()

        // 1) 直接就是 JSON
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            JSON.parse(trimmed)
            addCandidate(candidates, trimmed, path || '嵌套')
            extractNestedEscapedJson(trimmed, candidates)
          } catch {}
        }

        // 2) 字符串里包含 JSON 片段（不一定在开头）
        const embedded = extractAllJsonFromText(trimmed)
        if (embedded.length > 0) {
          embedded.forEach(jsonStr => {
            addCandidate(candidates, jsonStr, path || '嵌套')
            extractNestedEscapedJson(jsonStr, candidates)
          })
        }

        // 3) 转义后的 JSON
        const unescaped = tryUnescape(trimmed)
        if (unescaped) {
          addCandidate(candidates, unescaped, path || '嵌套')
          extractNestedEscapedJson(unescaped, candidates)
        }
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          processValue(item, `${path}[${index}]`)
        })
      } else if (typeof value === 'object' && value !== null) {
        Object.entries(value).forEach(([key, val]) => {
          processValue(val, path ? `${path}.${key}` : key)
        })
      }
    }
    
    processValue(obj, '')
  } catch {}
}

const addCandidate = (candidates: CandidateJson[], jsonStr: string, source?: string) => {
  try {
    let data = JSON.parse(jsonStr)
    if (unwrapOuterBrackets.value) {
      data = tryUnwrap(data)
      jsonStr = JSON.stringify(data)
    }
    const formatted = JSON.stringify(data, null, Number(indentSize.value))
    const isArray = Array.isArray(data)
    const count = isArray ? `${data.length} 项` : `${Object.keys(data).length} 个键`
    const preview = formatted.slice(0, 80) + (formatted.length > 80 ? '...' : '')
    const lineCount = (formatted.match(/\n/g) || []).length + 1
    const isLong = formatted.length > 300 || lineCount > 6
    
    // 避免重复
    if (!candidates.some(c => c.json === jsonStr)) {
      candidates.push({
        json: jsonStr,
        formatted,
        type: isArray ? 'array' : 'object',
        count,
        source,
        preview,
        isLong
      })
    }
  } catch {}
}

const toggleCandidatePreview = (index: number) => {
  const next = new Set(expandedCandidateIndexes.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  expandedCandidateIndexes.value = next
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
  useToast().add({ title: '已应用所选 JSON', color: 'green', timeout: 1500 })
}

const copyCandidateJson = (candidate: CandidateJson) => {
  navigator.clipboard.writeText(candidate.formatted)
  useToast().add({ title: '已复制', color: 'green', timeout: 1500 })
}

const smartParse = () => {
  autoSmartParse()
}

const jumpToJsonExtract = () => {
  if (!input.value.trim()) return
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(JSON_EXTRACT_IMPORT_KEY, input.value)
    navigateTo({ path: '/json-extract', query: { from: 'json-format' } })
  } catch (e) {
    useToast().add({ title: '跳转失败，请重试', color: 'red', timeout: 2000 })
  }
}

const tryUnwrap = (obj: any): any => {
  // 如果是数组且只有一个元素，去掉外层数组
  if (Array.isArray(obj) && obj.length === 1) {
    return obj[0]
  }
  // 如果是对象且只有一个键，且值是对象，去掉外层
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const keys = Object.keys(obj)
    if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
      return obj[keys[0]]
    }
  }
  return obj
}

const extractAllJsonFromText = (text: string): string[] => {
  const results: string[] = []
  
  // 查找所有 JSON 对象 {} 或数组 []
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
          i = j
          continue
        } catch {}
      }
    }
    i++
  }
  return results
}

const historyList = ref<HistoryItem<JsonFormatHistory>[]>([])

const refreshHistory = () => {
  historyList.value = getHistory()
}

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
    parseJson()
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
      indentSize: indentSize.value,
      showTree: showTree.value,
      smartParseEnabled: smartParseEnabled.value,
      unwrapOuterBrackets: unwrapOuterBrackets.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('保存设置失败:', e)
  }
}

const savedSettings = loadSettings()

const input = ref('')
const parsed = ref<any>(null)
const error = ref('')
const indentSize = ref(savedSettings?.indentSize ?? '2')
const showTree = ref(savedSettings?.showTree ?? true)
const smartParseEnabled = ref(savedSettings?.smartParseEnabled ?? true)
const unwrapOuterBrackets = ref(savedSettings?.unwrapOuterBrackets ?? false)

watch(unwrapOuterBrackets, (newVal) => {
  if (newVal) {
    smartParseEnabled.value = true
  }
})
const expandedPaths = ref<Set<string>>(new Set())
const deletedPaths = ref<Set<string>>(new Set())
const deletedStack = ref<string[]>([])
const textareaRef = ref<any>(null)
const currentExpandLevel = ref(0)

interface CandidateJson {
  json: string
  formatted: string
  type: 'array' | 'object'
  count: string
  source?: string
  preview: string
  isLong: boolean
}
const candidateJsons = ref<CandidateJson[]>([])
const expandedCandidateIndexes = ref<Set<number>>(new Set())

watch([indentSize, showTree, smartParseEnabled, unwrapOuterBrackets], saveSettings)
watch(unwrapOuterBrackets, () => {
  if (!input.value.trim()) return
  formatJson()
})

const indentOptions = [
  { label: '2', value: '2' },
  { label: '4', value: '4' },
]

const getPathDepth = (path: string): number => {
  if (!path) return 0
  // 层数 = 路径段数。根 "" 为 0；"a" 为 1；"a.b" 为 2；"a[0]" 为 2
  let segments = 1
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '.') segments++
    else if (path[i] === '[') segments++
  }
  return segments
}

const getMaxDepthInData = (obj: any, currentDepth = 0): number => {
  if (typeof obj !== 'object' || obj === null) return currentDepth
  
  // 当前节点的子节点在树上的层数 = currentDepth + 1
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
  const expandedPathsArray = Array.from(expandedPaths.value)
  if (expandedPathsArray.length === 0) return 0
  // 展开某节点会多露出一层子节点，所以当前可见最大层 = max(路径深度+1)
  return Math.max(...expandedPathsArray.map(p => getPathDepth(p) + 1), 0)
})

const stats = computed(() => {
  if (!parsed.value) return ''
  if (Array.isArray(parsed.value)) {
    return `数组, ${parsed.value.length} 项`
  }
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
  
  if (level > maxDepth.value) {
    level = maxDepth.value
  }
  
  const allPaths = collectPaths(parsed.value)
  const newExpanded = new Set<string>()
  
  // 到第 N 层 = 只展开深度 < N 的节点（根为第 0 层），第 N 层节点保持收起
  // 例如到第 1 层：只展开根 ""，code/data/msg 等第一层可见但都收起
  const levelNum = Number(level)
  for (const path of allPaths) {
    const depth = getPathDepth(path)
    if (depth < levelNum) {
      newExpanded.add(path)
    }
  }
  
  expandedPaths.value = new Set(newExpanded)
  currentExpandLevel.value = levelNum
}

const buildPathMap = (obj: any, indentSize: number): { json: string; pathMap: Map<string, { start: number; end: number; line: number }> } => {
  const pathMap = new Map<string, { start: number; end: number; line: number }>()
  let result = ''
  
  const getLine = (pos: number) => (result.slice(0, pos).match(/\n/g) || []).length + 1
  
  const process = (value: any, path: string, indentLevel: number): void => {
    const prefix = ' '.repeat(indentLevel * indentSize)
    
    if (value === null) {
      result += 'null'
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result += JSON.stringify(value)
      return
    }
    if (typeof value === 'string') {
      result += JSON.stringify(value)
      return
    }
    
    if (Array.isArray(value)) {
      result += '[\n'
      value.forEach((item, i) => {
        const childPath = path ? `${path}[${i}]` : `[${i}]`
        result += prefix + '  '
        const start = result.length
        process(item, childPath, indentLevel + 1)
        const end = result.length
        pathMap.set(childPath, { start, end, line: getLine(start) })
        result += i < value.length - 1 ? ',\n' : '\n'
      })
      result += prefix + ']'
      return
    }
    
    if (typeof value === 'object') {
      result += '{\n'
      const entries = Object.entries(value)
      entries.forEach(([key, val], i) => {
        const childPath = path ? `${path}.${key}` : key
        const keyLine = prefix + '  ' + JSON.stringify(key) + ': '
        const start = result.length
        result += keyLine
        process(val, childPath, indentLevel + 1)
        const lineEnd = result.indexOf('\n', start)
        const endPos = lineEnd >= 0 ? lineEnd : result.length
        pathMap.set(childPath, { start, end: endPos, line: getLine(start) })
        result += i < entries.length - 1 ? ',\n' : '\n'
      })
      result += prefix + '}'
    }
  }
  
  process(obj, '', 0)
  return { json: result, pathMap }
}

const locateInJson = (path: string) => {
  const textarea = textareaRef.value as HTMLTextAreaElement | null
  if (!textarea) return
  
  try {
    const obj = JSON.parse(input.value)
    const indent = parseInt(indentSize.value)
    const { json: formattedJson, pathMap } = buildPathMap(obj, indent)
    
    input.value = formattedJson
    
    const position = pathMap.get(path)
    
    if (position) {
      nextTick(() => {
        textarea.focus()
        textarea.setSelectionRange(position.start, position.end)
        
        const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20
        textarea.scrollTop = Math.max(0, (position.line - 4) * lineHeight)
        
        useToast().add({ 
          title: '已定位', 
          description: `第 ${position.line} 行`,
          color: 'blue',
          timeout: 1500
        })
      })
    } else {
      useToast().add({ 
        title: '定位失败', 
        description: '未找到对应路径',
        color: 'orange',
        timeout: 1500
      })
    }
  } catch (e) {
    console.error('定位失败:', e)
    useToast().add({ 
      title: '定位失败', 
      color: 'red',
      timeout: 1500
    })
  }
}

const parseJson = () => {
  error.value = ''
  if (!input.value.trim()) {
    parsed.value = null
    return
  }
  
  try {
    parsed.value = JSON.parse(input.value)
    if (expandedPaths.value.size === 0) {
      expandedPaths.value = new Set(collectPaths(parsed.value))
      deletedPaths.value = new Set()
      deletedStack.value = []
      currentExpandLevel.value = maxDepth.value
    }
  } catch (e: any) {
    error.value = e.message
    parsed.value = null
  }
}

const debouncedParse = useDebounceFn(parseJson, 300)

const formatJson = () => {
  error.value = ''
  if (!input.value.trim()) return

  // 如果开启智能解析，先进行智能解析
  if (smartParseEnabled.value) {
    smartParse()
    return
  }

  try {
    let obj = JSON.parse(input.value)
    
    // 如果开启去外围括号
    if (unwrapOuterBrackets.value) {
      obj = tryUnwrap(obj)
    }
    
    const indent = parseInt(indentSize.value)
    input.value = JSON.stringify(obj, null, indent)
    parsed.value = obj
    expandedPaths.value = new Set(collectPaths(obj))
    deletedPaths.value = new Set()
    deletedStack.value = []
    currentExpandLevel.value = maxDepth.value
    saveToHistory()
  } catch (e: any) {
    error.value = e.message
  }
}

const compressJson = () => {
  error.value = ''
  if (!input.value.trim()) return
  
  try {
    const obj = JSON.parse(input.value)
    input.value = JSON.stringify(obj)
    parsed.value = obj
    saveToHistory()
  } catch (e: any) {
    error.value = e.message
  }
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
  if (expandedPaths.value.has(path)) {
    expandedPaths.value.delete(path)
  } else {
    expandedPaths.value.add(path)
  }
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
    const text = JSON.stringify(filtered, null, indent)
    await navigator.clipboard.writeText(text)
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
    const isHovered = ref(false)

    const isExpanded = computed(() => props.expandedPaths.has(props.path))
    const isObject = computed(() => typeof props.data === 'object' && props.data !== null && !Array.isArray(props.data))
    const isArray = computed(() => Array.isArray(props.data))
    const isCollapsible = computed(() => isObject.value || isArray.value)

    const preview = computed(() => {
      if (isArray.value) {
        return `Array(${props.data.length})`
      }
      if (isObject.value) {
        const keys = Object.keys(props.data)
        if (keys.length <= 3) {
          return `{ ${keys.join(', ')} }`
        }
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
          }, [
            toggleIcon,
            keySpan,
            h('span', { class: 'text-gray-600' }, bracket),
            locateBtn,
            deleteBtn,
            copyBtn
          ])

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
        const valueLine = h('div', {
          class: 'group flex items-center hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-1 -mx-1'
        }, [
          h('span', { class: 'w-4 inline-block' }),
          keySpan,
          h('span', { class: valueClass.value }, formatValue(props.data)),
          h('span', { class: 'text-gray-600' }, props.isLast ? '' : ','),
          h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
            onClick: (e: Event) => { e.stopPropagation(); locate() }
          }, () => '定位'),
          props.path ? h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-red-600 dark:text-red-400',
            onClick: (e: Event) => { e.stopPropagation(); remove() }
          }, () => '删除') : null,
          h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
            onClick: (e: Event) => { e.stopPropagation(); copy() }
          }, () => '复制')
        ])
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
}
</style>
