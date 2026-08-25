/**
 * 取某个用户名的盐（登录前必须先拿到它才能在前端拉伸口令）。
 *
 * **用户不存在时返回一个假盐，而不是 404**：真假两种响应的形状和长度完全一致，
 * 于是这个接口回答不了「这个用户名注册过没有」。否则它就是一个免费的用户名枚举器
 * ——只有 5 个名额的站，枚举出名字之后剩下的就只是猜口令了。
 *
 * 假盐必须**同一个用户名每次都一样**（`HMAC(secret, 用户名)`），不能用随机数：
 * 随机的话同一个名字连问两次得到两个盐，一眼就能分辨出「这个不存在」。
 */
import { getUserStore } from '../../utils/userStore'
import { hmacHex, requireSecret } from '../../utils/authToken'

export default defineEventHandler(async (event) => {
  const secret = requireSecret(event)
  const body = await readBody<{ username?: string }>(event)
  const unameKey = String(body?.username ?? '').trim().toLowerCase()
  if (!unameKey) throw createError({ statusCode: 400, statusMessage: '请填用户名' })

  const row = await getUserStore(event).findByName(unameKey)
  // 真盐是 16 字节 hex（32 字符），假的截到同样长度
  const salt = row?.salt ?? (await hmacHex(secret, `salt:${unameKey}`)).slice(0, 32)
  return { salt }
})
