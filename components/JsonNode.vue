<script lang="ts">
import { computed, defineComponent, h, resolveComponent } from 'vue'
import type { VNode } from 'vue'

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

export default JsonNode
</script>
