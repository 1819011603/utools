/**
 * Origin/Referer 输入历史（从 useVideoConnStrategy.ts 下沉）：localStorage 永久保存，供输入框下拉复用。
 *
 * 自动策略下用户很少手填，历史常为空，所以下拉建议用「当前视频域名」兜底保证有可选项。
 */
import type { Ref } from 'vue'

const ORIGIN_HISTORY_KEY = 'video-player-origin-history'
const REFERER_HISTORY_KEY = 'video-player-referer-history'

export interface ConnHeaderHistoryDeps {
  originHint: Ref<string>
  refererHint: Ref<string>
  /** 当前视频地址（videoUrl 或输入框），用来推出「当前域名」做下拉兜底 */
  getVideoUrl: () => string
}

export function useConnHeaderHistory(deps: ConnHeaderHistoryDeps) {
  const { originHint, refererHint } = deps
  const originHistory = ref<string[]>([])
  const refererHistory = ref<string[]>([])

  const loadHeaderHistory = () => {
    try { originHistory.value = JSON.parse(localStorage.getItem(ORIGIN_HISTORY_KEY) || '[]') } catch {}
    try { refererHistory.value = JSON.parse(localStorage.getItem(REFERER_HISTORY_KEY) || '[]') } catch {}
  }
  const rememberOne = (listRef: Ref<string[]>, key: string, value: string) => {
    const v = value.trim()
    if (!v) return
    listRef.value = [v, ...listRef.value.filter(x => x !== v)].slice(0, 30)  // 去重、置顶、上限 30
    try { localStorage.setItem(key, JSON.stringify(listRef.value)) } catch {}
  }
  const rememberHeaders = () => {
    rememberOne(originHistory, ORIGIN_HISTORY_KEY, originHint.value)
    rememberOne(refererHistory, REFERER_HISTORY_KEY, refererHint.value)
  }

  const currentVideoOrigin = computed(() => {
    const u = deps.getVideoUrl().trim()
    if (!u) return ''
    try { return new URL(u.startsWith('//') ? 'https:' + u : u).origin } catch { return '' }
  })
  const originSuggestions = computed(() => {
    const host = currentVideoOrigin.value
    return host ? [host, ...originHistory.value.filter(x => x !== host)] : originHistory.value
  })
  const refererSuggestions = computed(() => {
    const r = currentVideoOrigin.value ? currentVideoOrigin.value + '/' : ''
    return r ? [r, ...refererHistory.value.filter(x => x !== r)] : refererHistory.value
  })

  return { originHistory, refererHistory, loadHeaderHistory, rememberHeaders, originSuggestions, refererSuggestions }
}
