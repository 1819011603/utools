/**
 * 「刷新链接」——就地重解析当前列表、换成新链接（从 useVideoPlaylistCtl.ts 下沉）。
 *
 * 动机：部分线路给的是带签名的地址（`?sign=…&timestamp=…`），过一阵会失效，表现为好好播着突然 403。
 * 此时不必回解析页重来，用 `playlistSource` 记着的「源页面地址 + 线路」原地重解析即可。
 *
 * 三个要点：
 *   · 按集名认当前集，不按下标——重解析后可能多出或少掉几集，下标会错位
 *   · 播放进度是按 URL 存的，地址一换就查不到了，所以要手动搬到新地址上
 *   · 只有当前这一集需要重载；其余集的新地址进列表即可，切过去时自然生效
 */
import type { Ref } from 'vue'
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoHandoff } from '../useVideoHandoff'

export interface PlaylistRefreshDeps {
  playlist: Ref<string[]>
  currentIndex: Ref<number>
  /** 列表整份换了：把「媒体元素当前装着的那一集」同步过去 */
  setPlayingIndex: (i: number) => void
  media: VideoMediaState
  handoff: VideoHandoff
  isRefreshingLinks: Ref<boolean>
  lastRefreshAt: Ref<number>
  resolveLazyUrl: (placeholder: string) => Promise<string>
  clearLazyUrlCache: () => void
  onDirty: () => void
  syncUrl: () => void
  loadVideo: () => Promise<void>
}

export function usePlaylistRefresh(deps: PlaylistRefreshDeps) {
  const { playlist, currentIndex, media, handoff, isRefreshingLinks, lastRefreshAt } = deps
  const { savedProgress, videoUrl } = media

  const refreshPlaylistLinks = async () => {
    const src = handoff.playlistSource.value
    if (!src || isRefreshingLinks.value) return

    isRefreshingLinks.value = true
    const toast = useToast()
    try {
      // 用户自定义规则要带上：服务端没有 localStorage，不带的话自定义规则的站点刷不动
      const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line, rules: loadUserParseRules() })
      const { urls, names } = toPlaylist(result)
      if (!urls.length) throw new Error('没有解析出可播放的地址')

      // 刷新前后按「集名 → 地址」对照，才能说清到底变了什么。
      // 只报「已刷新 N 集」等于没说：用户要知道的是地址换没换、集数多没多
      const before = new Map<string, string>()
      playlist.value.forEach((u, i) => before.set(handoff.playlistNames.value[u] ?? `#${i}`, u))
      let changed = 0
      let added = 0
      names.forEach((n, i) => {
        const old = before.get(n)
        if (old === undefined) added++
        else if (old !== urls[i]) changed++
      })
      const removed = [...before.keys()].filter(n => !names.includes(n)).length

      // 认名字而不是下标：集数可能变了
      const curUrl = playlist.value[currentIndex.value] ?? ''
      const curName = handoff.playlistNames.value[curUrl] ?? ''
      const hit = curName ? names.indexOf(curName) : -1
      const nextIndex = hit >= 0 ? hit : Math.min(currentIndex.value, urls.length - 1)
      const curChanged = urls[nextIndex] !== curUrl

      // 进度按 URL 存，换地址等于丢进度 → 先把当前时间搬到新地址上，
      // 后面 loadVideo 里的 getSavedProgress 就能原位续播
      const pos = media.videoEl.value?.currentTime ?? media.currentTime.value
      if (curChanged && pos > 0) savedProgress.value[urls[nextIndex]] = pos

      playlist.value = urls
      handoff.setPlaylistNames(urls, names)
      // 作业单里的令牌是源站按次渲染的，会过期 → 刷新时一并换成新的
      handoff.setLazyTask(result.clientTask?.lazy ? result.clientTask : null, urls)
      deps.clearLazyUrlCache()   // 预热的地址是用旧令牌取的，跟着一起作废
      if (result.title) handoff.playlistTitle.value = result.title
      if (result.cover) handoff.playlistCover.value = result.cover
      if (result.cat) handoff.playlistCat.value = result.cat
      // 线路表也跟着刷新：源站增删线路之后，换源面板里那份不更新就会指到别的线路去
      handoff.playlistLines.value = result.lines.map(l => ({
        name: l.name, sublabel: l.sublabel, count: l.episodes.length,
      }))
      // 线路名跟着刷新一起更新：源站改了线路名的话，地址栏里那份得跟上，
      // 否则下次按名字认线路会落空、白白多解析一轮
      handoff.playlistSource.value = {
        ...src,
        line: result.activeLineIndex,
        lineName: result.lines[result.activeLineIndex]?.name || src.lineName,
      }
      currentIndex.value = nextIndex
      deps.setPlayingIndex(nextIndex)   // 列表换了，旧集下标作废（存进度按 playingIndex）
      lastRefreshAt.value = Date.now()
      deps.onDirty()
      deps.syncUrl()

      // 当前这集地址没变就别重载：正播着呢，重载纯属打断。
      // 按需取址的列表里存的是永不变的占位地址，curChanged 恒为 false，
      // 正好就是想要的行为——刷新只为把新增的集数和新令牌收进来，不该打断播放
      if (curChanged) {
        const next = await deps.resolveLazyUrl(urls[nextIndex])
        if (next) {
          videoUrl.value = next
          media.isRestoringFromSaved.value = true
          await deps.loadVideo()
        }
      }

      if (!changed && !added && !removed) {
        toast.add({
          title: '链接没有变化',
          description: `共 ${urls.length} 集，源站给的还是原来的地址`,
          color: 'blue',
          timeout: 3000,
        })
      } else {
        const parts: string[] = []
        if (changed) parts.push(`${changed} 集换了新地址`)
        if (added) parts.push(`新增 ${added} 集`)
        if (removed) parts.push(`少了 ${removed} 集`)
        toast.add({
          title: '刷新完成：' + parts.join('，'),
          description: `共 ${urls.length} 集` + (curChanged ? '；当前这集已用新地址重新载入' : '；当前这集地址未变，未打断播放'),
          color: 'green',
          timeout: 4000,
        })
      }
    } catch (e: any) {
      const msg = e?.statusMessage || e?.data?.statusMessage || e?.message || '刷新失败'
      toast.add({ title: '刷新链接失败', description: msg, color: 'red', timeout: 6000 })
    } finally {
      isRefreshingLinks.value = false
    }
  }

  return { refreshPlaylistLinks }
}
