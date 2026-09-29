/**
 * 探测的底层 IO 与等待器（从 useReachabilityProbe.ts 下沉）：超时/对冲/预算常量、
 * 单 URL 可达性探测、按优先级收工的等待器、通道优先级。与「怎么组织两轴探测」分开。
 */
import type { AxisProbe, Channel, Reach } from '../useReachabilityProbe'

/** 代理对「已被官方下线的源」回这个码（451 Unavailable For Legal Reasons） */
export const SOURCE_GONE_STATUS = 451

export const DEFAULT_TIMEOUT = 8000     // 单条通道超时
export const OVERALL_TIMEOUT = 12000    // 整轮探测硬上限（探测阻塞起播，不能让多个超时叠加）
/**
 * 对冲延迟（**只用于分片轴**）：直连+伪装超过这么久还没结论，就把「代理·防盗链」也并发发出去，
 * 不干等前两条各自的 8s 超时。
 *
 * 清单轴不用它——那边已经改成三路同时发（见发起处的账目），一个等待期都没有。
 * 分片轴保留「先两路、必要时补第三路」是因为绝大多数源根本不校验防盗链，
 * 无脑并发探它只会白发一个必然失败的分片请求（实测 sintel 卡在这条上）。
 */
export const HEDGE_DELAY = 250
/**
 * 优先级预算：**从这根轴开始计时**，高优先级通道总共只有这么久的机会。
 * 预算烧完后，只要手上已经有可达通道，就按已有结论收工，不再等还在跑的那几条。
 *
 * 实测截图（分片轴）：`伪装 946ms ✓ / 直连 5637ms ✗`。两路本来就并发，可整根轴仍花了 5.6s
 * ——946ms 那一刻结论其实已经定了（最终就走伪装），后面 4.7s 全在干等一条注定失败的直连。
 *
 * 为什么不干脆「谁先 ok 就立刻收工」：直连慢一点但可用时（首次 TLS 握手、冷 DNS），
 * 按优先级它才是该选的那条——少一跳、不吃服务器出口流量、不受「代理出口 IP 被 CDN 拒」影响。
 *
 * **为什么是「从轴开始算的预算」而不是「从第一个 ok 之后再等一段」**：后者会和对冲窗口叠加，
 * 等于把机会给了同一条通道两次——`250(对冲) + 26(代理RTT) + 300(再等) = 576ms`，
 * 而直连实际拿到了 576ms 的窗口。改成总预算后同样这一轮只花 400ms，且语义只有一句话：
 * 「直连有 400ms，过时不候」。对冲仍然独立存在，它管的是**什么时候发**，不是**什么时候收工**。
 *
 * 收工后迟到的答案一律**不采纳**（那条通道留在 `'skip'` = 没等到，不是测过不通）；
 * 请求本身不去 abort，它自己会在 8s 超时里结束，只是没人要它的结果了。
 */
export const PRIORITY_BUDGET = 400
export const GRACE_TICK = 50            // 预算的检查粒度
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * 一根轴的等待器：带「优先级宽限」的收工判定。清单轴与分片轴共用一份实现——
 * 两边各写一遍必然漂移，而清单轴恰恰是漏掉它才留下「直连黑洞就白等 8s」那个洞。
 *
 * `wait(all, maxWait)` 在三种情况下返回：
 *  · all 全部落定 → 正常结束
 *  · 已有通道通 + 宽限烧完（或撞整轮截止）→ **收工**（settled=true，迟到的答案不再采纳）
 *  · 到了 maxWait（对冲窗口）→ 返回但**不收工**，让调用方去补下一条通道，在跑的照样能写进来
 */
export function makeAxisWaiter(expired: () => boolean, budgetMs: number) {
  const st = { settled: false, hasOk: false, since: performance.now() }
  return {
    st,
    noteOk: () => { st.hasOk = true },
    /** 补测阶段要重新开闸：收工过的等待器直接复用会把补测结果整个丢掉（=> 结论变 degraded）。
     *  预算也重新起算——那是新的一轮，凭什么用上一轮烧掉的额度 */
    reopen: () => { st.settled = false; st.hasOk = false; st.since = performance.now() },
    wait: async (all: Promise<unknown>, maxWait = Infinity) => {
      const t0 = performance.now()
      const done = all.then(() => true as const)
      while (true) {
        if (await Promise.race([done, sleep(GRACE_TICK).then(() => false as const)])) return
        if (expired()) { st.settled = true; return }
        // 已有可达通道 + 高优先级通道的预算烧完 → 收工。预算从本轴开始算（不与对冲窗口叠加），
        // budgetMs=0 即「首个可达通道就收工」
        if (st.hasOk && performance.now() - st.since >= budgetMs) { st.settled = true; return }
        if (performance.now() - t0 >= maxWait) return
      }
    },
  }
}
export const emptyAxis = (): AxisProbe => ({ direct: 'skip', disguise: 'skip', headers: 'skip', ms: {} })

// 「代理·防盗链」是倒数第二档：只有直连和伪装都没通才值得试。
// 绝大多数源站根本不校验防盗链，无脑并发探它只会白等一个 8s 超时尾巴（实测 sintel 就卡在这）。
export const needsHeadersChannel = (axis: AxisProbe): boolean => axis.direct !== 'ok' && axis.disguise !== 'ok'

// https 页面上的 http 地址 = mixed content，浏览器直接拦截。
// 提前短路判死：既省一个必然失败的请求，也少一条 console 报错。
export function isMixedContent(url: string): boolean {
  if (typeof location === 'undefined') return false
  return location.protocol === 'https:' && url.startsWith('http://')
}

/**
 * 探一个 URL 是否可达。只等响应头，拿到 status 立刻取消 body——分片有几百 KB，不能整片下下来。
 *
 * 关键：绝不能加 Range 头做「只取前几字节」。跨域带自定义头会触发 CORS 预检 OPTIONS，
 * 很多 CDN 不处理预检 → 探测假阴性；而真实的分片请求（useHlsPrefetch 里的 fetch）
 * 是不带任何自定义头的 simple request。探测必须与真实请求完全同形才有意义。
 */
export async function probeUrl(
  url: string, timeoutMs: number, signal?: AbortSignal,
): Promise<{ reach: Reach; ms: number; status?: number }> {
  if (isMixedContent(url)) return { reach: 'fail', ms: 0 }
  const t0 = performance.now()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
    void res.body?.cancel().catch(() => {})
    return { reach: res.ok ? 'ok' : 'fail', ms: Math.round(performance.now() - t0), status: res.status }
  } catch {
    // 超时 / 撞上整体截止 → unknown（没拿到答案，不能判死，否则慢源会被误判成要代理）；
    // CORS 拒绝 / 网络错误 / 证书问题 → fail
    return { reach: timedOut || signal?.aborted ? 'unknown' : 'fail', ms: Math.round(performance.now() - t0) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

// 按优先级取第一条可达通道（unknown 不算可达，但也不阻止后面的通道胜出）
export function pickChannel(axis: AxisProbe): Channel | null {
  for (const c of CHANNEL_ORDER) if (axis[c] === 'ok') return c
  return null
}
