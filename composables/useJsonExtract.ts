/**
 * JSON 路径提取引擎（从 `pages/json-extract.vue` 下沉）。
 *
 * 纯逻辑，不认识 Vue：`analyzePaths` 给出「可能想抽的字段路径」候选，`parseJqPath` 按
 * 类 jq 的路径语法取值（`[]` 展开数组、`[n]`/`[-n]`/`[a:b]`、`a,b` 挑字段）。
 */

// 常见字段名：命中的路径在候选里排前面（越可能被抽）。
// 不导出（导出数组常量会被 unimport 的自动导入静默影响后面的导出，见 nuxt 约定）。
const commonFieldNames = ['id', 'name', 'code', 'number', 'title', 'key', 'value', 'type', 'status']

export function useJsonExtract() {
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

  return { analyzePaths, parseJqPath }
}
