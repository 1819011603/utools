/**
 * 登录。`{ username, verifier }` → `{ token, user }`
 *
 * `verifier` 是前端用 `/api/user/salt` 拿到的盐拉伸出来的，服务端只做一次 SHA-256 再比。
 *
 * **「用户名不存在」和「口令不对」回同一句话**：分开说等于告诉对方「这个名字是对的，
 * 继续猜口令就行」，而 `/api/user/salt` 已经刻意不泄露账号是否存在了，这里再泄露就白做。
 */
import { getUserStore } from '../../utils/userStore'
import { requireSecret, safeEqual, sha256Hex, signToken } from '../../utils/authToken'

/** 连错这么多次就锁一段时间。拉伸在前端做，猜测方的成本没有消失，但挡一下撞库脚本仍然值得 */
const MAX_FAILS = 5
const LOCK_MS = 10 * 60_000

export default defineEventHandler(async (event) => {
  const secret = requireSecret(event)
  const body = await readBody<{ username?: string; verifier?: string }>(event)
  const unameKey = String(body?.username ?? '').trim().toLowerCase()
  const verifier = String(body?.verifier ?? '')
  if (!unameKey || !verifier) throw createError({ statusCode: 400, statusMessage: '请填用户名和密码' })

  const store = getUserStore(event)
  const row = await store.findByName(unameKey)
  const wrong = () => createError({ statusCode: 401, statusMessage: '用户名或密码不对' })
  if (!row) throw wrong()

  const now = Date.now()
  if (row.lockUntil > now) {
    const mins = Math.ceil((row.lockUntil - now) / 60_000)
    throw createError({ statusCode: 429, statusMessage: `密码连续错太多次，请 ${mins} 分钟后再试` })
  }

  if (!safeEqual(await sha256Hex(verifier), row.pwHash)) {
    const fails = row.failCount + 1
    await store.setFail(row.uid, fails, fails >= MAX_FAILS ? now + LOCK_MS : 0)
    throw wrong()
  }

  // 只在真有累计失败时才写一次，省掉「每次成功登录都白写一行」
  if (row.failCount || row.lockUntil) await store.setFail(row.uid, 0, 0)

  return { token: await signToken(row.uid, secret), user: { uid: row.uid, username: row.username } }
})
