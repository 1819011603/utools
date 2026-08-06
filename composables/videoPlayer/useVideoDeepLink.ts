/**
 * 地址栏双向同步：`/video-player?url=xxx` 打开即播，播放中的列表/集数/手动策略又写回地址栏，
 * 让地址栏本身就是一条可分享的直链。
 *
 * 支持的参数：
 *   url            视频地址，可重复传多个组成播放列表（?url=a&url=b）
 *   urls           一次传多个，用 | 或换行分隔
 *   index          起播第几个（0 基）
 *   origin/referer 注入的防盗链头；proxy=1 全程代理；noref=1 伪装下载器；manifestOnly=0/1
 *   handoff=1      列表在 localStorage 交接槽里，query 只留标记
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
        case 'origin': result.origin = dec(val).trim(); break
        case 'referer': result.referer = dec(val).trim(); break
        case 'proxy': result.proxy = isTrue(val); break
        case 'noref': result.noref = isTrue(val); break
        case 'manifestOnly': result.manifestOnly = isTrue(val); break
        case 'handoff': {
          if (!isTrue(val)) break
          const p = handoff.readHandoff()
          if (!p) break
          p.urls.forEach(u => result.urls.push(u))
          handoff.applyHandoffMeta(p)
          // ?index= 若显式给了以它为准，所以只在没给时才用槽里的
          if (result.index === undefined && Number.isFinite(p.index)) result.index = p.index
          break
        }
      }
    }

    // 短列表是用 urls= 传的（那样的链接能直接分享），集名则始终放在交接槽里。
    // 两边内容完全一致时才采用，避免把别的列表的名字套上来。
    if (result.urls.length) {
      const p = handoff.readHandoff()
      if (p && p.urls.length === result.urls.length && p.urls.every((u, i) => u === result.urls[i])) {
        handoff.applyHandoffMeta(p)
      }
    }

    return result
  }

  /**
   * 反向同步：把当前播放列表/集数/手动策略写回地址栏。
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

    if (shareable) {
      // 多个地址用 urls=a|b 而不是重复 url=，省地址栏长度
      parts.push(urls.length === 1
        ? 'url=' + encodeURIComponent(urls[0])
        : 'urls=' + urls.map(u => encodeURIComponent(u)).join('|'))
      if (playlist.currentIndex.value > 0) parts.push('index=' + playlist.currentIndex.value)
      // 只写手动策略：自动探测是引擎实时试探的，写进地址栏会把中间态固化，下次进来反而绕远
      if (conn.manualStrategyOverride.value) {
        if (conn.requestOrigin.value.trim()) parts.push('origin=' + encodeURIComponent(conn.requestOrigin.value.trim()))
        if (conn.requestReferer.value.trim()) parts.push('referer=' + encodeURIComponent(conn.requestReferer.value.trim()))
        if (conn.useProxy.value) parts.push('proxy=1')
        if (conn.disguiseAsDownloader.value) parts.push('noref=1')
        parts.push('manifestOnly=' + (conn.manifestOnly.value ? '1' : '0'))
      }
    }

    let search = parts.length ? '?' + parts.join('&') : ''
    // 长播放列表会把地址栏顶爆（部分浏览器 2000 字符上界）→ 转存交接槽，query 里只留标记。
    // 早先这里是退化成只带当前一集，代价是刷新后整个列表就没了（query 优先级高于 savedState）；
    // 走交接槽则刷新也能把几十集完整读回来。
    //
    // 按需取址的列表无论多短也必须走交接槽：urls= 里是源站播放页地址占位，
    // 光有它没有作业单谁也播不了，分享出去只会得到一堆打不开的链接。
    if ((search.length > 2000 || handoff.lazyTask.value) && shareable) {
      const idx = Math.min(Math.max(playlist.currentIndex.value, 0), urls.length - 1)
      handoff.writeHandoff(urls, idx)
      search = '?handoff=1'
    }

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

  return { parseQueryVideoParams, syncUrlToQuery, copyDeepLink, deepLinkCopied }
}

export type VideoDeepLink = ReturnType<typeof useVideoDeepLink>
