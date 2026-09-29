import type { ProbeVerdict } from '~/composables/videoPlayer/probeDiagnose'
import type { useVideoParseResolve } from '~/composables/useVideoParseResolve'

/**
 * 可达性检测的结论与「播放前二次确认」，以及把整条线路送进播放器开新标签。
 * 依赖 useVideoParseResolve 的共享上下文（结果、当前线路、检测目标等）。
 */
export function useVideoParsePlay(vp: ReturnType<typeof useVideoParseResolve>) {
  const toast = useToast()
  const { result, inputUrl, currentLine, isLazy, checkTarget } = vp

  /** 源站播放页的 origin，带去播放器当防盗链候选值（推不出来的那类站点全靠它） */
  const originOfPage = (pageUrl: string): string => {
    const u = (pageUrl || '').trim()
    if (!u) return ''
    try { return new URL(u.startsWith('//') ? 'https:' + u : u).origin } catch { return '' }
  }

  /**
   * 防盗链候选值。**送进播放器的那一对和本页「可达性检测」用的必须是同一对**——
   * 差一点就等于测的是另一套配置，结论对播放毫无意义。
   *
   * 规则显式声明的优先（那是站点作者写死的正确值）：有的站点视频只认某个第三方域名，
   * 播放页域名照样 403（实测 netflixgc.net → cjbfq.netflixgc.tv），拿播放页 origin 兜底反而是错的。
   */
  const srcOrigin = computed(() => originOfPage(result.value?.pageUrl || inputUrl.value))
  const hintOrigin = computed(() => result.value?.origin || srcOrigin.value)
  const hintReferer = computed(() =>
    result.value?.referer || (srcOrigin.value ? srcOrigin.value + '/' : ''))

  // ── 可达性检测的结论（由 <VideoParseReachCheck> 上报）与「播放前二次确认」 ──
  //
  // 检测通过就直接进播放器；没过（没测出结论 / 正在测 / 实测不通）就先问一句。
  // 理由：这一步的成本是一次点击，而它避免的是「进播放器 → 转圈一分钟 → 回来换线路」那一整圈。
  // 反过来也要成立——**通过了就绝不多问**，否则每次播放都弹窗只会被训练成无脑点确认。
  const reach = ref<{ probing: boolean; verdict: ProbeVerdict | null }>({ probing: false, verdict: null })
  const reachPassed = computed(() => reach.value.verdict?.severity === 'ok')

  // 被测地址一变就先把结论清空。**必须按 url 字符串盯**，不能盯 checkTarget 本身：
  // 那是个 computed 出来的新对象，选集数组一动就换引用，而此时子组件的状态没变、不会重新上报，
  // 于是「通过」被清成 null，明明测过也要弹一次确认。
  // 反过来这道清空也不能省：换到没有可测地址的线路时子组件压根不渲染（也就不再上报），
  // 不清就会拿上一条线路的「通过」给这一条放行
  watch(() => checkTarget.value?.url, () => { reach.value = { probing: false, verdict: null } })

  const confirmOpen = ref(false)
  let pendingPlay: (() => void) | null = null

  /** 弹窗里的说法：三种「没过」各有各的原因，混成一句「可能播不了」就等于没说 */
  const playGuard = computed(() => {
    const { probing, verdict } = reach.value
    if (probing) return {
      title: '可达性检测还没跑完',
      detail: '再等一两秒就有结论了。现在进播放器也行，只是万一这条线路是死的，你会在那边白等一轮转圈。',
    }
    if (!verdict) return {
      title: '这条线路还没测出可达性',
      detail: '可能是刚切过来、或检测本身失败了。没测过就进播放器，遇到死链只能在那边干等。',
    }
    return { title: verdict.title, detail: verdict.detail }
  })

  const requestPlay = (startIndex = 0) => {
    if (reachPassed.value) { playAll(startIndex); return }
    pendingPlay = () => playAll(startIndex)
    confirmOpen.value = true
  }

  const confirmPlay = () => {
    confirmOpen.value = false
    // 必须同步调用：window.open 只在用户手势的调用栈里才不被拦（这里就是那次点击）
    pendingPlay?.()
    pendingPlay = null
  }

  /**
   * 播放器**开新标签页**。看片是个长时间停留的动作，而解析页上还有整张线路表——
   * 同标签跳走的话想换条线路就得按返回键（还要重跑一遍解析，见 video-parse-last-result 那份缓存）。
   *
   * 要带的东西全在 query 里（`?parseUrl=…&line=…&index=…`），新标签打开即自己解析一遍，
   * 不依赖本机存的任何东西。弹窗被拦（返回 null）时退回同标签跳转：宁可跳走也别让按钮点了没反应。
   */
  const openPlayer = (qs: string) => {
    const href = '/video-player?' + qs
    if (window.open(href, '_blank')) return
    toast.add({ title: '新标签被浏览器拦了，已在当前页打开', color: 'orange' })
    void navigateTo(href)
  }

  const playAll = (startIndex = 0) => {
    const eps = currentLine.value?.episodes || []
    // 按需取址的站点整份带走（列表里是占位地址，下标必须与作业单对齐）；
    // 其余站点只装解析成功的，索引按过滤后的位置重新算
    const playable = isLazy.value ? eps : eps.filter(e => e.videoUrl)
    if (!playable.length) return
    const clicked = eps[startIndex]
    const idx = Math.max(0, playable.findIndex(e => e === clicked))
    const urls = playable.map(e => (isLazy.value ? e.pageUrl : e.videoUrl!)) as string[]
    // 集名一并带过去：长剧每集的地址都叫 index.m3u8，播放器光看 URL 认不出第几集
    const names = playable.map((e, i) => e.title || `第 ${i + 1} 集`)

    const params = new URLSearchParams()

    // 「从哪解析的 + 哪条线路 + 第几集」：链接短、可以直接分享，且不怕地址过期——
    // 打开的人（包括本机）都由播放器拿这三个参数自己解析一遍，列表/作业单永远是源站实况。
    //
    // 解析成功必然有 pageUrl（`resolve.ts` 直接回填请求地址），所以这条路是恒定的；
    // 下面那个 urls= 分支只是防御性兜底。**这里原来还写一份 localStorage 交接槽**
    // （`video-player-handoff`）给「长列表 / 按需取址」两条分支用，而那两条分支恰恰因为
    // pageUrl 恒有值而永远走不到 → 槽写了从来没人读，整套已删。
    const parsed = result.value
    if (parsed?.pageUrl) {
      params.set('parseUrl', parsed.pageUrl)
      // 线路和集数各带两份：序号是位置、名字是身份。源站增删线路或往中间插集之后
      // 序号就指到别处了，而分享链接的寿命以天计——播放器打开时先按名字认，序号兜底。
      if (parsed.activeLineIndex > 0) params.set('line', String(parsed.activeLineIndex))
      const lineName = currentLine.value?.name
      if (lineName) params.set('lineName', lineName)
      params.set('index', String(idx))
      if (names[idx]) params.set('ep', names[idx])
    } else {
      // 兜底：没有 pageUrl 就只能把地址本身带过去（按需取址的站点在这条路上没法工作——
      // 列表里是播放页占位地址，没有作业单谁也播不了。实际走不到这儿）
      params.set('urls', urls.join('|'))
      params.set('index', String(idx))
    }

    // 把「视频是从哪个站点解析出来的」当防盗链候选值带过去。
    // 这类站点的防盗链认的是播放页域名，而视频常挂在毫不相干的 CDN 上
    //（实测视频在 vod1.maowushi.com、防盗链认 aeete.com），播放器光看视频地址永远推不出来。
    //
    // 只是**候选值**，不是强制配置：播放器的可达性探测仍按 直连 → 代理·伪装 → 用这对头 → 主域
    // 的顺序逐级降级，直连能通就走直连，带上它不会平白多绕一层代理。
    //
    // 走 parseUrl 时播放器自己解析也会拿到这对头（applyHints），但**解析失败/超时那条路上没有**——
    // 那正是最需要它的时候（防盗链站点少了这对头就只剩探测硬碰）。带上不花钱，就带着。
    // 取值规则见 hintOrigin/hintReferer（与本页「可达性检测」共用同一对，差一点就等于测的是另一套配置）。
    if (hintReferer.value) params.set('referer', hintReferer.value)
    if (hintOrigin.value) params.set('origin', hintOrigin.value)

    openPlayer(params.toString())
  }

  return { reach, confirmOpen, playGuard, requestPlay, confirmPlay, hintOrigin, hintReferer }
}
