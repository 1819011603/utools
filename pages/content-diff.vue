<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        内容对比
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        文本内容集合操作，支持交集、并集、差集等
      </p>
    </div>

    <UCard class="mb-4">
      <div class="flex flex-wrap gap-4 items-end">
        <div class="flex-1 min-w-[150px]">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            分隔符
          </label>
          <div class="flex gap-2">
            <USelect v-model="separatorType" :options="separatorOptions" class="flex-1" />
            <UInput
              v-if="separatorType === 'custom'"
              v-model="customSeparator"
              placeholder="自定义"
              class="w-24"
            />
          </div>
        </div>

        <div class="flex gap-2">
          <UButtonGroup>
            <UButton
              v-for="op in operations"
              :key="op.value"
              :color="operation === op.value ? 'primary' : 'gray'"
              :variant="operation === op.value ? 'solid' : 'outline'"
              @click="operation = op.value; execute()"
            >
              {{ op.label }}
            </UButton>
          </UButtonGroup>
        </div>

        <div class="flex gap-2">
          <UButton @click="execute" color="primary">
            <UIcon name="i-heroicons-play" class="w-4 h-4 mr-1" />
            执行
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
    </UCard>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      <div>
        <div class="flex justify-between items-center mb-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            内容 A
            <span v-if="countA >= 0" class="text-gray-500 font-normal ml-2">
              ({{ countA }} 项)
            </span>
          </label>
          <div class="flex gap-1">
            <UButton @click="sortInput('A')" variant="ghost" size="xs" title="排序">
              <UIcon name="i-heroicons-bars-arrow-down" class="w-4 h-4" />
            </UButton>
            <UButton @click="uniqueInput('A')" variant="ghost" size="xs" title="去重">
              <UIcon name="i-heroicons-funnel" class="w-4 h-4" />
            </UButton>
            <UButton @click="trimInput('A')" variant="ghost" size="xs" title="去除空行">
              <UIcon name="i-heroicons-scissors" class="w-4 h-4" />
            </UButton>
          </div>
        </div>
        <UTextarea
          v-model="inputA"
          :rows="10"
          placeholder="输入内容 A，每行一项..."
          class="font-mono text-sm"
          @input="updateCounts"
        />
      </div>

      <div>
        <div class="flex justify-between items-center mb-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            内容 B
            <span v-if="countB >= 0" class="text-gray-500 font-normal ml-2">
              ({{ countB }} 项)
            </span>
          </label>
          <div class="flex gap-1">
            <UButton @click="sortInput('B')" variant="ghost" size="xs" title="排序">
              <UIcon name="i-heroicons-bars-arrow-down" class="w-4 h-4" />
            </UButton>
            <UButton @click="uniqueInput('B')" variant="ghost" size="xs" title="去重">
              <UIcon name="i-heroicons-funnel" class="w-4 h-4" />
            </UButton>
            <UButton @click="trimInput('B')" variant="ghost" size="xs" title="去除空行">
              <UIcon name="i-heroicons-scissors" class="w-4 h-4" />
            </UButton>
          </div>
        </div>
        <UTextarea
          v-model="inputB"
          :rows="10"
          placeholder="输入内容 B，每行一项..."
          class="font-mono text-sm"
          @input="updateCounts"
        />
      </div>
    </div>

    <UCard class="mb-4">
      <div class="flex flex-wrap gap-4 items-center text-sm">
        <span class="text-gray-600 dark:text-gray-400">当前操作:</span>
        <div class="flex items-center gap-2 font-medium">
          <UBadge color="blue" variant="soft">A</UBadge>
          <span>{{ operationDescription }}</span>
          <UBadge color="green" variant="soft">B</UBadge>
        </div>
        <span class="text-gray-500">{{ operationHint }}</span>
      </div>
    </UCard>

    <div>
      <div class="flex justify-between items-center mb-2">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
          结果
          <span v-if="resultCount >= 0" class="text-gray-500 font-normal ml-2">
            ({{ resultCount }} 项)
          </span>
        </label>
        <div class="flex gap-2">
          <UButton @click="copyResult" variant="outline" size="sm" :disabled="!output">
            <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
            复制
          </UButton>
          <UButton @click="useResultAsA" variant="outline" size="sm" :disabled="!output">
            结果 → A
          </UButton>
          <UButton @click="useResultAsB" variant="outline" size="sm" :disabled="!output">
            结果 → B
          </UButton>
        </div>
      </div>
      <UTextarea
        v-model="output"
        :rows="10"
        readonly
        placeholder="操作结果..."
        class="font-mono text-sm"
      />
    </div>

    <UCard class="mt-6">
      <template #header>
        <h3 class="font-medium text-gray-900 dark:text-white">操作说明</h3>
      </template>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <div class="font-medium text-gray-900 dark:text-white mb-1">A - B (差集)</div>
          <div class="text-gray-600 dark:text-gray-400">A 中有但 B 中没有的元素</div>
        </div>
        <div>
          <div class="font-medium text-gray-900 dark:text-white mb-1">B - A (差集)</div>
          <div class="text-gray-600 dark:text-gray-400">B 中有但 A 中没有的元素</div>
        </div>
        <div>
          <div class="font-medium text-gray-900 dark:text-white mb-1">A ∩ B (交集)</div>
          <div class="text-gray-600 dark:text-gray-400">A 和 B 共有的元素</div>
        </div>
        <div>
          <div class="font-medium text-gray-900 dark:text-white mb-1">A ∪ B (并集)</div>
          <div class="text-gray-600 dark:text-gray-400">A 和 B 所有不重复的元素</div>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import type { HistoryItem } from '~/composables/useHistory'

interface ContentDiffHistory {
  inputA: string
  inputB: string
}

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
</script>
