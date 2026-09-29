/**
 * JSON 格式化/智能解析的纯工具（从 `pages/json-format.vue` 下沉）。
 *
 * 不认识 Vue：这里只有「解析/高亮/从杂文本里抠 JSON/路径深度」这类纯函数，
 * 页面里的 ref（input/parsed/indentSize…）与交互流程仍留在页面。
 */

export function useJsonFormat() {
  // ─── 工具：将值解析为 JSON 对象/数组（递归去转义，最多 depth 层）──────────────
  const resolveToJson = (val: any, depth = 3): any => {
    if (typeof val === 'object' && val !== null) return val
    if (typeof val === 'string' && depth > 0) {
      const trimmed = val.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
      try {
        const result = JSON.parse(trimmed)
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

  return {
    resolveToJson, highlightJson, extractAllJsonFromText, extractEscapedJson,
    tryUnwrap, getPathDepth, getMaxDepthInData,
  }
}
