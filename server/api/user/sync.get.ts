/**
 * 拉取这个账号的全部清单。`Authorization: Bearer <token>` → `{ user, colls }`
 *
 * 顺手把 `user` 也带回来：前端本机缓存的用户名可能是改名前的，
 * 而这一发请求本来就要验令牌，多一次按 uid 的查询比另开一个 /me 接口划算。
 * 令牌验得过但查不到人（数据库被重建过）→ 401，前端据此清掉本地令牌。
 */
import { getUserStore, storeKind } from '../../utils/userStore'
import { requireUid } from '../../utils/authToken'

export default defineEventHandler(async (event) => {
  const uid = await requireUid(event)
  const store = getUserStore(event)

  const row = await store.findByUid(uid)
  if (!row) throw createError({ statusCode: 401, statusMessage: '账号不存在，请重新登录' })

  return {
    user: { uid: row.uid, username: row.username },
    // 排查「本地存进去了线上却没有」时第一个要看的就是这个字段
    store: storeKind(event),
    colls: await store.readColls(uid),
  }
})
