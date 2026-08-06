/**
 * 播放列表：解析输入、切集、进度记忆、按需取址、就地刷新链接。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoHandoff } from './useVideoHandoff'

export interface VideoPlaylistDeps {
  media: VideoMediaState
  handoff: VideoHandoff
  /** 状态有变，持久化一次 */
  onDirty: () => void
  /** 把当前列表/集数写回地址栏 */
  syncUrl: () => void
  /** 加载 videoUrl 指向的视频 */
  loadVideo: () => Promise<void>
}

export function useVideoPlaylistCtl(deps: VideoPlaylistDeps) {
  const { media, handoff } = deps
  const { videoUrl, videoUrlInput, errorMessage, savedProgress } = media

  const playlist = ref<string[]>([])
  const currentIndex = ref(0)
  const hasPrev = computed(() => currentIndex.value > 0)
  const hasNext = computed(() => currentIndex.value < playlist.value.length - 1)

  const isRefreshingLinks = ref(false)
  const lastRefreshAt = ref(0)

  // ── 进度记忆 ──

  /**
   * 进度存取用的键。
   *
   * 普通列表里 playlist[currentIndex] 就等于 videoUrl，取哪个都一样；
   * 但按需取址的站点每次现取到的真实地址都不同（带时效签名），拿它当键等于每次都查不到，
   * 所以一律用播放列表里那个稳定的占位地址。没有播放列表时（直接贴地址播）退回 videoUrl。
   */
  const progressKey = (): string => playlist.value[currentIndex.value] || videoUrl.value

  const saveCurrentProgress = () => {
    const key = progressKey()
    if (key && media.currentTime.value > 0) {
      savedProgress.value[key] = media.currentTime.value
      deps.onDirty()
    }
  }

  const getSavedProgress = (url: string): number => savedProgress.value[url] || 0

  const clearAllProgress = () => {
    savedProgress.value = {}
    deps.onDirty()
  }

  // ── 按需取址 ──

  /**
   * 占位地址 → 真实播放地址。不是占位就原样返回。
   *
   * 为什么每次播都重取而不缓存下来：这类地址带时效签名，缓存到列表里下次进来就是死链，
   * 而且站点限流，与其提前批量取被封，不如播一集取一集（站点自己也是这么做的）。
   *
   * 作业单里的令牌是源站按次渲染的、会过期。失败时若知道来源页面，就重解析一次拿新作业单再试，
   * 只重试一次——真失效和真限流表现一样，无限重试只会把限流坐实。
   */
  const resolveLazyUrl = async (placeholder: string): Promise<string> => {
    const idx = handoff.lazyIndexByUrl.value[placeholder]
    if (!handoff.lazyTask.value || idx === undefined) return placeholder

    media.isResolvingUrl.value = true
    errorMessage.value = ''
    try {
      try {
        return await resolveOneUrl(handoff.lazyTask.value, idx)
      } catch (e) {
        const src = handoff.playlistSource.value
        if (!src) throw e
        const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line })
        if (!result.clientTask?.lazy) throw e
        // 集数可能变了，按集名把下标对回来；对不上就退回原下标
        const names = (result.lines[result.activeLineIndex]?.episodes ?? []).map(ep => ep.title)
        const want = handoff.playlistNames.value[placeholder]
        const hit = want ? names.indexOf(want) : -1
        handoff.lazyTask.value = result.clientTask
        return await resolveOneUrl(result.clientTask, hit >= 0 ? hit : idx)
      }
    } catch (e: any) {
      errorMessage.value = '获取播放地址失败：' + (e?.message || '未知错误')
      return ''
    } finally {
      media.isResolvingUrl.value = false
    }
  }

  // ── 切集 ──

  /**
   * 解析多行输入并加载。
   * startIndex 只由代码调用时传（?index=N）；模板里当事件回调用，首参是 Event，故做类型判断。
   */
  const parseAndLoad = async (startIndex?: number | Event) => {
    const input = videoUrlInput.value.trim()
    if (!input) return

    const urls = input
      .split(/[\n\r]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && (line.startsWith('http') || line.startsWith('//')))

    if (urls.length === 0) {
      errorMessage.value = '未找到有效的视频链接'
      return
    }

    playlist.value = urls
    // 手工贴进来的地址跟上一份作业单没关系了（占位地址对不上），留着只会把过期作业单持久化下去
    if (handoff.lazyTask.value && !urls.every(u => handoff.lazyIndexByUrl.value[u] !== undefined)) {
      handoff.setLazyTask(null, [])
    }
    const from = typeof startIndex === 'number' && startIndex >= 0 && startIndex < urls.length ? startIndex : 0
    currentIndex.value = from

    deps.onDirty()
    await playByIndex(from)
  }

  const playByIndex = async (index: number) => {
    if (index < 0 || index >= playlist.value.length) return

    saveCurrentProgress()
    currentIndex.value = index

    // 按需取址的站点：列表里是占位地址，真实地址现取（拿不到就别往下走，
    // 否则 hls.js 会去加载源站的 HTML 页面，报一个完全看不懂的解析错）
    const realUrl = await resolveLazyUrl(playlist.value[index])
    if (!realUrl) return

    videoUrl.value = realUrl
    media.hasSkippedIntro.value = false

    deps.onDirty()
    deps.syncUrl()   // 地址栏跟着当前集数走，随时可复制分享

    // 切换集数时标记需要自动播放（MP4 在 onCanPlay 中触发，HLS 在 MANIFEST_PARSED 中已有）
    media.isRestoringFromSaved.value = true

    await deps.loadVideo()
  }

  const playPrev = async () => { if (hasPrev.value) await playByIndex(currentIndex.value - 1) }
  const playNext = async () => { if (hasNext.value) await playByIndex(currentIndex.value + 1) }

  const clearPlaylist = () => {
    playlist.value = []
    handoff.clearHandoffMeta()
    currentIndex.value = 0
    videoUrlInput.value = ''
    deps.syncUrl()
  }

  const loadExample = async (url: string) => {
    videoUrlInput.value = url
    await parseAndLoad()
  }

  // ── 刷新链接 ──

  /**
   * 就地重新解析当前播放列表，换成新链接。
   *
   * 动机：部分线路给的是带签名的地址（`?sign=…&timestamp=…`），过一阵会失效，
   * 表现为好好播着突然 403。此时不必回解析页重来一遍，用交接槽里带过来的
   * 「源页面地址 + 线路」原地重解析即可。
   *
   * 三个要点：
   *   · 按集名认当前集，不按下标——重解析后可能多出或少掉几集，下标会错位
   *   · 播放进度是按 URL 存的，地址一换就查不到了，所以要手动搬到新地址上
   *   · 只有当前这一集需要重载；其余集的新地址进列表即可，切过去时自然生效
   */
  const refreshPlaylistLinks = async () => {
    const src = handoff.playlistSource.value
    if (!src || isRefreshingLinks.value) return

    isRefreshingLinks.value = true
    const toast = useToast()
    try {
      const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line })
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
      if (result.title) handoff.playlistTitle.value = result.title
      currentIndex.value = nextIndex
      lastRefreshAt.value = Date.now()
      deps.onDirty()
      deps.syncUrl()

      // 当前这集地址没变就别重载：正播着呢，重载纯属打断。
      // 按需取址的列表里存的是永不变的占位地址，curChanged 恒为 false，
      // 正好就是想要的行为——刷新只为把新增的集数和新令牌收进来，不该打断播放
      if (curChanged) {
        const next = await resolveLazyUrl(urls[nextIndex])
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

  return {
    playlist, currentIndex, hasPrev, hasNext, isRefreshingLinks, lastRefreshAt,
    progressKey, saveCurrentProgress, getSavedProgress, clearAllProgress,
    parseAndLoad, playByIndex, playPrev, playNext, clearPlaylist, loadExample,
    resolveLazyUrl, refreshPlaylistLinks,
  }
}

export type VideoPlaylistCtl = ReturnType<typeof useVideoPlaylistCtl>
