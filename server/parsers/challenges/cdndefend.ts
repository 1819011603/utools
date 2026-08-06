/**
 * cdndefend 反爬：首访返回挑战页，要求暴力找 nonce 使
 * `SHA1(c + nonce)` 的第 n1、n1+1 字节等于 0xB0 0x0B（n1 = parseInt(c[0], 16)），
 * 再带 cookie `cdndefend_js_cookie = c + nonce` 重取。期望约 65536 次哈希。
 *
 * nonce 在浏览器算，不在这里算：CF Workers 免费版每请求只有 10ms CPU，
 * 服务端硬算必超；而挑战是纯 SHA1、不依赖 DOM 或浏览器指纹，放前端完全等价。
 * 这里只负责认出挑战页并把常量抠出来（见 composables/usePowSolver.ts）。
 */
import type { ChallengeHandler } from '../types'

export const cdndefendChallenge: ChallengeHandler = {
  kind: 'cdndefend',

  // 用页面内容判定而非状态码（站点用的是非标准的 850），改状态码时不会整个失效
  detect: body => body.includes('cdndefend_js_cookie'),

  build: (body) => {
    // 页面 JS 被混淆过，但挑战常量始终是其中唯一的 40 位大写十六进制串（SHA1 长度）
    const m = body.match(/['"]([0-9A-F]{40})['"]/)
    if (!m) return null
    const c = m[1]
    const n1 = Number.parseInt(c[0], 16)
    if (!Number.isFinite(n1)) return null
    // 目标字节是反混淆后固定写死的
    return { c, n1, target: [0xb0, 0x0b] }
  },

  toCookie: token => `cdndefend_js_cookie=${token}`,
}
