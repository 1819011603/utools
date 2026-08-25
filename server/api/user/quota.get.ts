/**
 * 还剩几个注册名额。
 *
 * 为什么值得单开一个接口：前端拉伸口令要跑十几万次 PBKDF2，手机上要一秒多。
 * 名额已满时让用户先填完表、等完这一秒、才在最后被拒，是最难受的顺序 ——
 * 注册面板一打开就先问一句，满了就直接把表单换成一句说明。
 *
 * 只回两个数字，不泄露任何账号信息。
 */
import { getUserStore, MAX_USERS } from '../../utils/userStore'

export default defineEventHandler(async (event) => {
  return { used: await getUserStore(event).countUsers(), max: MAX_USERS }
})
