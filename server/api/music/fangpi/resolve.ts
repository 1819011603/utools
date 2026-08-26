/**
 * fangpi.net 取址：详情页 → 取址令牌 → 播放地址。
 *
 * ## 为什么是两跳，绕不开
 *
 *   ① `GET /music/<id>`                 → `window.appData.play_id`
 *   ② `POST /member/common-play-url`    → `{code:1,data:{url}}`
 *
 * `play_id` 是 Laravel `encrypt()` 的产物（随机 IV + HMAC 签名），**我们生成不了**，
 * 只能从页面里拿。所以哪怕手上已经有 `mp3_id`，也必须先抓一次详情页。
 *
 * 顺路的收获让这一跳不算白花：封面、时长（`03:35`）、**内嵌歌词**都在同一份 HTML 里 ——
 * 尤其歌词，24bit 那两个源一个都不给，只能去网易云按歌名歌手现查（还常匹配到翻唱版）。
 *
 * ## 地址值得缓存，而且缓存很划算
 *
 * 实测同一个 `play_id` 连调两次拿到**完全相同**的地址（明文稳定，只有密文因随机 IV 而变），
 * 而且那条地址在它路径里那个 hex 时间戳过去 23 分钟之后仍然正常回 206 ——
 * 也就是说它不像 24bit 那样 20 分钟就死。命中缓存能同时省掉上面两跳。
 *
 * **有本机中继时前端会绕开这条路**（见 `composables/musicSites/localRelay.ts` 和
 * `siteFangpi.ts`）——这个站在 Workers 机房出口结构性拦死，中继是唯一有机会成的路。
 * 两跳怎么拼、页面怎么抠挪进了 `utils/musicFangpiProtocol.ts`，两条路共用同一份。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import {
  BASE_FANGPI,
  PLAY_URL_ENDPOINT_FANGPI,
  buildFangpiDetailUrl,
  buildPlayUrlBody,
  parseAppData,
  parsePlayUrlBody,
  toFangpiResolvedPayload,
} from '~/utils/musicFangpiProtocol'
import { cfWallMessage, isCloudflareWall, musicFetch } from '../../../utils/musicFetch'
import { readUrlCache, writeUrlCache } from '../../../utils/musicUrlCache'

/** 缓存命名空间。与 24bit 的 `b`/`c` 同处一张表，键是 `<prefix>:<id>`，不能撞 */
const CACHE_PREFIX = 'fangpi'

export default defineEventHandler(async (event) => {
  const id = (getQuery(event).id as string)?.trim()
  // 这个站的 id 是纯数字自增（1720 / 11561889 / 34006802），挡住拼接注入
  if (!id || !/^\d{1,12}$/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: '缺少或非法的 id' })
  }

  const cached = readUrlCache(id, CACHE_PREFIX)
  if (cached) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { ...cached, cached: true }
  }

  // ── ① 详情页 ──
  const pageUrl = buildFangpiDetailUrl(id)
  const page = await musicFetch(pageUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${BASE_FANGPI}/`,
    },
  })

  // 撞 CF 墙：本地开发下几乎总是 dev server 带了 HTTPS_PROXY（这个站经代理恒 403）
  if (isCloudflareWall(page.status, page.body)) {
    throw createError({ statusCode: 502, statusMessage: cfWallMessage('放屁音乐网') })
  }
  if (page.status === 404) {
    throw createError({ statusCode: 404, statusMessage: '这个站点上没有这首歌' })
  }
  if (page.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `详情页返回 ${page.status}` })
  }

  const app = parseAppData(page.body)
  /*
   * 页面拿到了却没有令牌 → 这是**我们的解析该修了**，不是「这首没资源」。
   * 两者说法必须分开：报成「没资源」会让人去换歌试，而真正该做的是来看这个正则。
   */
  if (!app?.play_id) {
    throw createError({ statusCode: 502, statusMessage: '详情页里没有取址令牌，站点可能改版了' })
  }

  // ── ② 换地址 ──
  const play = await musicFetch(PLAY_URL_ENDPOINT_FANGPI, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      // 这三个头是照站点自己那一发抄的。实测不带也能成，但带上更稳（WAF 常拿它们做一致性检查）
      'Origin': BASE_FANGPI,
      'Referer': pageUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: buildPlayUrlBody(app.play_id),
  })

  if (play.status !== 200) {
    throw createError({ statusCode: 502, statusMessage: `取址接口返回 ${play.status}` })
  }

  const { url, code, msg: rawMsg } = parsePlayUrlBody(play.body)
  if (code !== 1 || !url) {
    /*
     * ⚠️ **「要人机验证」和「这首没资源」必须分开报，它们在这一层长得一模一样**
     * （都是 `code !== 1`，只有 `msg` 不同）。
     *
     * 连着取几十首之后站点会开始要人机验证：`{code:2, msg:"请完成人机验证后继续"}`，
     * 此后**这个 IP 上每一首都是这个结果**。按 404「没资源」报的话，用户会一首首往下试，
     * 每试一次都在加深站点对我们的判定 —— 而唯一有用的动作是**停手**，
     * 去站点页面上过一次校验或等一会儿。
     *
     * 回 429 就是让闸门当场对这个站点收手（见 useMusicResolveGate 的 429 分支）。
     */
    const msg = rawMsg?.trim() || ''
    if (code === 2 || /人机验证|验证码|安全验证/.test(msg)) {
      throw createError({
        statusCode: 429,
        statusMessage: '放屁音乐网要求人机验证：在浏览器里打开 fangpi.net 随便播一首、过一次校验，'
          + '或者等几分钟再试。这期间可以先用另一个音乐源。',
      })
    }
    // 站点自己的 msg 比我们编的话准，有就用它
    throw createError({
      statusCode: 404,
      statusMessage: msg || '这首歌取不到播放地址',
    })
  }

  // 字段怎么拼（音质标注、封面转 https、歌词有没有该给）挪进了 `utils/musicFangpiProtocol.ts`，
  // 中继那条路解析同一个 detail 页时用的是同一份，行为不会漂移
  const payload = toFangpiResolvedPayload(url, app, page.body)

  writeUrlCache(id, CACHE_PREFIX, payload)

  // 地址本身有时效，**绝不能被 HTTP 层缓存**：那一层不认识它什么时候作废
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return { ...payload, cached: false }
})
