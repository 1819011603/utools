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
 * ## 两段都必须经服务端
 *
 *   搜索  浏览器 ──GET──> /api/music/fangpi/search    （整站在 CF 后面，无 ACAO）
 *   取址  浏览器 ──GET──> /api/music/fangpi/resolve   （两跳：详情页 + POST，见接口注释）
 *   播放  浏览器 ──GET──> 酷我 CDN                     （`<audio>` 直连；下载走 /api/proxy）
 *
 * CF 还会**按客户端指纹拦人**（Node 的 fetch 过、Python urllib 恒 403、
 * 经 HTTPS_PROXY 的出口恒 403），细节都在 `server/api/music/fangpi/search.ts` 里。
 */
import type { MusicResolved, MusicSearchRow, MusicSite } from './types'

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

  async search(_source, kw, _page, signal): Promise<MusicSearchRow[]> {
    // 站点不分页，`page` 收下但用不上（形状要和别的站点一致）
    const res = await $fetch<{ items: Omit<MusicSearchRow, 'site'>[] }>('/api/music/fangpi/search', {
      query: { kw },
      signal,
    })
    return (res?.items ?? []).map(r => ({ ...r, site: 'fangpi' as const }))
  },

  resolve(id, _tier, signal): Promise<MusicResolved> {
    // 只有一档，`tier` 用不上 —— 但签名要和别的站点一致，闸门才能不认识具体站点
    return $fetch<MusicResolved>('/api/music/fangpi/resolve', {
      query: { id },
      signal,
    })
  },

  // 没有 quotaHint：这个站没有「今日配额」这回事，闸门也就不该为它准备那条停手的路
}
