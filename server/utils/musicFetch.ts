/**
 * 音乐站抓取：**刻意不走代理**的那一份 fetch。
 *
 * ## 为什么不用 siteFetch.ts 的 fetchSitePage
 *
 * 那份会自动套上 `HTTPS_PROXY`（视频站多被 DNS 污染，本地开发非走代理不可）。
 * 但 24bit.net 挂在 Cloudflare 后面，**代理的出口 IP 会被判为可疑**，实测同一个请求：
 *
 *   直连   → 200，正常返回 JSON
 *   经代理 → 403 + `Just a moment...`（Cloudflare 人机校验页）
 *
 * 这和 CLAUDE.md 里「视频流跟着走代理常适得其反，出口 IP 一变很多 CDN 直接 403」是同一类，
 * 只是这次踩在抓页链路上。症状极具误导性：dev server 报 502，看着像我们的接口写坏了，
 * 而同一条命令在 shell 里跑却是 200 —— 差别只在环境变量。
 *
 * CF Pages 上没有 `HTTPS_PROXY`，本来就是直连，所以线上不受影响；
 * 这个文件真正解决的是**本地开发**下的不一致。
 *
 * 约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

export interface MusicFetchResult {
  status: number
  body: string
}

/**
 * 抓一次。**返回状态码而不是抛错**，让调用方自己决定 403/404 该怎么说
 * —— 这个站的 403 和 404 含义完全不同（前者是被 CF 拦，后者是没这首歌）。
 */
export async function musicFetch(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<MusicFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...init?.headers,
  }

  try {
    // 注意：这里**不传 dispatcher**，就是要走 Node 默认的直连出口
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      redirect: 'follow',
    })
    return { status: res.status, body: await res.text() }
  } catch (e) {
    // 裸 Error 会被 h3 归成 500 +「internal server error」，statusMessage 到不了前端。
    // 这个域名实测会间歇性连不上（同一请求前一次 200、后一次 ConnectTimeout 到 CF 的 IP），
    // 说清是「连不上」而不是「搜索坏了」，用户才知道该重试而不是来报 bug
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const detail = err.cause?.code || err.cause?.message || err.message
    throw createError({
      statusCode: 502,
      statusMessage: `连不上音乐站（${detail}）。这个域名偶发不可达，稍后重试`,
    })
  }
}

/**
 * 认出 Cloudflare 的人机校验页。
 *
 * 判据同 searchRule.ts 的 `isCloudflareChallenge`，但这里**不能只看状态码**：
 * 403 也可能是别的原因。带上这一层是为了把「代理出口被 CF 拦」这个本地开发专有的坑
 * 直接说成人话，否则排查时只能看到一句 `源站返回 403`。
 */
export function isCloudflareWall(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false
  return body.includes('Just a moment') || body.includes('challenges.cloudflare.com')
}

/** 撞上 CF 墙时统一的说法。本地开发最常见的原因就是 dev server 带了 HTTPS_PROXY */
export const CF_WALL_MESSAGE
  = '音乐站返回了人机校验页。本地开发时最常见的原因是 dev server 带了 HTTPS_PROXY —— '
    + '这个站必须直连，代理的出口 IP 会被 Cloudflare 拦。'
