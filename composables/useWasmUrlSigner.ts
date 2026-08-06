/**
 * 通用执行器：用站点自带的 wasm 现签接口地址，再从接口 JSON 里取真实播放地址。
 *
 * 这里不含任何站点专有逻辑——模块地址、函数名、每集实参、怎么从 JSON 里挑地址，
 * 全部由服务端下发的 WasmSignerTask 声明。接一个同类站点只要写服务端那半边。
 *
 * 我们只是原样加载并调用站点公开的导出函数，不改也不复刻它的算法，
 * 所以站点换签名方案时这里不用动，只要页面上还能读到模块地址就继续能用。
 */
import type { JsonUrlPick, ParsedEpisode, WasmSignerTask } from './videoParseRules'

/** wasm-bindgen 胶水模块：默认导出是初始化函数，其余按名字取 */
type WasmModule = {
  default: (opts: { module_or_path: ArrayBuffer }) => Promise<unknown>
} & Record<string, any>

// 同一份模块一个会话只加载一次；按 js 地址分键，地址带内容 hash，站点更新会自然失效
const moduleCache = new Map<string, Promise<WasmModule>>()

// 逐集取址的并发。太高会被源站限流，也没必要——瓶颈在源站不在本地
const CONCURRENCY = 5

const proxied = (url: string) => `/api/proxy?url=${encodeURIComponent(url)}`

/**
 * 有些 wasm 会读页面上某个 <meta> 的 content 当时间戳（站点原页面由内联脚本写入）。
 * 我们的页面没有这个元素，得自己补一个；且每次签名前都要刷新成当前时刻，
 * 否则整批签名共用一个旧时间戳，后面几集必然签出过期地址。
 */
function touchTimestampMeta(id: string) {
  let el = document.getElementById(id) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.id = id
    document.head.appendChild(el)
  }
  el.content = String(Date.now())
}

async function loadModule(task: WasmSignerTask): Promise<WasmModule> {
  const cached = moduleCache.get(task.moduleUrl)
  if (cached) return cached

  const task2 = (async () => {
    // 胶水 js 走 blob 再 import，而不是直接 import 代理地址：
    // 动态 import 会按响应的 MIME 校验，源站给的 content-type 不一定原样过得来，
    // 包成 blob 就由我们自己定 MIME，稳。
    const jsText = await fetch(proxied(task.moduleUrl)).then(r => {
      if (!r.ok) throw new Error(`签名模块加载失败 (${r.status})`)
      return r.text()
    })
    const blobUrl = URL.createObjectURL(new Blob([jsText], { type: 'text/javascript' }))
    try {
      const mod = (await import(/* @vite-ignore */ blobUrl)) as WasmModule
      // 传字节而不是地址：让胶水走 WebAssembly.instantiate(bytes)，
      // 免得 instantiateStreaming 因为代理回来的 content-type 不是 application/wasm 而失败
      const bytes = await fetch(proxied(task.wasmUrl)).then(r => {
        if (!r.ok) throw new Error(`签名模块加载失败 (${r.status})`)
        return r.arrayBuffer()
      })
      await mod.default({ module_or_path: bytes })
      if (typeof mod[task.fn] !== 'function') {
        throw new Error(`签名模块没有导出 ${task.fn}()，站点可能已改版`)
      }
      return mod
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  })()

  moduleCache.set(task.moduleUrl, task2)
  task2.catch(() => moduleCache.delete(task.moduleUrl))   // 失败别把坏结果钉死在缓存里
  return task2
}

function dig(obj: any, path?: string): any {
  if (!path) return obj
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
}

/** 按声明从接口 JSON 里挑一条能播的地址 */
export function pickUrlFromJson(json: any, pick: JsonUrlPick): string | undefined {
  const list = dig(json, pick.listPath)
  if (!Array.isArray(list)) return undefined
  return list
    .filter(item => {
      if (pick.skipFlags?.some(f => item?.[f])) return false
      const u = item?.[pick.urlKey]
      // 被锁的档位常把 url 渲染成 "1" 这类占位值，必须按协议头筛掉
      return typeof u === 'string' && /^https?:\/\//i.test(u)
    })
    .sort((a, b) => (pick.rankKey ? (Number(b?.[pick.rankKey]) || 0) - (Number(a?.[pick.rankKey]) || 0) : 0))[0]?.[pick.urlKey]
}

export interface WasmSignerOptions {
  /** 已完成 / 总数 */
  onProgress?: (done: number, total: number) => void
  onStage?: (text: string) => void
}

/**
 * 就地把 episodes 的 videoUrl 补齐（下标与 task.argsList 严格一一对应）。
 * 单集失败只记 error，不影响其余——长剧里偶发限流很正常。
 */
export async function runWasmUrlSigner(
  task: WasmSignerTask,
  episodes: ParsedEpisode[],
  opts: WasmSignerOptions = {},
) {
  const total = task.argsList.length
  if (!total) return

  opts.onStage?.('正在加载站点签名模块…')
  const mod = await loadModule(task)
  const sign = mod[task.fn] as (...args: string[]) => string

  let done = 0
  let cursor = 0

  const worker = async () => {
    while (true) {
      const i = cursor++
      if (i >= total) return
      const ep = episodes[i]
      if (!ep) continue
      try {
        // 现签现用：签名带时间戳，提前批量签会过期
        if (task.timestampMetaId) touchTimestampMeta(task.timestampMetaId)
        const api = new URL(sign(...task.argsList[i]), task.base).href
        // 逐发打 /api/proxy：每发都是独立的 Worker 调用，
        // 天然绕开「单请求 50 subrequest」的硬顶，所以这条路子不用分批
        const res = await fetch(proxied(api))
        if (!res.ok) throw new Error(`接口 ${res.status}`)
        const json = await res.json()
        const url = pickUrlFromJson(json, task.pick)
        if (url) ep.videoUrl = url
        else ep.error = String(dig(json, task.pick.messagePath) || '') || '未取到可播地址'
      } catch (e: any) {
        ep.error = e?.message || '请求失败'
      }
      opts.onProgress?.(++done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
}
