/**
 * 24bit.net 的登录态（可选，用户自己填）。
 *
 * ## 为什么需要它
 *
 * 站点对**匿名访问按天限量**，配额用完的页面上写着「如果您已注册过，可登录后访问」。
 * 而我们的请求走服务端中转，用不上用户在自己浏览器里的登录态 —— 中间隔着一层，
 * 浏览器的 cookie 不会跟着我们的 `/api/music/*` 一起过去。
 *
 * 所以只能让用户把自己的 cookie 交过来。这是**他自己的账号、自己的额度**，
 * 走的是站点明说的那条路，不是绕开谁。
 *
 * ## 凭证处置的三条线
 *
 * 1. **只存在本机 localStorage**，不上传到任何我们自己的存储；
 * 2. 发给我们的服务端时走**请求头**（`x-music-cookie`）而不是 query
 *    —— query 会进访问日志、浏览器历史和 Referer；
 * 3. 服务端拿到后**只透传给 24bit.net，不落盘不记日志**（见 server/utils/musicFetch.ts）。
 *
 * 即便如此，localStorage 里放凭证仍有 XSS 面上的风险，所以界面上必须把这件事说明白，
 * 让用户自己决定要不要填 —— 不填也能用，只是受每日配额限制。
 */

const STORAGE_KEY = 'music-24bit-cookie'

/**
 * 模块级单例。搜索、取址、设置面板三处都要读同一份，
 * 各持一份的话会出现「设置里填了、请求却没带上」这种最难查的不一致。
 */
const cookie = ref('')
let loaded = false

function load() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    cookie.value = localStorage.getItem(STORAGE_KEY) ?? ''
  } catch { /* 隐私模式下读不到就当没有，不该拖垮页面 */ }
}

export function useMusic24bitAuth() {
  load()

  const hasAuth = computed(() => cookie.value.trim().length > 0)

  const save = (raw: string) => {
    const v = raw.trim()
    cookie.value = v
    try {
      if (v) localStorage.setItem(STORAGE_KEY, v)
      else localStorage.removeItem(STORAGE_KEY)
    } catch { /* 存不下也不影响本次会话，内存里那份照样管用 */ }
  }

  const clear = () => save('')

  /**
   * 请求头。**没填就返回空对象**，而不是带一个空的 `x-music-cookie` ——
   * 空头会让服务端那句 `if (init?.cookie)` 判断多绕一层，也让抓包时看不出到底有没有登录态。
   */
  const authHeaders = (): Record<string, string> =>
    hasAuth.value ? { 'x-music-cookie': cookie.value.trim() } : {}

  return { cookie, hasAuth, save, clear, authHeaders }
}
