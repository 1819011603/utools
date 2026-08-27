/**
 * 服务端抓网页：一个带 UA/cookie 的 fetchSitePage，外加它底下那个 dispatcher。
 *
 * 解析（resolve.ts）和搜索（search.ts）抓的是同一批源站、要的是同一套行为
 * （同一个 UA 粗筛、同一个 dispatcher、非标准状态码不能被当错误吞掉、连不上时要给出
 * 「本地没设 HTTPS_PROXY」这条最常见的线索），各写一份必然漂移。
 *
 * dispatcher（Node 专用，CF Workers 上自动降级为原生 fetch）做两件事：
 *   1. 放宽 TLS 校验 —— 不少源站证书链不全/过期，Node 默认会直接拒连
 *   2. 支持 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY —— 本地开发时常见的情况是
 *      目标站点被 DNS 污染或需要代理才能访问，而浏览器/PowerShell 走系统代理、
 *      Node 默认不走，于是「浏览器能开、接口 fetch failed」。设个环境变量即可对齐。
 *      CF Pages 上没有这些变量，出口直连，天然不受影响。
 *
 * 注意：proxy.ts 里有一份职责相近的 dispatcher（面向视频流，连接数/超时都按分片下载调过），
 * 那条链路已针对播放场景调优，这里不去动它；本文件只服务于网页抓取。
 *
 * 约束同 proxy.ts：不静态 import 任何 node:*，specifier 用变量 + @vite-ignore 包住，
 * 否则 Vite 会在 CF 构建时静态解析报错。
 */

import type { FetchedPage } from '../parsers/types'
import { hostOf, isCloudflareChallenge } from '../parsers/utils'

// 源站普遍按 UA 做粗筛，与 proxy.ts:63 保持一致
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

let _dispatcher: any = undefined
let _checked = false

function readProxyEnv(): string | undefined {
  // @ts-ignore CF Workers 上没有 process
  const env = globalThis.process?.env ?? {}
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
}

export async function getSiteDispatcher(): Promise<any> {
  if (_checked) return _dispatcher
  _checked = true

  // @ts-ignore CF Workers 没有 process
  if (typeof globalThis.process === 'undefined' || !globalThis.process?.versions?.node) return undefined

  try {
    const spec = 'undici'
    const undici = await import(/* @vite-ignore */ spec)
    const proxyUri = readProxyEnv()

    if (proxyUri && undici?.ProxyAgent) {
      _dispatcher = new undici.ProxyAgent({
        uri: proxyUri,
        connect: { rejectUnauthorized: false, timeout: 15000 },
        bodyTimeout: 60000,
        headersTimeout: 60000,
      })
      console.log('[siteFetch] 走代理抓取：' + proxyUri)
    } else if (undici?.Agent) {
      _dispatcher = new undici.Agent({
        connect: { rejectUnauthorized: false, timeout: 15000 },
        bodyTimeout: 60000,
        headersTimeout: 60000,
      })
    }
  } catch {
    // 加载失败就降级为原生 fetch
  }
  return _dispatcher
}

/**
 * Cloudflare 人机校验的重试次数（额外几发，不含第一发）。
 *
 * 由来：有的站点的校验**不是常开的，而是按出口 IP 的信誉分现算的**——实测 jable.tv
 * 的 `/videos/`：低频访问时连打 10 次是 `403 200 200 200 200 200 200 200 200 200`，
 * 冷的那一发被挑战、紧接着的几发全过，所以重发就能救。
 *
 * 不重试的代价是「解析十次坏三次」这种最难查的间歇故障：用户看到的只是一句
 * 「源站返回 403」，刷新一下又好了，只会以为规则写坏了（**踩过**：接 jable 时第一发就是它）。
 *
 * **但重试救不了信誉分被打没的情况，而那正是「排查」本身会造成的**：接 jable 时几分钟内
 * 往 `/videos/` 打了三十来发探测，之后同一个出口 IP 上**连 curl 都恒 403**，重几次都一样。
 * 也就是说这条路径上「403 变成常态」的第一嫌疑人是**自己刚才探得太狠**，不是指纹、不是
 * 请求头、也不是 HTTP 版本 —— 那三个都排查过：换完整 Chrome UA、带/不带 cookie、
 * undici 开 `allowH2`、curl 强制 `--http1.1`，四组结果与对照组逐一相同。
 * 所以**排查这类站点必须低频**（几秒一发、总数十几发以内），否则会把唯一的判据毁掉。
 *
 * 定在 3 发是因为常开校验的站点（实测 kpkuang 的 `/vodsearch/`，那条路已绕开）
 * 无论重几次都不会过，多试只是白等 —— 够救间歇型，又不至于在死路上耗太久。
 */
const CF_RETRIES = 3
const CF_RETRY_DELAY_MS = [400, 900, 1600]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 抓一个源站页面。**返回状态码而不是抛错**：反爬挑战页用的是非标准状态码
 * （实测 cdndefend 回 850），调用方要拿 body 里的挑战常量，交给 ofetch 会被直接当错误吞掉。
 *
 * 撞上 Cloudflare 人机校验时会自动重发几次（见 CF_RETRIES）。重试收在这一层而不是
 * resolve.ts 里，是因为吃这一发的地方不止解析首页：按需取址的逐集取址（`?only=1`）、
 * 搜索、补封面走的都是这个函数，各写一份必然漂移，漏掉哪个就是那条路上的间歇故障。
 */
export async function fetchSitePage(
  url: string,
  cookie?: string,
  /** 额外请求头。有的接口靠 Referer 认「请求来自站点页面」，不带就恒回空结果 */
  extra?: Record<string, string>,
): Promise<FetchedPage> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extra,
  }
  if (cookie) headers['Cookie'] = cookie

  const dispatcher = await getSiteDispatcher()
  const opts: RequestInit & { dispatcher?: any } = { headers, redirect: 'follow' }
  if (dispatcher) opts.dispatcher = dispatcher

  try {
    let res = await fetch(url, opts as RequestInit)
    // 有的站点只在响应头上留标记（Cloudflare 的 cf-mitigated: challenge），body 里看不出来。
    // body 只能读一次，所以判据要在读之前用响应头先过一遍，读完再用文本兜底
    let body = await res.text()
    for (let i = 0; i < CF_RETRIES && isCloudflareChallenge(res.status, body, res.headers); i++) {
      console.log(`[siteFetch] ${hostOf(url)} 撞上 Cloudflare 人机校验，第 ${i + 1} 次重发`)
      await sleep(CF_RETRY_DELAY_MS[i] ?? 900)
      res = await fetch(url, opts as RequestInit)
      body = await res.text()
    }
    return { status: res.status, body, headers: res.headers }
  } catch (e) {
    // 原始报错只有一句 "fetch failed"，根本没法排查，把 cause 带出来。
    // 必须用 createError 而不是裸 Error：裸 Error 会被 h3 归成 500 +「internal server error」，
    // statusMessage 到不了前端，界面上只剩一句 Internal Server Error，等于什么都没说。
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const code = err.cause?.code || ''
    const detail = code || err.cause?.message || err.message
    // 连不上/超时/DNS 失败，本地开发最常见的原因就是 Node 不走系统代理（见 CLAUDE.md「本地开发注意」）
    const unreachable = /TIMEOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|CERT/i.test(detail)
    throw createError({
      statusCode: 502,
      statusMessage: unreachable
        ? `服务端连不上 ${hostOf(url)}（${detail}）。本地开发请先设 HTTPS_PROXY 再起 dev；线上则是源站不可达`
        : `抓取失败：${detail}`,
    })
  }
}
