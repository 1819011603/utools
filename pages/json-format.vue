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
        <UTextarea
          v-model="input"
          :rows="24"
          placeholder="粘贴或输入 JSON 数据..."
          class="font-mono text-sm"
          @input="debouncedParse"
        />
      </div>

      <div v-if="showTree && parsed">
        <div class="flex justify-between items-center mb-2">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            树形预览
          </label>
          <div class="flex gap-1">
            <UButton @click="expandAll" variant="ghost" size="xs">
              <UIcon name="i-heroicons-arrows-pointing-out" class="w-4 h-4" />
            </UButton>
            <UButton @click="collapseAll" variant="ghost" size="xs">
              <UIcon name="i-heroicons-arrows-pointing-in" class="w-4 h-4" />
            </UButton>
          </div>
        </div>
        <UCard class="h-[576px] overflow-auto">
          <div class="font-mono text-sm json-tree">
            <JsonNode 
              :data="parsed" 
              :path="''" 
              :expanded-paths="expandedPaths" 
              @toggle="togglePath" 
              @copy="copyNode" 
            />
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'

const input = ref('')
const parsed = ref<any>(null)
const error = ref('')
const indentSize = ref('2')
const showTree = ref(true)
const expandedPaths = ref<Set<string>>(new Set())

const indentOptions = [
  { label: '2', value: '2' },
  { label: '4', value: '4' },
]

const stats = computed(() => {
  if (!parsed.value) return ''
  if (Array.isArray(parsed.value)) {
    return `数组, ${parsed.value.length} 项`
  }
  return `对象, ${Object.keys(parsed.value).length} 个键`
})

const collectPaths = (obj: any, prefix = ''): string[] => {
  const paths: string[] = []
  if (Array.isArray(obj)) {
    paths.push(prefix)
    obj.forEach((item, index) => {
      if (typeof item === 'object' && item !== null) {
        paths.push(...collectPaths(item, `${prefix}[${index}]`))
      }
    })
  } else if (typeof obj === 'object' && obj !== null) {
    paths.push(prefix)
    Object.entries(obj).forEach(([key, value]) => {
      const newPath = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'object' && value !== null) {
        paths.push(...collectPaths(value, newPath))
      }
    })
  }
  return paths
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
  } catch (e: any) {
    error.value = e.message
  }
}

const expandAll = () => {
  if (parsed.value) {
    expandedPaths.value = new Set(collectPaths(parsed.value))
  }
}

const collapseAll = () => {
  expandedPaths.value = new Set()
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
    isLast: { type: Boolean, default: true }
  },
  emits: ['toggle', 'copy'],
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
          class: 'ml-2 opacity-0 group-hover:opacity-100 transition-opacity',
          onClick: (e: Event) => { e.stopPropagation(); copy() }
        }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-clipboard-document', class: 'w-3 h-3' }))

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
                onToggle: (p: string) => emit('toggle', p),
                onCopy: (d: any) => emit('copy', d)
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
            class: 'ml-2 opacity-0 group-hover:opacity-100 transition-opacity',
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
