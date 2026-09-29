import { useJsonFormat } from '~/composables/useJsonFormat'
import type { useJsonFormatState } from '~/composables/useJsonFormatState'

/**
 * json-format 页面的树形预览相关逻辑：深度/统计 computed、展开/收起、
 * 删除/恢复、路径收集、节点复制、定位。
 * 依赖 state（state → tree → editor）。
 */
export function useJsonFormatTree(state: ReturnType<typeof useJsonFormatState>) {
  const { getPathDepth, getMaxDepthInData } = useJsonFormat()
  const {
    input, parsed, indentSize, expandedPaths, deletedPaths, deletedStack,
    currentExpandLevel, textareaRef, preRef,
  } = state

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

  const syncEditorScroll = () => {
    const ta = textareaRef.value as HTMLTextAreaElement | undefined
    const pre = preRef.value
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
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

  return {
    maxDepth, currentMaxDepth, stats, collectPaths, expandToLevel, expandAll, collapseAll,
    togglePath, deletePath, undoDelete, restoreAllDeleted, filterByDeletedPaths,
    copyNode, copyAll, syncEditorScroll, locateInJson,
  }
}
