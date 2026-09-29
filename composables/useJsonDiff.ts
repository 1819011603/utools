/**
 * JSON 结构化对比引擎（从 `pages/json-diff.vue` 下沉）。
 *
 * 纯逻辑，不认识 Vue：`deepCompare` / `getMatchKeyForPath` 需要「数组匹配键」这份状态，
 * 由调用方按参数传入（页面里那个 `arrayPaths` ref）。匹配键的推断（`analyzeArrayPaths`）也在这里。
 */

export interface DiffItem {
  path: string
  type: 'added' | 'removed' | 'changed'
  valueA?: any
  valueB?: any
}

export interface ArrayPathInfo {
  path: string
  countA: number
  countB: number
  suggestedKeys: string[]
  matchKey: string | undefined
}

// 常见的「对象数组主键」字段名：用来给数组匹配键排序（命中越靠前越可能当主键）。
// 不导出（导出数组常量会被 unimport 的自动导入静默影响后面的导出，见 nuxt 约定）。
const commonIdFields = ['id', 'key', 'code', 'name', 'uuid', 'ID', 'Id', 'number', 'no', 'index']

export function useJsonDiff() {
  const getKeyOptions = (ap: ArrayPathInfo) => {
    return [
      { label: '(按索引对比)', value: undefined },
      ...ap.suggestedKeys.map(k => ({ label: k, value: k })),
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
          ...commonKeys.filter(k => !commonIdFields.some(f => k.toLowerCase().includes(f.toLowerCase()))),
        ]

        const existing = results.find(r => r.path === (path || '(root)'))
        if (!existing && (objA.length > 0 || objB.length > 0)) {
          results.push({
            path: path || '(root)',
            countA: objA.length,
            countB: objB.length,
            suggestedKeys,
            matchKey: suggestedKeys.length > 0 ? suggestedKeys[0] : undefined,
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

  const getMatchKeyForPath = (path: string, arrayPaths: ArrayPathInfo[]): string | undefined => {
    for (const ap of arrayPaths) {
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

  const deepCompare = (a: any, b: any, path: string, arrayPaths: ArrayPathInfo[]): DiffItem[] => {
    const results: DiffItem[] = []

    if (Array.isArray(a) && Array.isArray(b)) {
      const matchKey = getMatchKeyForPath(path, arrayPaths)

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
                `${path}[${matchKey}=${JSON.stringify(matchValue)}]`,
                arrayPaths
              ))
            } else {
              results.push({
                path: `${path}[${matchKey}=${JSON.stringify(matchValue)}]`,
                type: 'removed',
                valueA: itemA,
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
                valueB: itemB,
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
            results.push(...deepCompare(a[i], b[i], itemPath, arrayPaths))
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
          results.push(...deepCompare(a[key], b[key], keyPath, arrayPaths))
        }
      })
    } else if (a !== b) {
      results.push({ path: path || '(root)', type: 'changed', valueA: a, valueB: b })
    }

    return results
  }

  return { getKeyOptions, isObjectArray, analyzeArrayPaths, getMatchKeyForPath, deepCompare }
}
