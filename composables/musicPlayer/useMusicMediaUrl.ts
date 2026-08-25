/**
 * 决定音频地址「直连还是走代理」。
 *
 * ## 播放和下载的限制**完全不同**，这是本文件存在的全部理由
 *
 * 实测同一个地址（酷我 `kw-er.kuwo.cn`）：
 *
 *   `<audio src>` 直连        → 正常播放
 *   `fetch` + `Range` 直连    → `Failed to fetch`，114ms 就挂
 *   走 `/api/proxy`           → 206 `audio/x-flac`
 *
 * 差别不在网络，在 **CORS**：
 *   · `<audio>`/`<img>` 这类媒体元素加载**不受 CORS 约束**（前提是没加 `crossorigin`，
 *     我们特意没加），所以直连能播；
 *   · `fetch` 是跨域请求，而 `Range` **不是 CORS 安全头**、会触发预检，
 *     CDN 不在 `access-control-allow-headers` 里放行它，预检就挂了。
 *
 * 所以结论是不对称的，**别用一个判断糊住两件事**（我一开始就是这么写错的：
 * 拿 fetch 探测的结论去决定 `<audio>` 走哪条，等于让能直连的播放白白绕代理，
 * 20–110MB 一首全压到我们的出口上）：
 *
 *   播放 → 直连原地址，播不动了再退代理
 *   下载 → 默认走代理；只有探测确认直连可行的 host 才直连
 */

/** 按 host 记住 fetch 能不能直连（**只对下载有意义**，不能拿来判断能不能播） */
const fetchDirectOk = new Map<string, boolean>()
/** 同一个 host 的在途探测，避免连点几首时并发探同一个 CDN */
const probing = new Map<string, Promise<boolean>>()
/** 播放时被判定为「直连播不动」的 host，下次直接走代理 */
const playbackNeedsProxy = new Set<string>()

/** 探测超时。这是个 1 字节的请求，2 秒还没回来就当它不通 */
const PROBE_TIMEOUT_MS = 2000

const hostOf = (url: string) => {
  try { return new URL(url).host } catch { return '' }
}

/** 包成代理地址。`/api/proxy` 是项目现成的跨域/防盗链通道 */
export const toProxiedUrl = (url: string) =>
  url.startsWith('/api/proxy') ? url : `/api/proxy?url=${encodeURIComponent(url)}`

/**
 * 探一次这个 host 的**跨域 fetch** 能不能用（给下载判断）。
 * 只要 1 个字节 —— 目的是看 CORS 放不放行，不是量速度。
 */
async function probeFetch(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.status === 206 || res.status === 200
  } catch {
    return false
  }
}

export function useMusicMediaUrl() {
  /**
   * 播放用的地址。**默认原样直连** —— `<audio>` 不受 CORS 限制，
   * 绝大多数 CDN 都能直接播，没理由让几十上百 MB 白绕我们的出口。
   * 只有之前播失败过的 host 才预先走代理。
   */
  const toPlaybackUrl = (url: string): string => {
    const host = hostOf(url)
    return host && playbackNeedsProxy.has(host) ? toProxiedUrl(url) : url
  }

  /**
   * 播放失败了（地址还在有效期内却拉不动）→ 记下这个 host 并给出代理地址重试。
   * 返回 null 表示「已经是代理地址了」，那就不是直连的问题，别再套一层。
   */
  const demotePlayback = (url: string): string | null => {
    if (url.startsWith('/api/proxy')) return null
    const host = hostOf(url)
    if (host) playbackNeedsProxy.add(host)
    console.log(`[music] ${host} 直连播不动，改走代理`)
    return toProxiedUrl(url)
  }

  /**
   * 下载用的地址。**默认走代理**：跨域 fetch 要带 `Range`，而 `Range` 会触发预检，
   * 实测这些 CDN 不放行 —— 直接下必然 `Failed to fetch`。
   * 探测确认某个 host 的 CORS 确实放行时才直连（省我们的出口流量）。
   */
  const toDownloadUrl = async (url: string): Promise<string> => {
    const host = hostOf(url)
    if (!host) return toProxiedUrl(url)

    const known = fetchDirectOk.get(host)
    if (known !== undefined) return known ? url : toProxiedUrl(url)

    let job = probing.get(host)
    if (!job) {
      job = probeFetch(url).then((ok) => {
        fetchDirectOk.set(host, ok)
        probing.delete(host)
        console.log(`[music] ${host} 跨域下载${ok ? '可直连' : '被 CORS 拒，改走代理'}`)
        return ok
      })
      probing.set(host, job)
    }
    return (await job) ? url : toProxiedUrl(url)
  }

  return { toPlaybackUrl, demotePlayback, toDownloadUrl }
}
