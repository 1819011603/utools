<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        JSON 对比
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        对比两个 JSON 数据的差异，支持多层嵌套数组的字段匹配
      </p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          JSON A (原始)
        </label>
        <UTextarea
          v-model="inputA"
          :rows="10"
          placeholder="粘贴第一个 JSON..."
          class="font-mono text-sm"
          @input="debouncedAnalyze"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          JSON B (新值)
        </label>
        <UTextarea
          v-model="inputB"
          :rows="10"
          placeholder="粘贴第二个 JSON..."
          class="font-mono text-sm"
          @input="debouncedAnalyze"
        />
      </div>
    </div>

    <UCard class="mb-4">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="font-medium text-gray-900 dark:text-white">数组匹配配置</h3>
          <div class="flex gap-2">
            <UButton @click="compareJson" color="primary">
              <UIcon name="i-heroicons-scale" class="w-4 h-4 mr-1" />
              对比
            </UButton>
            <UButton @click="swapInputs" variant="outline">
              <UIcon name="i-heroicons-arrows-right-left" class="w-4 h-4 mr-1" />
              交换
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
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <p class="text-sm text-gray-500">
          为数组路径指定匹配字段，相同字段值的元素会进行对比（而非按索引对比）
        </p>

        <div v-if="arrayPaths.length > 0" class="space-y-3">
          <div 
            v-for="ap in arrayPaths" 
            :key="ap.path"
            class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <div class="flex-1">
              <div class="font-mono text-sm text-gray-900 dark:text-white">{{ ap.path }}</div>
              <div class="text-xs text-gray-500 mt-1">
                共 {{ ap.countA }} / {{ ap.countB }} 项
                <span v-if="ap.suggestedKeys.length > 0" class="ml-2">
                  可用字段: {{ ap.suggestedKeys.slice(0, 5).join(', ') }}{{ ap.suggestedKeys.length > 5 ? '...' : '' }}
                </span>
              </div>
            </div>
            <div class="w-48">
              <USelectMenu
                v-model="ap.matchKey"
                :options="getKeyOptions(ap)"
                placeholder="选择匹配字段"
                size="sm"
                searchable
                clear-search-on-close
              />
            </div>
          </div>
        </div>

        <div v-else-if="inputA.trim() && inputB.trim()" class="text-sm text-gray-500 text-center py-4">
          未检测到数组结构，将按对象键名进行对比
        </div>

        <div v-else class="text-sm text-gray-500 text-center py-4">
          请输入 JSON 数据，将自动分析数组结构
        </div>
      </div>
    </UCard>

    <UAlert v-if="error" color="red" class="mb-4">
      <template #title>错误</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <div v-if="diffResult.length > 0">
      <div class="flex justify-between items-center mb-2">
        <div class="flex items-center gap-4">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            对比结果
            <span class="text-gray-500 font-normal ml-2">({{ diffStats }})</span>
          </label>
          <div class="flex items-center gap-2">
            <span class="text-sm text-gray-500">排序:</span>
            <USelect v-model="sortOrder" :options="sortOptions" size="xs" class="w-36" />
          </div>
        </div>
        <UButton @click="copyDiff" variant="outline" size="sm">
          <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
          复制结果
        </UButton>
      </div>

      <div class="flex gap-2 mb-3">
        <UButton 
          v-for="filter in filterOptions" 
          :key="filter.value"
          size="xs"
          :variant="activeFilters.includes(filter.value) ? 'solid' : 'outline'"
          :color="filter.color"
          @click="toggleFilter(filter.value)"
        >
          {{ filter.label }} ({{ getCountByType(filter.value) }})
        </UButton>
      </div>
      
      <UCard>
        <div class="max-h-[500px] overflow-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
              <tr>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">路径</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300 w-20">类型</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">A 值</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">B 值</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr
                v-for="(diff, index) in sortedAndFilteredResult"
                :key="index"
                :class="getDiffRowClass(diff.type)"
              >
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[300px]">{{ diff.path }}</td>
                <td class="px-3 py-2">
                  <UBadge :color="getDiffBadgeColor(diff.type)" size="xs">
                    {{ getDiffTypeLabel(diff.type) }}
                  </UBadge>
                </td>
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[250px]">
                  <span :class="diff.type === 'removed' || diff.type === 'changed' ? 'text-red-600 dark:text-red-400' : ''">
                    {{ formatValue(diff.valueA) }}
                  </span>
                </td>
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[250px]">
                  <span :class="diff.type === 'added' || diff.type === 'changed' ? 'text-green-600 dark:text-green-400' : ''">
                    {{ formatValue(diff.valueB) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </div>

    <UCard v-else-if="compared && diffResult.length === 0" class="text-center py-8">
      <UIcon name="i-heroicons-check-circle" class="w-12 h-12 text-green-500 mx-auto mb-2" />
      <p class="text-gray-600 dark:text-gray-300">两个 JSON 完全相同</p>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'
import type { HistoryItem } from '~/composables/useHistory'

interface DiffItem {
  path: string
  type: 'added' | 'removed' | 'changed'
  valueA?: any
  valueB?: any
}

interface ArrayPathInfo {
  path: string
  countA: number
  countB: number
  suggestedKeys: string[]
  matchKey: string | undefined
}

interface JsonDiffHistory {
  inputA: string
  inputB: string
}

const STORAGE_KEY = 'json-diff-settings'
const { addToHistory, getHistory, clearHistory } = useHistory<JsonDiffHistory>('json-diff')

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

const commonIdFields = ['id', 'key', 'code', 'name', 'uuid', 'ID', 'Id', 'number', 'no', 'index']

const getKeyOptions = (ap: ArrayPathInfo) => {
  return [
    { label: '(按索引对比)', value: undefined },
    ...ap.suggestedKeys.map(k => ({ label: k, value: k }))
  ]
}

const isObjectArray = (arr: any[]): boolean => {
  if (arr.length === 0) return false
  return typeof arr[0] === 'object' && arr[0] !== null
}

const analyzeArrayPaths = (objA: any, objB: any, path = '', results: ArrayPathInfo[] = []): ArrayPathInfo[] => {
  if (Array.isArray(objA) && Array.isArray(objB)) {
    const isObjArrayA = isObjectArray(objA)
    const isObjArrayB = isObjectArray(objB)
    
    if (isObjArrayA || isObjArrayB) {
      const keysA = isObjArrayA ? Object.keys(objA[0]) : []
      const keysB = isObjArrayB ? Object.keys(objB[0]) : []
      const commonKeys = keysA.filter(k => keysB.includes(k))
      
      const suggestedKeys = [
        ...commonKeys.filter(k => commonIdFields.some(f => k.toLowerCase().includes(f.toLowerCase()))),
        ...commonKeys.filter(k => !commonIdFields.some(f => k.toLowerCase().includes(f.toLowerCase())))
      ]

      const existing = results.find(r => r.path === (path || '(root)'))
      if (!existing && (objA.length > 0 || objB.length > 0)) {
        results.push({
          path: path || '(root)',
          countA: objA.length,
          countB: objB.length,
          suggestedKeys,
          matchKey: suggestedKeys.length > 0 ? suggestedKeys[0] : undefined
        })
      }

      if (isObjArrayA) {
        Object.entries(objA[0]).forEach(([key, value]) => {
          const sampleB = isObjArrayB ? objB[0][key] : undefined
          if (Array.isArray(value) && Array.isArray(sampleB)) {
            analyzeArrayPaths(value, sampleB, `${path}[].${key}`, results)
          } else if (typeof value === 'object' && value !== null && typeof sampleB === 'object' && sampleB !== null) {
            analyzeArrayPaths(value, sampleB, `${path}[].${key}`, results)
          }
        })
      }
    }
  } else if (typeof objA === 'object' && objA !== null && typeof objB === 'object' && objB !== null) {
    Object.keys(objA).forEach(key => {
      if (key in objB) {
        const newPath = path ? `${path}.${key}` : key
        analyzeArrayPaths(objA[key], objB[key], newPath, results)
      }
    })
  }

  return results
}

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

const getMatchKeyForPath = (path: string): string | undefined => {
  for (const ap of arrayPaths.value) {
    if (path === ap.path || path.startsWith(ap.path + '[') || path.startsWith(ap.path + '.')) {
      if (path === ap.path || path.replace(/\[\d+\]/g, '[]').startsWith(ap.path.replace(/\[\d+\]/g, '[]'))) {
        return ap.matchKey
      }
    }
    const normalizedApPath = ap.path.replace(/\[\]/g, '[*]')
    const normalizedPath = path.replace(/\[\d+\]/g, '[*]')
    if (normalizedPath === normalizedApPath || normalizedPath.startsWith(normalizedApPath)) {
      return ap.matchKey
    }
  }
  return undefined
}

const deepCompare = (a: any, b: any, path: string): DiffItem[] => {
  const results: DiffItem[] = []

  if (Array.isArray(a) && Array.isArray(b)) {
    const matchKey = getMatchKeyForPath(path)
    
    if (matchKey) {
      const processedB = new Set<number>()
      
      a.forEach((itemA) => {
        if (typeof itemA === 'object' && itemA !== null && matchKey in itemA) {
          const matchValue = itemA[matchKey]
          const matchIndex = b.findIndex((itemB, idx) => 
            !processedB.has(idx) && 
            typeof itemB === 'object' && 
            itemB !== null && 
            itemB[matchKey] === matchValue
          )
          
          if (matchIndex >= 0) {
            processedB.add(matchIndex)
            results.push(...deepCompare(
              itemA, 
              b[matchIndex], 
              `${path}[${matchKey}=${JSON.stringify(matchValue)}]`
            ))
          } else {
            results.push({
              path: `${path}[${matchKey}=${JSON.stringify(matchValue)}]`,
              type: 'removed',
              valueA: itemA
            })
          }
        }
      })
      
      b.forEach((itemB, indexB) => {
        if (!processedB.has(indexB)) {
          if (typeof itemB === 'object' && itemB !== null && matchKey in itemB) {
            results.push({
              path: `${path}[${matchKey}=${JSON.stringify(itemB[matchKey])}]`,
              type: 'added',
              valueB: itemB
            })
          }
        }
      })
    } else {
      const maxLen = Math.max(a.length, b.length)
      for (let i = 0; i < maxLen; i++) {
        const itemPath = `${path}[${i}]`
        if (i >= a.length) {
          results.push({ path: itemPath, type: 'added', valueB: b[i] })
        } else if (i >= b.length) {
          results.push({ path: itemPath, type: 'removed', valueA: a[i] })
        } else {
          results.push(...deepCompare(a[i], b[i], itemPath))
        }
      }
    }
  } else if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)])
    
    allKeys.forEach(key => {
      const keyPath = path ? `${path}.${key}` : key
      if (!(key in a)) {
        results.push({ path: keyPath, type: 'added', valueB: b[key] })
      } else if (!(key in b)) {
        results.push({ path: keyPath, type: 'removed', valueA: a[key] })
      } else {
        results.push(...deepCompare(a[key], b[key], keyPath))
      }
    })
  } else if (a !== b) {
    results.push({ path: path || '(root)', type: 'changed', valueA: a, valueB: b })
  }

  return results
}

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
    diffResult.value = deepCompare(objA, objB, '')
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
</script>
