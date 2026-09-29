import type { useVideoParseResolve } from '~/composables/useVideoParseResolve'

/**
 * 续看条、收藏按钮与解析历史的展示/操作：续看落点计算、收藏切换、历史条目的
 * 站点标签与时间格式化、清空历史，以及各类复制。
 * 依赖 useVideoParseResolve 的共享上下文。
 */
export function useVideoParseHistory(vp: ReturnType<typeof useVideoParseResolve>) {
  const toast = useToast()
  const {
    result, currentLine, resolvedEpisodes,
    resumeWatch, resumeDismissed, forgetWatch,
    faved, toggleFav,
    parseHistory, clearHistory,
  } = vp

  /**
   * 续看落点。**先按集名认，再退回序号**：源站会往中间加塞（实测 ylsp 有「上/下」），
   * 而记录可能是几天前、甚至另一条线路上记的，那时的序号早就指到别人身上了
   * （与 URL 参数直链里 `ep` 优先于 `index` 是同一条规矩）。
   */
  const resumeTarget = computed(() => {
    const w = resumeWatch.value
    const eps = currentLine.value?.episodes || []
    if (!w || resumeDismissed.value || eps.length <= 1) return null
    const byName = w.epName ? eps.findIndex(e => (e.title || '') === w.epName) : -1
    const index = byName >= 0 ? byName : (w.index < eps.length ? w.index : -1)
    // 落在第 1 集就不必提示了：那跟「从头看」没区别，白占一行
    if (index <= 0) return null
    return { index, epName: eps[index]?.title || w.epName }
  })

  const toggleFavCurrent = () => {
    const r = result.value
    if (!r) return
    faved.value = toggleFav({
      title: r.title || '',
      pageUrl: r.pageUrl,
      line: r.activeLineIndex,
      lineName: currentLine.value?.name,
      cover: r.cover,
      cat: r.cat,
    })
  }

  /** 记录是在别的线路上记的：集数可能不一样，落点只能按集名/序号猜，要如实说出来 */
  const resumeOtherLine = computed(() =>
    !!resumeWatch.value?.lineName && resumeWatch.value.lineName !== currentLine.value?.name)

  const dismissResume = () => {
    resumeDismissed.value = true
    // 连记录一起删掉：用户明确说了不用续看，留着下次解析又冒出来就成了牛皮糖
    forgetWatch({ title: result.value?.title, pageUrl: result.value?.pageUrl })
  }

  const formatWhen = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

  const copyPageLink = async () => {
    await navigator.clipboard.writeText(location.href)
    toast.add({ title: '已复制本页链接', color: 'green' })
  }

  const copyOne = async (url: string) => {
    await navigator.clipboard.writeText(url)
    toast.add({ title: '已复制', color: 'green' })
  }

  const copyAll = async () => {
    const text = resolvedEpisodes.value.map(e => e.videoUrl).join('\n')
    if (!text) return
    await navigator.clipboard.writeText(text)
    toast.add({ title: `已复制 ${resolvedEpisodes.value.length} 条地址`, color: 'green' })
  }

  const clearAllHistory = () => {
    clearHistory()
    parseHistory.value = []
  }

  return {
    resumeTarget, resumeOtherLine, dismissResume,
    faved, toggleFavCurrent,
    formatWhen, copyPageLink, copyOne, copyAll, clearAllHistory,
  }
}
