/**
 * 地址栏双向同步：`/video-player?url=xxx` 打开即播，播放中的列表/集数又写回地址栏，
 * 让地址栏本身就是一条可分享的直链。
 *
 * 支持的参数：
 *   url            视频地址，可重复传多个组成播放列表（?url=a&url=b）
 *   urls           一次传多个，用 | 或换行分隔
 *   index          起播第几个（0 基）
 *   origin/referer 注入的防盗链头；proxy=1 全程代理；noref=1 伪装下载器；manifestOnly=0/1
 *   parseUrl/line  源站播放页地址 + 线路，列表由播放器自己解析（解析来的列表首选这个）
 *   t              起播秒数。**只入不出**：它是「这一次从哪儿接着看」的一次性指令，
 *                  写回地址栏的话，刷新一次就又被拽回那个位置（正常刷新该接着当前进度走）
 *
 *   handoff=1      历史键，交接槽已删除 → 认得出但忽略（留着只为别被当成视频地址的尾巴）
 */
import type { QueryVideoParams } from './types'
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoHandoff } from './useVideoHandoff'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'

export interface VideoDeepLinkDeps {
  media: VideoMediaState
  conn: VideoConnStrategy
  handoff: VideoHandoff
  playlist: VideoPlaylistCtl
}

export function useVideoDeepLink(deps: VideoDeepLinkDeps) {
  const { media, conn, handoff, playlist } = deps

  /**
   * 从原始 `window.location.search` 手工解析。
   *
   * 关键坑：视频地址自带 query（`?token=1&sign=2`）时，未编码的 `&` 会被路由拆成独立参数，
   * 直接读 `route.query.url` 只能拿到 `sign` 之前的部分。所以凡「不是本页已知参数」的片段，
   * 一律原样回写进最近的那个视频地址。
   */
  const parseQueryVideoParams = (): QueryVideoParams => {
    const result: QueryVideoParams = { urls: [] }
    const raw = (typeof window === 'undefined' ? '' : window.location.search).replace(/^\?/, '')
    if (!raw) return result

    // 只做 percent 解码，不把 + 当空格：视频签名里常有裸 + 号，转成空格会直接 403
    const dec = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }
    const isTrue = (v: string) => v === '' || v === '1' || v.toLowerCase() === 'true'
    const appendToLastUrl = (part: string) => {
      const i = result.urls.length - 1
      if (i < 0) return
      result.urls[i] += (result.urls[i].includes('?') ? '&' : '?') + part
    }

    for (const part of raw.split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      const key = eq === -1 ? part : part.slice(0, eq)
      const val = eq === -1 ? '' : part.slice(eq + 1)

      if (!PAGE_QUERY_KEYS.has(key)) {
        appendToLastUrl(part)
        continue
      }

      switch (key) {
        case 'url': {
          const u = dec(val).trim()
          if (u) result.urls.push(u)
          break
        }
        case 'urls':
          dec(val).split(/[\n\r|]+/).map(s => s.trim()).filter(Boolean)
            .forEach(u => result.urls.push(u))
          break
        case 'index': {
          const n = Number.parseInt(dec(val), 10)
          if (Number.isFinite(n)) result.index = n
          break
        }
        case 'parseUrl': result.parseUrl = dec(val).trim(); break
        case 'lineName': result.lineName = dec(val).trim(); break
        case 'ep': result.ep = dec(val).trim(); break
        case 't': {
          // 秒数可能带小数（进度就是个浮点数），用 parseFloat 不是 parseInt
          const n = Number.parseFloat(dec(val))
          if (Number.isFinite(n) && n > 0) result.t = n
          break
        }
        case 'line': {
          const n = Number.parseInt(dec(val), 10)
          if (Number.isFinite(n) && n >= 0) result.line = n
          break
        }
        case 'origin': result.origin = dec(val).trim(); break
        case 'referer': result.referer = dec(val).trim(); break
        case 'proxy': result.proxy = isTrue(val); break
        case 'noref': result.noref = isTrue(val); break
        case 'manifestOnly': result.manifestOnly = isTrue(val); break
        // handoff=1 是交接槽时代的标记，现在认得出但什么都不做（见 PAGE_QUERY_KEYS 的注释）：
        // 老书签打开时列表由下面的 savedState 恢复，比读一份过期的槽更靠谱
      }
    }

    return result
  }

  /**
   * 反向同步：把当前播放列表/集数写回地址栏。
   *
   * 用原生 `history.replaceState` 而非 `router.replace`：本页只从 `window.location.search`
   * 读参数，不经 vue-router，避免 query 变化触发路由重解析；replace 也不污染后退栈。
   */
  const syncUrlToQuery = () => {
    if (typeof window === 'undefined') return

    const urls = playlist.playlist.value
    // 只有网络地址能用链接表达（放行 //host/path，parseAndLoad 也接受这种协议相对写法）
    const shareable = urls.length > 0 && urls.every(u => /^(https?:)?\/\//i.test(u))
    const parts: string[] = []
    const idx = Math.min(Math.max(playlist.currentIndex.value, 0), Math.max(urls.length - 1, 0))

    // ── 解析来的列表：只写「从哪解析的 + 哪条线路 + 第几集」 ──
    // 这是唯一能分享出去的形式。列表本身不写进地址栏：几十集顶爆长度上限，
    // 而且解析出的地址不少带时效签名，隔几小时分享出去就是一堆死链；
    // 换成来源则链接短、永不过期，别人打开自动解析到同一线路同一集。
    const src = handoff.playlistSource.value
    if (src?.pageUrl && urls.length) {
      const q = ['parseUrl=' + encodeURIComponent(src.pageUrl)]
      // 线路和集数各写两份：序号是位置、名字是身份。源站增删线路或往中间插集之后
      // 序号就指到别处去了，而链接是拿来分享的、寿命以天计——打开时先按名字认。
      // index 恒写（哪怕是 0）：用户要能从链接上一眼看出这是第几集。
      if (src.line > 0) q.push('line=' + src.line)
      if (src.lineName) q.push('lineName=' + encodeURIComponent(src.lineName))
      q.push('index=' + idx)
      const epName = handoff.playlistNames.value[urls[idx]]
      if (epName) q.push('ep=' + encodeURIComponent(epName))
      const search = '?' + q.join('&')
      if (window.location.search !== search) {
        window.history.replaceState(window.history.state, '', window.location.pathname + search + window.location.hash)
      }
      return
    }

    if (shareable) {
      // 多个地址用 urls=a|b 而不是重复 url=，省地址栏长度
      parts.push(urls.length === 1
        ? 'url=' + encodeURIComponent(urls[0])
        : 'urls=' + urls.map(u => encodeURIComponent(u)).join('|'))
      if (playlist.currentIndex.value > 0) parts.push('index=' + playlist.currentIndex.value)
      // 连接策略一概不写进地址栏：它全部由可达性探测实时决定，固化成参数只会把中间态带走，
      // 下次打开反而绕远（探测能自己得出结论，不需要链接告诉它怎么连）。
      // 入向仍认 origin/referer（当候选值），只是不再由本页产出。
    }

    let search = parts.length ? '?' + parts.join('&') : ''
    /**
     * 手工贴的长列表（几十条地址）会把地址栏顶爆——部分浏览器 2000 字符上界——
     * 所以**干脆什么都不写**。
     *
     * 这里原来是「转存 localStorage 交接槽 + 只留 `?handoff=1`」，为的是刷新还能把整份列表读回来
     *（query 的优先级高于 savedState，早先退化成只带当前一集就等于刷新即丢列表）。
     * 那套已经删了：`video-player-state` 本来就存着完整的 playlist + currentIndex + 作业单，
     * 而地址栏空着的时候 mount() 走的正是「恢复 savedState」那条分支，效果完全一样。
     * `?handoff=1` 唯一的额外能力是「刷新后地址栏还长得像条直链」，但它**本来就分享不出去**
     *（槽在本机 localStorage 里，别人打开一片空白），不值得为它留一整套读写 + 过期逻辑。
     *
     * 解析来的列表不走这里（上面 parseUrl 那段已经 return），按需取址的列表也一样。
     */
    if (search.length > 2000) search = ''

    if (window.location.search === search) return
    window.history.replaceState(window.history.state, '', window.location.pathname + search + window.location.hash)
  }

  // 复制当前直链：地址栏已被 syncUrlToQuery 同步成直链，直接取 location.href
  const deepLinkCopied = ref(false)
  const copyDeepLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      deepLinkCopied.value = true
      setTimeout(() => { deepLinkCopied.value = false }, 1500)
    } catch {
      media.errorMessage.value = '复制失败，请手动复制地址栏'
    }
  }

  /**
   * 回解析页并带上本次的来源（源站播放页 + 线路序号），落地即可换线路/换集。
   *
   * 播放器里换不了线路——它手上只有一条线路解析出来的列表。而「这条线路卡/没这一集」
   * 是最常见的下一步动作，只能回解析页。带参数过去解析页会命中它自己的结果缓存（1 小时），
   * 多数时候一个请求都不发就把线路表摆出来。
   */
  const backToParseSource = () => {
    const src = handoff.playlistSource.value
    if (!src?.pageUrl) return
    const q = new URLSearchParams({ url: src.pageUrl })
    if (src.line) q.set('line', String(src.line))
    return navigateTo(`/video-parse?${q.toString()}`)
  }

  /**
   * 当前这一集在源站的播放页（`https://4kvm.org/play/ch4fj1bv7` 这种），供「去源站看」用。
   *
   * 两种精度，UI 要如实说清楚是哪一种（说成「当前集」却跳到第 1 集比不给这颗按钮更糟）：
   *   · 按需取址的列表里存的**就是**源站播放页占位地址 → 天然精确到当前集；
   *   · 其余列表只知道「从哪一页解析来的」，那是解析入口那一集。
   *
   * 判据用 `lazyIndexByUrl` 而不是 `lazyTask`：它按 URL 存、与列表天然对齐，
   * 列表被整份替换（刷新链接）时也不会把真实 m3u8 地址错当成播放页。
   */
  const currentSourceLink = computed(() => {
    const cur = playlist.playlist.value[playlist.currentIndex.value]
    if (cur && handoff.lazyIndexByUrl.value[cur] !== undefined) return { url: cur, exact: true }
    return { url: handoff.playlistSource.value?.pageUrl ?? '', exact: false }
  })

  return {
    backToParseSource, currentSourceLink,
    parseQueryVideoParams, syncUrlToQuery, copyDeepLink, deepLinkCopied }
}

export type VideoDeepLink = ReturnType<typeof useVideoDeepLink>
