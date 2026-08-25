/**
 * 会话令牌与几个 WebCrypto 小工具。
 *
 * ## 为什么口令的拉伸不在这里
 *
 * **CF Workers 免费版每请求只有 10ms CPU**，而一次像样的 PBKDF2（十万量级迭代）要几十到上百毫秒
 * ——服务端做不了。所以拉伸放在前端（`composables/useUserAuth.ts`），服务端只对前端送上来的
 * 派生结果做**一次** SHA-256 存盘。这不是偷懒：同一个理由下项目里的 PoW 也是放前端算的
 * （见 `composables/usePowSolver.ts`）。攻击者要暴力破解仍然得逐个候选口令跑那十几万次迭代，
 * 拉伸的成本并没有消失，只是从我们的 CPU 预算里搬到了猜测方那边。
 *
 * ## 令牌
 *
 * `v1.<base64url(载荷)>.<base64url(HMAC-SHA256)>`，载荷是 `{u: uid, e: 过期毫秒}`。
 * 验一次 = 1 次 HMAC，CPU 可忽略。不用 JWT 库：格式自己定的话没有「alg: none」那类历史包袱，
 * 而我们只需要「服务端签、服务端验」这一种用法。
 *
 * **密钥缺失时一律报 503，绝不退回硬编码默认值**：那等于任何人都能伪造任意 uid 的令牌，
 * 而且这种「能用，只是不安全」的状态没有任何症状，上线一年都不会有人发现。
 * 唯一的例外是本地开发 —— 判据是 `globalThis.process` 存在（CF Workers 上没有 process，
 * 所以线上永远走不到那条分支，见 `siteFetch.ts:36` 同样的写法）。
 */
import type { H3Event } from 'h3'

const enc = new TextEncoder()

/** 60 天。够长（不至于隔三差五重登），又不至于一个泄露的令牌永久有效 */
const TOKEN_TTL_MS = 60 * 24 * 3600_000

const DEV_SECRET = 'utools-dev-only-insecure-secret'
let devWarned = false

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)))
}

/**
 * 定长比较。密码/令牌的比对不用 `===`：字符串比较会在第一个不同的字符上返回，
 * 逐字节试探理论上能把「猜对前缀」变成可观测的时间差。
 * 长度不同直接判否（长度本身不是秘密）。
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const b64u = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 读签名密钥。CF Pages 上走环境变量（`wrangler pages secret put USER_TOKEN_SECRET`），
 * 本地开发退回一个固定的 dev 密钥并在控制台喊一声。返回空串 = 没配，调用方必须报 503。
 */
export function readSecret(event: H3Event): string {
  const env = (event.context as any)?.cloudflare?.env ?? {}
  const s = env.USER_TOKEN_SECRET || (globalThis as any).process?.env?.USER_TOKEN_SECRET
  if (s) return String(s)
  // CF Workers 上没有 process，所以这条兜底只可能在本地 Node 里命中
  if ((globalThis as any).process?.env) {
    if (!devWarned) {
      devWarned = true
      console.warn('[user] 没有 USER_TOKEN_SECRET，本地开发退回固定 dev 密钥；上线前务必 wrangler pages secret put')
    }
    return DEV_SECRET
  }
  return ''
}

/** 拿不到密钥时统一的报错：说清是「没配」而不是「你的账号有问题」 */
export function requireSecret(event: H3Event): string {
  const secret = readSecret(event)
  if (!secret) {
    throw createError({ statusCode: 503, statusMessage: '服务端没有配置 USER_TOKEN_SECRET，账号功能暂不可用' })
  }
  return secret
}

export async function signToken(uid: string, secret: string): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({ u: uid, e: Date.now() + TOKEN_TTL_MS })))
  const sig = await hmacHex(secret, payload)
  return `v1.${payload}.${sig}`
}

/** 验签 + 查过期。任何一步不对都返回 null，不区分原因（区分了就是在教攻击者怎么试） */
export async function verifyToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, payload, sig] = parts
  if (!safeEqual(sig!, await hmacHex(secret, payload!))) return null
  try {
    const t = payload!.replace(/-/g, '+').replace(/_/g, '/')
    const body = JSON.parse(atob(t + '='.repeat((4 - t.length % 4) % 4)))
    if (!body?.u || typeof body.e !== 'number' || body.e < Date.now()) return null
    return String(body.u)
  } catch { return null }
}

/** 从 `Authorization: Bearer` 取出并验证 uid。失败一律 401（前端据此清掉本地令牌） */
export async function requireUid(event: H3Event): Promise<string> {
  const secret = requireSecret(event)
  const raw = getRequestHeader(event, 'authorization') || ''
  const uid = raw.startsWith('Bearer ') ? await verifyToken(raw.slice(7).trim(), secret) : null
  if (!uid) throw createError({ statusCode: 401, statusMessage: '登录已失效，请重新登录' })
  return uid
}
