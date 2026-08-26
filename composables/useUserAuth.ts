/**
 * 账号：注册 / 登录 / 退出，以及带令牌的请求。
 *
 * ## 口令拉伸在**前端**做
 *
 * **CF Workers 免费版每请求只有 10ms CPU**，而十几万次迭代的 PBKDF2 要几十到上百毫秒
 * ——服务端做不了。所以这里算 `PBKDF2(口令, 盐, 12 万次)`，只把派生结果的 hex 发上去，
 * 服务端对它做一次 SHA-256 存盘。同一个理由下项目里的 PoW 也是放前端算的（`usePowSolver.ts`）。
 *
 * 这**不是**「把安全性交给客户端」：拉伸的意义是让每次猜测都很贵，而猜测方无论在哪一端
 * 都得自己跑完那十几万次。服务端存的是派生结果的哈希，库被拖走也直接反推不出口令。
 * 真正的代价是「明文口令仍然要经过网络」（靠 HTTPS 兜），以及**登录要等一秒多**——
 * 所以按钮必须有 loading，否则用户会以为没点上、连点几下。
 *
 * ## 状态是模块级单例
 *
 * header 里的按钮和登录弹窗是两个组件、各调一次 `useUserAuth()`。各持一份状态的话
 * 「登录成功了但按钮还显示未登录」，要刷新页面才对。
 *
 * 令牌存 localStorage（不是 httpOnly cookie）：这是个 `ssr: false` 的纯前端站，
 * 所有请求都由脚本发出，cookie 的 XSS 防护在这种形态下拿不到多少好处，而 localStorage
 * 免掉了跨站 cookie 的一堆麻烦。令牌只能读写这一个账号自己的清单，泄露的后果有界。
 */
import { resetMetaFor } from './cloudSyncLocal'

const TOKEN_KEY = 'cloud-sync-token'
const USER_KEY = 'cloud-sync-user'
/** 12 万次：桌面上约 200~400ms，旧手机上一秒多。再高就要影响「点一下就登进去」的手感了 */
const PBKDF2_ITER = 120_000

export interface AuthUser { uid: string; username: string }

const user = ref<AuthUser | null>(null)
const token = ref('')
const authOpen = ref(false)
const busy = ref(false)
const authError = ref('')
let restored = false

const enc = new TextEncoder()

const hexToBytes = (hex: string) => {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

const bytesToHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('')

/** 把服务端回的错误翻成人话。ofetch 把 h3 的错误体放在 `err.data` 上 */
const errText = (e: any): string =>
  e?.data?.statusMessage || e?.data?.message || e?.statusMessage || e?.message || '请求失败'

export function useUserAuth() {
  /** 页面加载时把上次的登录状态读回来。令牌有没有过期不在这里判——第一次同步自然会知道 */
  const restore = () => {
    if (restored || typeof window === 'undefined') return
    restored = true
    try {
      token.value = localStorage.getItem(TOKEN_KEY) || ''
      const raw = localStorage.getItem(USER_KEY)
      user.value = raw ? JSON.parse(raw) as AuthUser : null
    } catch { /* 存档坏了就当没登录 */ }
  }

  const persist = (t: string, u: AuthUser | null) => {
    token.value = t
    user.value = u
    if (typeof window === 'undefined') return
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY)
      if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY)
    } catch { /* 隐私模式下写不进去，那这次登录就只在本次会话有效 */ }
  }

  /**
   * `crypto.subtle` 只在安全上下文里有（HTTPS 或 localhost）。
   * 用手机通过局域网 IP 的 http 打开时它是 undefined，不先说清的话报错是
   * 「Cannot read properties of undefined」，看着像代码写坏了。
   */
  const requireSubtle = () => {
    if (!globalThis.crypto?.subtle) {
      throw new Error('浏览器没有提供加密接口：请用 HTTPS 或 localhost 打开（局域网 IP 的 http 不算安全上下文）')
    }
  }

  const derive = async (password: string, saltHex: string): Promise<string> => {
    requireSubtle()
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: PBKDF2_ITER, hash: 'SHA-256' },
      key, 256,
    )
    return bytesToHex(bits)
  }

  const randomHex = (bytes: number) => {
    const b = new Uint8Array(bytes)
    crypto.getRandomValues(b)
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  }

  /** 换账号登录要把上一个账号的版本号和墓碑扔掉，否则两个人的数据会被合到一起 */
  const adopt = (t: string, u: AuthUser) => {
    resetMetaFor(u.uid)
    persist(t, u)
    authError.value = ''
    authOpen.value = false
  }

  const register = async (username: string, password: string): Promise<boolean> => {
    if (busy.value) return false
    busy.value = true
    authError.value = ''
    try {
      const salt = randomHex(16)
      const verifier = await derive(password, salt)
      const r = await $fetch<{ token: string; user: AuthUser }>('/api/user/register', {
        method: 'POST', body: { username, salt, verifier },
      })
      adopt(r.token, r.user)
      return true
    } catch (e) {
      authError.value = errText(e)
      return false
    } finally { busy.value = false }
  }

  const login = async (username: string, password: string): Promise<boolean> => {
    if (busy.value) return false
    busy.value = true
    authError.value = ''
    try {
      // 盐要先从服务端取（每个账号一份）。查无此人时服务端也会回一个假盐，
      // 所以这一步的成功与否说明不了账号存不存在
      const { salt } = await $fetch<{ salt: string }>('/api/user/salt', { method: 'POST', body: { username } })
      const verifier = await derive(password, salt)
      const r = await $fetch<{ token: string; user: AuthUser }>('/api/user/login', {
        method: 'POST', body: { username, verifier },
      })
      adopt(r.token, r.user)
      return true
    } catch (e) {
      authError.value = errText(e)
      return false
    } finally { busy.value = false }
  }

  /**
   * 退出只清令牌，**不动本地那几份清单**：那是用户自己攒的历史和收藏，
   * 「退出登录」不该等于「把我的收藏删了」。墓碑账本也留着（同一个账号再登回来还用得上）。
   */
  const logout = () => {
    persist('', null)
    authError.value = ''
  }

  /** 服务端回的用户名才是准的（本机缓存可能是改名前的） */
  const adoptUser = (u: AuthUser) => {
    if (!u?.uid) return
    if (user.value?.username === u.username && user.value?.uid === u.uid) return
    persist(token.value, u)
  }

  /** 带令牌的请求。401 = 令牌废了，就地登出，免得后面每次同步都白撞一次 */
  const authFetch = async <T>(url: string, opts: Record<string, any> = {}): Promise<T> => {
    if (!token.value) throw new Error('未登录')
    try {
      return await $fetch<T>(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token.value}` } })
    } catch (e: any) {
      if (e?.status === 401 || e?.statusCode === 401 || e?.response?.status === 401) logout()
      throw e
    }
  }

  const fetchQuota = () => $fetch<{ used: number; max: number }>('/api/user/quota')

  return {
    user, token, authOpen, busy, authError,
    isLoggedIn: computed(() => !!token.value && !!user.value),
    restore, register, login, logout, adoptUser, authFetch, fetchQuota, errText,
  }
}
