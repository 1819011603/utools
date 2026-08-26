/**
 * fangpi.net（放屁音乐网）适配层：**唯一**认识这个站点的地方。
 *
 * ## 它补上了 24bit 最痛的两个缺口
 *
 *   · **不需要任何 cookie，也没发现每日配额** —— 24bit 一到配额上限就只能搜不能播，
 *     这时候这一段照常能用
 *   · **自带内嵌歌词**（详情页 `#content-lrc`）—— 24bit 两个源一个都不给词，
 *     只能去网易云按歌名歌手现查，版权下架的歌还常匹配到翻唱版
 *
 * 代价是只有一档 128K MP3，比 24bit 的无损低一档 —— 所以两个站的结果**分区展示**，
 * 让用户自己按音质挑，而不是我们替他混排。
 *
 * ## 两段默认走服务端，本机中继开着时优先绕开它
 *
 *   搜索  浏览器 ──GET──> /api/music/fangpi/search    （整站在 CF 后面，无 ACAO）
 *   取址  浏览器 ──GET──> /api/music/fangpi/resolve   （两跳：详情页 + POST，见接口注释）
 *   播放  浏览器 ──GET──> 酷我 CDN                     （`<audio>` 直连；下载走 /api/proxy）
 *
 * **这个站在 Workers 机房出口是结构性拦死的**（CF 的 WAF 拦的是「是不是数据中心出口」这个
 * 特征，不是行为打分——跟 24bit 那种「加个 Referer 能改善概率」不是一回事，实测本机直连 200、
 * CF Pages 上恒 502）。所以过去这个站标了 `localOnly: true`，线上搜索界面直接不出现它，
 * 免得摆一个「点了必报错」的坑。**现在有了本机中继（见 `localRelay.ts`）就把这个限制解了**——
 * 中继用的是真实住宅 IP，跟本地开发那条能通的路是同一类出口，线上界面也能正常显示这个站了；
 * 没开中继的访客点到它还是会撞服务端那条结构性拦死的路，界面上会用「去源站搜」兜底
 * （见 `ResultList.vue`），不是无声失败。
 */
import type { MusicResolved, MusicSearchRow, MusicSite } from './types'
import {
  BASE_FANGPI,
  PLAY_URL_ENDPOINT_FANGPI,
  buildFangpiDetailUrl,
  buildFangpiSearchUrl,
  buildPlayUrlBody,
  parseAppData,
  parsePlayUrlBody,
  parseSearchRows,
  parseTotal,
  toFangpiResolvedPayload,
} from '~/utils/musicFangpiProtocol'

export const SITE_FANGPI: MusicSite = {
  id: 'fangpi',
  name: '放屁音乐网',
  tagline: 'MP3 128K · 体积小、多数歌带歌词',

  /** 只有一条搜索路径（`/s/<kw>`），所以就一条泳道 */
  sources: [{ id: 'main', name: '默认' }],

  /**
   * 只有一档。站点压根不给音质选项，地址上写着 `bitrate$128` ——
   * 所以这里也**不编第二个档出来**，取址成功后用地址里读出的真实码率覆盖显示。
   */
  tiers: [
    { tier: 'mp3', label: '播放 MP3', hint: '128K，约 3–5MB', color: 'green' },
  ],

  /**
   * **`0` = 不分页。**
   *
   * 实测 `?page=2` 回的还是第一页原文（两页字节数与首条 id 完全一致），
   * 结果一次给全（「周杰伦」33 条、「爱」只有 4 条）。所以界面上不该出现「加载更多」。
   */
  pageSize: 0,

  /** 「去源站搜」的落点。搜索页地址就是 `/s/<kw>`（服务端也是照这个格式抓的） */
  homepage: `${BASE_FANGPI}/`,
  buildSearchUrl: kw => buildFangpiSearchUrl(kw),

  async search(_source, kw, _page, signal): Promise<MusicSearchRow[]> {
    // 站点不分页，`page` 收下但用不上（形状要和别的站点一致）；这个站没有登录态这回事，
    // 不用像 24bit 那样先判断有没有配置 Cookie，中继永远可以先试
    const relay = await viaLocalRelay(buildFangpiSearchUrl(kw))
    if (relay?.status === 200) {
      const rows = parseSearchRows(relay.body)
      // 抓到页面却一条都没解出来，多半是页面结构变了或者压根没搜到——两种都别硬当结果用，
      // 落回服务端那条路让它按真实状态报错（服务端会走 404/502 的判断）
      if (rows.length || parseTotal(relay.body) === 0) {
        return rows.map(r => ({ id: r.id, name: r.name, player: r.artist, site: 'fangpi' as const }))
      }
    }

    const res = await $fetch<{ items: Omit<MusicSearchRow, 'site'>[] }>('/api/music/fangpi/search', {
      query: { kw },
      signal,
      // 同 site24bit.ts：服务端 `musicFetch` 撞 CF 墙已经自己重试过，ofetch 默认的
      // GET 失败重试会再叠一层，两层叠加只会把请求量推得更高、更容易被判 bot
      retry: 0,
    })
    return (res?.items ?? []).map(r => ({ ...r, site: 'fangpi' as const }))
  },

  async resolve(id, _tier, signal): Promise<MusicResolved> {
    /*
     * 两跳都走中继：① 详情页拿 `play_id` ② 拿它换真实地址。
     * 中继的 `relay_config.json` 按目标 URL 的正则给两步都注入同一个静态 Referer——
     * 服务端那条路第二跳会带上"当前这首歌的详情页地址"当 Referer（更精确），
     * 但源码注释里记过「实测不带也能成」，静态值够用，不值得为了这点精确度
     * 再多一层"中继怎么按需变 Referer"的复杂度。
     */
    const page = await viaLocalRelay(buildFangpiDetailUrl(id))
    if (page?.status === 200) {
      const app = parseAppData(page.body)
      if (app?.play_id) {
        const play = await viaLocalRelay(PLAY_URL_ENDPOINT_FANGPI, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: buildPlayUrlBody(app.play_id),
        })
        if (play?.status === 200) {
          const { url, code } = parsePlayUrlBody(play.body)
          if (code === 1 && url) return toFangpiResolvedPayload(url, app, page.body)
        }
      }
    }
    // 中继没开 / 超时 / 任何一跳失败 → 落回服务端那条路，不抛错、让它按真实状态报错
    // （包括人机验证的 429、没资源的 404 那些更精确的错误分类）

    // 只有一档，`tier` 用不上 —— 但签名要和别的站点一致，闸门才能不认识具体站点
    return $fetch<MusicResolved>('/api/music/fangpi/resolve', {
      query: { id },
      signal,
      retry: 0,
    })
  },

  // 没有 quotaHint：这个站没有「今日配额」这回事，闸门也就不该为它准备那条停手的路
}
