/**
 * 走本机常驻的 cookie-agent 中继（如果开着的话），绕开 Cloudflare Workers 的机房出口。
 *
 * ## 为什么要有这条路
 *
 * 24bit/fangpi 这两个站的人机校验，挡的是「是不是数据中心出口」这个特征——
 * 线上服务端转发（`/api/music/search` 等）天生长着这张脸，加请求头能改善概率但改不了本质
 * （CLAUDE.md「接新源前先做这个预检」那节写过这个结论）。而这个中继跑在用户自己家里，
 * 出口是真实的住宅 IP，从这条路发出去的请求跟用户自己打开浏览器访问源站没有区别。
 *
 * ## 纯粹是可选加速通道，不是必需品
 *
 * 中继没开、连不上、超时——任何一种情况都**立即返回 `null`**，调用方原样退回现在这条
 * 服务端转发的老路（`server/api/music/*.ts`）。没开中继的人（包括其他访客、线上大多数用户）
 * 用起来跟这个功能不存在一样，不受任何影响。
 *
 * ## 中继只服务当前这台机器
 *
 * 中继监听 `127.0.0.1`，只有跟它同一台机器上的浏览器才连得到——换一台设备、或者任何其他访客
 * 打开这个网站，这里都会直接连接失败（几乎瞬间，不是真的等超时），自动落回服务端那条路，
 * 不需要额外判断「这是不是我自己」。
 *
 * ## 中继不转发 Cookie
 *
 * 中继的转发白名单里没有 `Cookie`（保护中继自己所在电脑上的本地登录态不被转发给外站）。
 * 所以带了 24bit 登录态（`useMusic24bitAuth`）的请求**不该走这条路**——中继会把 Cookie
 * 静静地丢掉，用户会以为自己填的登录态生效了，实际上仍是匿名请求，配额照样按未登录算。
 * 调用方在有登录态时应该跳过这个函数，直接用服务端那条路（它支持透传 Cookie）。
 */

const RELAY_BASE = 'http://127.0.0.1:8765/api/v1/relay'
/** 连不上时应该几乎瞬间失败（ECONNREFUSED），给够冗余但别让没开中继的人白等 */
const RELAY_TIMEOUT_MS = 1500

export interface RelayResult {
  status: number
  body: string
}

/**
 * 经中继转发一次。**任何失败都吞掉、返回 `null`**——中继是可选项，
 * 一旦让它的异常冒泡出去，没开中继的用户（是多数）就会被这个可选功能拖累报错。
 */
export async function viaLocalRelay(
  targetUrl: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<RelayResult | null> {
  // SSR/构建阶段没有意义（中继只服务浏览器），本项目是纯 SPA 但双保险一下
  if (import.meta.server) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS)
  try {
    const res = await fetch(`${RELAY_BASE}?url=${encodeURIComponent(targetUrl)}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
      signal: ctrl.signal,
    })
    return { status: res.status, body: await res.text() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
