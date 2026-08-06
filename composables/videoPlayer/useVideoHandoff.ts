/**
 * 播放列表的「附加信息」：剧名 / 集名 / 来源 / 按需取址作业单。
 *
 * 这些东西的共同点是：都从交接槽（localStorage `video-player-handoff`）带进来，
 * 都按 **URL** 而不是按下标存。按下标要跟 playlist 严格对齐，任何一处重新赋值
 * playlist 都得记着同步清理，漏一处就会把上一部剧的集名套到新列表上（踩过：onMounted
 * 走 parseAndLoad 加载 query 地址，而 parseAndLoad 里的清理正好把刚读出的集名冲掉）。
 * 按 URL 存则天然对齐，残留条目也只是查不中，无害，且不需要任何清理逻辑。
 */
import type { ClientResolveTask } from '../videoParseRules'
import type { HandoffPayload, PlaylistSource } from './types'

const HANDOFF_KEY = 'video-player-handoff'
const HANDOFF_TTL = 24 * 60 * 60 * 1000

export function useVideoHandoff() {
  // 剧名，来自交接槽。播放器和播放列表的标题位都用它顶掉泛称
  const playlistTitle = ref('')
  // 播放列表的来源，有值才显示「刷新链接」
  const playlistSource = ref<PlaylistSource | null>(null)
  // 显示名；查不到时 getVideoName 退回从 URL 猜文件名。
  // 长剧每一集的地址都叫 index.m3u8，光看文件名分不清第几集
  const playlistNames = ref<Record<string, string>>({})

  // ── 按需取址 ────────────────────────────────────────────────
  // 有些站点自己就是「点一集才给一集地址」，且会限流（4kvm 实测一次取 185 集，
  // 打到 186 发就开始回「请求过于频繁」）。这类列表里存的是源站播放页地址占位，
  // 真正的视频地址等 playByIndex 播到那一集时才现取。
  //
  // 占位地址**不替换成取到的真实地址**：真实地址带时效签名，存下来下次进来就是死链，
  // 而占位地址永远有效，还天然当了进度/集名的稳定键。
  const lazyTask = ref<ClientResolveTask | null>(null)
  // 占位地址 → 作业单下标。按 URL 存而不是按下标，理由同 playlistNames（列表会被整份替换）
  const lazyIndexByUrl = ref<Record<string, number>>({})

  const setLazyTask = (task: ClientResolveTask | null, urls: string[]) => {
    lazyTask.value = task ?? null
    const map: Record<string, number> = {}
    if (task) urls.forEach((u, i) => { map[u] = i })
    lazyIndexByUrl.value = map
  }

  const setPlaylistNames = (urls: string[], names?: string[]) => {
    if (!names || names.length !== urls.length) return
    const map: Record<string, string> = { ...playlistNames.value }
    urls.forEach((u, i) => { if (names[i]) map[u] = names[i] })
    playlistNames.value = map
  }

  const readHandoff = (): HandoffPayload | null => {
    try {
      const raw = localStorage.getItem(HANDOFF_KEY)
      if (!raw) return null
      const p = JSON.parse(raw) as HandoffPayload
      if (!Array.isArray(p?.urls) || !p.urls.length) return null
      if (!p.at || Date.now() - p.at > HANDOFF_TTL) return null
      return p
    } catch {
      return null
    }
  }

  const writeHandoff = (urls: string[], index: number) => {
    try {
      // 名字要一起写回去，否则本页每次同步地址栏都会把交接槽里的集名冲掉
      const picked = urls.map(u => playlistNames.value[u] ?? '')
      const names = picked.every(Boolean) ? picked : undefined
      const payload: HandoffPayload = {
        urls,
        names,
        title: playlistTitle.value || undefined,
        source: playlistSource.value ?? undefined,
        // 作业单必须跟着列表走：列表里存的是占位地址，没有作业单就一集都播不了
        lazy: lazyTask.value ?? undefined,
        index,
        at: Date.now(),
      }
      localStorage.setItem(HANDOFF_KEY, JSON.stringify(payload))
    } catch (e) {
      console.error('写入播放列表交接槽失败:', e)
    }
  }

  /** 把交接槽里的附加信息套用到给定列表上（下标须与槽里完全一致，调用方负责校验） */
  const applyHandoffMeta = (p: HandoffPayload) => {
    setPlaylistNames(p.urls, p.names)
    setLazyTask(p.lazy ?? null, p.urls)
    if (p.title) playlistTitle.value = p.title
    if (p.source) playlistSource.value = p.source
  }

  /** 清空列表时一并清掉附加信息，避免下一份列表串名/串作业单 */
  const clearHandoffMeta = () => {
    playlistNames.value = {}
    playlistTitle.value = ''
    playlistSource.value = null
    setLazyTask(null, [])
  }

  /** 从 URL 猜显示名；交接槽给的集名优先 */
  const getVideoName = (url: string, index: number): string => {
    const named = playlistNames.value[url]
    if (named) return named
    try {
      const filename = new URL(url).pathname.split('/').pop() || ''
      const decoded = decodeURIComponent(filename)
      if (decoded) return decoded
    } catch {}
    return `视频 ${index + 1}`
  }

  return {
    playlistTitle,
    playlistSource,
    playlistNames,
    lazyTask,
    lazyIndexByUrl,
    setLazyTask,
    setPlaylistNames,
    readHandoff,
    writeHandoff,
    applyHandoffMeta,
    clearHandoffMeta,
    getVideoName,
  }
}

export type VideoHandoff = ReturnType<typeof useVideoHandoff>
