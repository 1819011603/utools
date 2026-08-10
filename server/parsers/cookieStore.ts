/**
 * 反爬 cookie 的按 host 缓存（解析与搜索共用）。
 *
 * 实测同一站点不同页面拿到的挑战常量完全相同，且数分钟内稳定，所以一次工作量证明可全站复用。
 * 放在共享模块而不是各接口自己留一份的理由：**搜索时算过的 PoW，点进解析页要能直接用上**
 * ——否则同一个站点在同一分钟里会被要求算两遍（每遍约 6.5 万次 SHA1）。
 *
 * TTL 与 proxy.ts 的 headerModeCache、htmlRule 的 playerCache 对齐（30 分钟）。
 */
const cookieCache = new Map<string, { cookie: string; at: number }>()
const COOKIE_TTL = 30 * 60 * 1000

export function readCookie(host: string): string | undefined {
  const hit = cookieCache.get(host)
  if (!hit) return undefined
  if (Date.now() - hit.at > COOKIE_TTL) {
    cookieCache.delete(host)
    return undefined
  }
  return hit.cookie
}

export function saveCookie(host: string, cookie: string) {
  cookieCache.set(host, { cookie, at: Date.now() })
}

export function dropCookie(host: string) {
  cookieCache.delete(host)
}
