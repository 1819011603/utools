/**
 * 提交清单。`{ colls: [{ coll, baseRev, payload }] }` → 每份各自的结果。
 *
 * **一份一份独立成败**：一份撞了 rev 不该把另外四份也退回去（那会让两台设备互相把对方顶掉、
 * 谁也存不进去）。撞了的那份把**当前值**一起带回去，前端就地重新合并再推一次。
 *
 * 三道必须有的闸：
 *   · `coll` 不在白名单里一律拒 —— 否则 `user_blobs` 就成了任意 key-value 存储，
 *     拿到一个令牌就能把免费额度的 500MB 灌满
 *   · 单份 payload 上限 512KB —— D1 单行上限 2MB，而这几份清单里最大的（500 首收藏）也就一百多 KB，
 *     超出这个量级说明前端算错了，存进去只会把后续每次同步都拖慢
 *   · 份数上限 = 白名单长度，防同一个 coll 重复塞几百遍
 */
import { getUserStore } from '../../utils/userStore'
import { requireUid } from '../../utils/authToken'
import { SYNC_COLL_IDS } from '../../utils/syncColls'

const MAX_PAYLOAD = 512 * 1024

interface PushItem { coll?: string; baseRev?: number; payload?: string }

export default defineEventHandler(async (event) => {
  const uid = await requireUid(event)
  const body = await readBody<{ colls?: PushItem[] }>(event)
  const items = Array.isArray(body?.colls) ? body!.colls! : []

  if (!items.length) throw createError({ statusCode: 400, statusMessage: '没有要提交的内容' })
  if (items.length > SYNC_COLL_IDS.length) {
    throw createError({ statusCode: 400, statusMessage: '提交的清单份数超出范围' })
  }

  const store = getUserStore(event)
  const results: Array<{ coll: string; ok: boolean; rev?: number; cur?: unknown }> = []

  for (const it of items) {
    const coll = String(it?.coll ?? '')
    const payload = String(it?.payload ?? '')
    if (!(SYNC_COLL_IDS as readonly string[]).includes(coll)) {
      throw createError({ statusCode: 400, statusMessage: `不认识的清单：${coll}` })
    }
    if (!payload || payload.length > MAX_PAYLOAD) {
      throw createError({ statusCode: 413, statusMessage: `${coll} 这一份太大了（上限 ${MAX_PAYLOAD / 1024}KB）` })
    }
    const baseRev = Number(it?.baseRev) || 0
    const r = await store.writeColl(uid, coll, baseRev, payload)
    results.push(r.ok ? { coll, ok: true, rev: r.rev } : { coll, ok: false, cur: r.cur })
  }

  return { results }
})
