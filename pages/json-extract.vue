<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        JSON 字段提取
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        使用 JQ 风格语法提取 JSON 字段，支持排序、去重等操作
      </p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            输入 JSON
          </label>
          <UTextarea
            v-model="input"
            :rows="12"
            placeholder="粘贴 JSON 数据..."
            class="font-mono text-sm"
            @input="debouncedExtract"
          />
        </div>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="font-medium text-gray-900 dark:text-white">字段路径</h3>
              <UButton @click="showHelp = true" variant="ghost" size="xs">
                <UIcon name="i-heroicons-question-mark-circle" class="w-4 h-4 mr-1" />
                语法帮助
              </UButton>
            </div>
          </template>

          <div class="space-y-3">
            <UInput
              v-model="fieldPath"
              placeholder="如: .data[].id 或 .users[].name"
              class="font-mono"
              @input="debouncedExtract"
            />

            <div v-if="suggestedPaths.length > 0">
              <div class="text-xs text-gray-500 mb-2">推荐路径:</div>
              <div class="flex flex-wrap gap-1">
                <UBadge
                  v-for="path in suggestedPaths"
                  :key="path"
                  color="gray"
                  variant="soft"
                  class="cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700"
                  @click="usePath(path)"
                >
                  {{ path }}
                </UBadge>
              </div>
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3 class="font-medium text-gray-900 dark:text-white">处理选项</h3>
          </template>
          
          <div class="space-y-3">
            <div class="flex flex-wrap gap-4">
              <UCheckbox v-model="options.unique" label="去重" @change="autoExtract" />
              <UCheckbox v-model="options.sort" label="排序" @change="autoExtract" />
              <UCheckbox v-model="options.reverse" label="倒序" @change="autoExtract" />
              <UCheckbox v-model="options.compact" label="过滤空值" @change="autoExtract" />
            </div>

            <div class="flex gap-2 items-center">
              <span class="text-sm text-gray-600 dark:text-gray-400">输出格式:</span>
              <URadioGroup v-model="outputFormat" :options="formatOptions" @change="() => { autoExtract(); saveSettings() }" />
            </div>

            <div class="flex gap-2">
              <UButton @click="extract" color="primary">
                <UIcon name="i-heroicons-funnel" class="w-4 h-4 mr-1" />
                提取
              </UButton>
              <UButton @click="clearAll" variant="ghost" color="red">
                <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
                清空
              </UButton>
            </div>
          </div>
        </UCard>
      </div>

      <div class="space-y-4">
        <UAlert v-if="error" color="red">
          <template #title>错误</template>
          <template #description>{{ error }}</template>
        </UAlert>

        <div>
          <div class="flex justify-between items-center mb-2">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
              提取结果
              <span v-if="resultCount >= 0" class="text-gray-500 font-normal ml-2">
                ({{ resultCount }} 项)
              </span>
            </label>
            <UButton @click="copyResult" variant="outline" size="sm" :disabled="!output">
              <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
              复制
            </UButton>
          </div>
          <UTextarea
            v-model="output"
            :rows="20"
            readonly
            placeholder="提取结果..."
            class="font-mono text-sm"
          />
        </div>
      </div>
    </div>

    <UModal v-model="showHelp">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg">JQ 语法参考</h3>
            <UButton @click="showHelp = false" variant="ghost" icon="i-heroicons-x-mark" />
          </div>
        </template>

        <div class="space-y-4 text-sm">
          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">基本语法</h4>
            <table class="w-full">
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="example in syntaxExamples" :key="example.syntax">
                  <td class="py-2 font-mono text-primary-600 dark:text-primary-400">{{ example.syntax }}</td>
                  <td class="py-2 pl-4 text-gray-600 dark:text-gray-300">{{ example.desc }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">示例数据</h4>
            <pre class="bg-gray-100 dark:bg-gray-800 p-3 rounded text-xs overflow-auto">{{ exampleJson }}</pre>
          </div>

          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">提取示例</h4>
            <table class="w-full">
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="ex in extractExamples" :key="ex.path">
                  <td class="py-2 font-mono text-primary-600 dark:text-primary-400">{{ ex.path }}</td>
                  <td class="py-2 pl-4 font-mono text-gray-600 dark:text-gray-300">{{ ex.result }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <UButton @click="loadExample" block variant="soft">
            加载示例数据
          </UButton>
        </div>
      </UCard>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'

const input = ref('')
const fieldPath = ref('')
const output = ref('')
const error = ref('')
const showHelp = ref(false)
const resultCount = ref(-1)

const STORAGE_KEY = 'json-extract-settings'

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

const commonFieldNames = ['id', 'name', 'code', 'number', 'title', 'key', 'value', 'type', 'status']

const analyzePaths = (obj: any, prefix = '', depth = 0): string[] => {
  const paths: string[] = []
  if (depth > 5) return paths
  
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
      Object.keys(obj[0]).forEach(key => {
        paths.push(`${prefix}[].${key}`)
      })
      Object.entries(obj[0]).forEach(([key, value]) => {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          paths.push(...analyzePaths(value, `${prefix}[].${key}`, depth + 1))
        }
      })
    }
  } else if (typeof obj === 'object' && obj !== null) {
    Object.entries(obj).forEach(([key, value]) => {
      const newPrefix = prefix ? `${prefix}.${key}` : `.${key}`
      
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
          Object.keys(value[0]).forEach(subKey => {
            paths.push(`${newPrefix}[].${subKey}`)
          })
          Object.entries(value[0]).forEach(([subKey, subValue]) => {
            if (Array.isArray(subValue) && subValue.length > 0 && typeof subValue[0] === 'object') {
              paths.push(...analyzePaths(subValue, `${newPrefix}[].${subKey}`, depth + 1))
            }
          })
        }
      } else if (typeof value === 'object' && value !== null) {
        paths.push(...analyzePaths(value, newPrefix, depth + 1))
      } else {
        if (commonFieldNames.includes(key)) {
          paths.unshift(newPrefix)
        } else {
          paths.push(newPrefix)
        }
      }
    })
  }
  
  const uniquePaths = [...new Set(paths)]
  const prioritized = uniquePaths.sort((a, b) => {
    const aHasCommon = commonFieldNames.some(f => a.endsWith(`.${f}`))
    const bHasCommon = commonFieldNames.some(f => b.endsWith(`.${f}`))
    if (aHasCommon && !bHasCommon) return -1
    if (!aHasCommon && bHasCommon) return 1
    return 0
  })
  
  return prioritized.slice(0, 15)
}

const parseJqPath = (path: string, obj: any): any[] => {
  const results: any[] = []
  
  const extractValue = (current: any, pathParts: string[]): void => {
    if (pathParts.length === 0) {
      results.push(current)
      return
    }
    
    const part = pathParts[0]
    const rest = pathParts.slice(1)
    
    if (part === '[]') {
      if (Array.isArray(current)) {
        current.forEach(item => extractValue(item, rest))
      }
    } else if (part.match(/^\[\d+\]$/)) {
      const index = parseInt(part.slice(1, -1))
      if (Array.isArray(current) && index < current.length) {
        extractValue(current[index], rest)
      }
    } else if (part.match(/^\[-\d+\]$/)) {
      const index = parseInt(part.slice(1, -1))
      if (Array.isArray(current)) {
        const actualIndex = current.length + index
        if (actualIndex >= 0) {
          extractValue(current[actualIndex], rest)
        }
      }
    } else if (part.match(/^\[\d+:\d+\]$/)) {
      const [start, end] = part.slice(1, -1).split(':').map(Number)
      if (Array.isArray(current)) {
        current.slice(start, end).forEach(item => extractValue(item, rest))
      }
    } else if (part.includes(',')) {
      const fields = part.split(',').map(f => f.trim())
      if (typeof current === 'object' && current !== null) {
        const extracted: any = {}
        fields.forEach(f => {
          if (f in current) {
            extracted[f] = current[f]
          }
        })
        results.push(extracted)
      }
    } else {
      if (typeof current === 'object' && current !== null && part in current) {
        extractValue(current[part], rest)
      }
    }
  }
  
  const normalizedPath = path.startsWith('.') ? path.slice(1) : path
  
  const parts: string[] = []
  let current = ''
  let inBracket = false
  
  for (const char of normalizedPath) {
    if (char === '[') {
      if (current) {
        parts.push(...current.split('.').filter(Boolean))
        current = ''
      }
      inBracket = true
      current = '['
    } else if (char === ']') {
      current += ']'
      parts.push(current)
      current = ''
      inBracket = false
    } else if (char === '.' && !inBracket) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  
  if (current) {
    parts.push(...current.split('.').filter(Boolean))
  }
  
  extractValue(obj, parts)
  
  return results
}

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
</script>
