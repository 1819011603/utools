/**
 * 拉取这个账号的清单。`Authorization: Bearer <token>` → `{ user, store, colls }`
 *
 * 三种取法，前端按需选（见 useCloudSync.cycle）：
 *   · `?meta=1`      只回版本号，**不含 payload** —— 每轮同步的第一发
 *   · `?colls=a,b`   只回这几份的正文 —— 上一发发现哪几份变了才取
 *   · 不带参数        全量（首次同步、以及撞 rev 之后的重来）
 *
 * 为什么值得分成两发：payload 是几十~几百 KB 的 JSON，而同步的**常态是云端一份都没变**
 * （多数人只有一台设备在用）。原来每轮都把四份全文拉一遍，慢的就是这个；
 * 现在常态下一发 meta（几十字节）就够了，一个正文都不用取。
 *
 * 顺手把 `user` 也带回来：前端本机缓存的用户名可能是改名前的，
 * 而这一发请求本来就要验令牌，多一次按 uid 的查询比另开一个 /me 接口划算。
 * 令牌验得过但查不到人（数据库被重建过）→ 401，前端据此清掉本地令牌。
 */
import { getUserStore, storeKind } from '../../utils/userStore'
import { requireUid } from '../../utils/authToken'
import { SYNC_COLL_IDS } from '../../utils/syncColls'

export default defineEventHandler(async (event) => {
  const uid = await requireUid(event)
  const store = getUserStore(event)

  const row = await store.findByUid(uid)
  if (!row) throw createError({ statusCode: 401, statusMessage: '账号不存在，请重新登录' })

  const query = getQuery(event)
  const user = { uid: row.uid, username: row.username }
  const kind = storeKind(event)

  if (query.meta === '1') {
    return { user, store: kind, meta: true as const, colls: await store.readCollRevs(uid) }
  }

  /**
   * `colls` 一律按白名单过滤后再进 SQL。不认识的名字直接丢掉而不是报错：
   * 前端的清单表会增减（`pruneUnknown` 那条），老页面带着一个已下线的 id 上来是正常的，
   * 为它整发请求失败不值当。
   */
  const wanted = String(query.colls ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => (SYNC_COLL_IDS as readonly string[]).includes(s))

  return {
    user,
    // 排查「本地存进去了线上却没有」时第一个要看的就是这个字段
    store: kind,
    colls: await store.readColls(uid, wanted.length ? wanted : undefined),
  }
})
