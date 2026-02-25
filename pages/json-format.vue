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
      <UButton @click="copyAll" variant="outline" :disabled="!input.trim()">
        <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
        复制
      </UButton>
      <UButton @click="clearAll" variant="ghost" color="red">
        <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
        清空
      </UButton>

      <UDropdown :items="historyMenuItems" :popper="{ placement: 'bottom-start' }">
        <UButton variant="outline" size="sm" :disabled="historyList.length === 0">
          <UIcon name="i-heroicons-clock" class="w-4 h-4 mr-1" />
          历史 ({{ historyList.length }})
        </UButton>
      </UDropdown>

      <div class="flex items-center ml-auto space-x-4">
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
        />
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
          </div>
        </div>
        <UCard class="h-[576px] overflow-auto">
          <div class="font-mono text-sm json-tree">
            <JsonNode 
              :data="parsed" 
              :path="''" 
              :depth="0"
              :expanded-paths="expandedPaths" 
              @toggle="togglePath" 
              @copy="copyNode"
              @locate="locateInJson"
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
const { addToHistory, getHistory, clearHistory } = useHistory<JsonFormatHistory>('json-format')

const historyList = ref<HistoryItem<JsonFormatHistory>[]>([])

const refreshHistory = () => {
  historyList.value = getHistory()
}

const formatTime = (timestamp: number) => {
  const d = new Date(timestamp)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const getPreview = (data: JsonFormatHistory) => {
  const text = data.input.trim()
  return text.length > 50 ? text.slice(0, 50) + '...' : text
}

const historyMenuItems = computed(() => {
  if (historyList.value.length === 0) return []
  
  return [
    historyList.value.map((item, index) => ({
      label: `${formatTime(item.timestamp)} - ${getPreview(item.data)}`,
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
      showTree: showTree.value
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
const expandedPaths = ref<Set<string>>(new Set())
const textareaRef = ref<any>(null)
const currentExpandLevel = ref(0)

watch([indentSize, showTree], saveSettings)

const indentOptions = [
  { label: '2', value: '2' },
  { label: '4', value: '4' },
]

const getPathDepth = (path: string): number => {
  if (!path) return 0
  let depth = 0
  let inBracket = false
  
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '.') {
      depth++
    } else if (path[i] === '[' && !inBracket) {
      depth++
      inBracket = true
    } else if (path[i] === ']') {
      inBracket = false
    }
  }
  
  return depth
}

const getMaxDepthInData = (obj: any, currentDepth = 0): number => {
  if (typeof obj !== 'object' || obj === null) return currentDepth
  
  let maxChildDepth = currentDepth
  
  if (Array.isArray(obj)) {
    obj.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        maxChildDepth = Math.max(maxChildDepth, getMaxDepthInData(item, currentDepth + 1))
      }
    })
  } else {
    Object.values(obj).forEach(value => {
      if (typeof value === 'object' && value !== null) {
        maxChildDepth = Math.max(maxChildDepth, getMaxDepthInData(value, currentDepth + 1))
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
  return Math.max(...expandedPathsArray.map(getPathDepth), 0)
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
  
  allPaths.forEach(path => {
    const depth = getPathDepth(path)
    if (depth <= level) {
      newExpanded.add(path)
    }
  })
  
  expandedPaths.value = newExpanded
  currentExpandLevel.value = level
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
  
  try {
    const obj = JSON.parse(input.value)
    const indent = parseInt(indentSize.value)
    input.value = JSON.stringify(obj, null, indent)
    parsed.value = obj
    expandedPaths.value = new Set(collectPaths(obj))
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

const copyNode = async (data: any) => {
  const indent = parseInt(indentSize.value)
  const text = typeof data === 'object' ? JSON.stringify(data, null, indent) : String(data)
  await navigator.clipboard.writeText(text)
  useToast().add({ title: '已复制', color: 'green' })
}

const copyAll = async () => {
  await navigator.clipboard.writeText(input.value)
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
    isLast: { type: Boolean, default: true },
    depth: { type: Number, default: 0 }
  },
  emits: ['toggle', 'copy', 'locate'],
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
      if (props.data === null) return 'text-gray-500'
      if (typeof props.data === 'boolean') return 'text-purple-600 dark:text-purple-400'
      if (typeof props.data === 'number') return 'text-blue-600 dark:text-blue-400'
      if (typeof props.data === 'string') return 'text-green-600 dark:text-green-400'
      return ''
    })

    const formatValue = (val: any): string => {
      if (val === null) return 'null'
      if (typeof val === 'string') return `"${val}"`
      return String(val)
    }

    const toggle = () => emit('toggle', props.path)
    const copy = () => emit('copy', props.data)
    const locate = () => emit('locate', props.path)

    return () => {
      const children: VNode[] = []

      const keySpan = props.keyName 
        ? h('span', { class: 'text-red-600 dark:text-red-400' }, [`"${props.keyName}"`, h('span', { class: 'text-gray-600' }, ': ')])
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
        }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-clipboard-document', class: 'w-3 h-3' }))

        const locateBtn = h(resolveComponent('UButton'), {
          variant: 'ghost',
          size: 'xs',
          class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
          title: '定位到编辑器',
          onClick: (e: Event) => { e.stopPropagation(); locate() }
        }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-cursor-arrow-rays', class: 'w-3 h-3' }))

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
                isLast: index === entries.length - 1,
                depth: props.depth + 1,
                onToggle: (p: string) => emit('toggle', p),
                onCopy: (d: any) => emit('copy', d),
                onLocate: (p: string) => emit('locate', p)
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
            title: '定位到编辑器',
            onClick: (e: Event) => { e.stopPropagation(); locate() }
          }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-cursor-arrow-rays', class: 'w-3 h-3' })),
          h(resolveComponent('UButton'), {
            variant: 'ghost',
            size: 'xs',
            class: 'ml-1 opacity-0 group-hover:opacity-100 transition-opacity',
            onClick: copy
          }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-clipboard-document', class: 'w-3 h-3' }))
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
