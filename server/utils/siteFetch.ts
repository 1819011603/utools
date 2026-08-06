/**
 * 服务端抓取网页用的 dispatcher（Node 专用，CF Workers 上自动降级为原生 fetch）
 *
 * 两件事：
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
