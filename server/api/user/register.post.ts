/**
 * 注册。`{ username, salt, verifier }` → `{ token, user }`
 *
 * **盐由前端生成、口令拉伸也在前端做**（见 `authToken.ts` 顶部那段：CF 免费版每请求 10ms CPU），
 * 这里只对 `verifier` 做一次 SHA-256 存盘。服务端从头到尾看不到明文口令。
 *
 * 名额上限（`MAX_USERS`）的判断在 `createUser` 里跟插入同一条语句，这里只负责把结果翻成人话。
 */
import { getUserStore, MAX_USERS } from '../../utils/userStore'
import { requireSecret, sha256Hex, signToken } from '../../utils/authToken'

/** 用户名：2~24 字，中英文数字加几个常见符号。放开空格会带来「看不见的两个名字」那类麻烦 */
const NAME_RE = /^[\w.@一-龥-]{2,24}$/
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

export default defineEventHandler(async (event) => {
  const secret = requireSecret(event)
  const body = await readBody<{ username?: string; salt?: string; verifier?: string }>(event)

  const username = String(body?.username ?? '').trim()
  const salt = String(body?.salt ?? '')
  const verifier = String(body?.verifier ?? '')

  if (!NAME_RE.test(username)) {
    throw createError({ statusCode: 400, statusMessage: '用户名只能是 2~24 个中英文、数字或 . _ - @' })
  }
  // 这两个不是用户填的，形状不对说明前端出了问题，别把它当用户的错来提示
  if (!HEX32.test(salt) || !HEX64.test(verifier)) {
    throw createError({ statusCode: 400, statusMessage: '请求参数不合法' })
  }

  const store = getUserStore(event)
  const unameKey = username.toLowerCase()

  // 先查一次只为把「重名」这句说准：createUser 失败时无法区分「重名」和「重名且名额已满」
  if (await store.findByName(unameKey)) {
    throw createError({ statusCode: 409, statusMessage: '这个用户名已经有人用了' })
  }

  const uid = crypto.randomUUID().replace(/-/g, '')
  const result = await store.createUser({
    uid,
    username,
    unameKey,
    salt,
    pwHash: await sha256Hex(verifier),
    failCount: 0,
    lockUntil: 0,
    createdAt: Date.now(),
  })

  if (result === 'full') {
    throw createError({ statusCode: 403, statusMessage: `注册名额已满（目前只开放 ${MAX_USERS} 个账号）` })
  }
  if (result === 'taken') {
    throw createError({ statusCode: 409, statusMessage: '这个用户名已经有人用了' })
  }

  return { token: await signToken(uid, secret), user: { uid, username } }
})
