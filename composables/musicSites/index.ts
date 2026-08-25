/**
 * 站点注册表 + 共用的转换函数。**接一个新站点只要往这儿加一行。**
 *
 * ⚠️ `MUSIC_SITES` 那个数组常量**必须留在文件最后**：unimport 会静默漏掉紧跟数组常量
 * 之后的导出（tsc 却能过），表现是「一堆 xxx is not defined」。
 * 调用方也一律显式 `import`，不靠自动导入 —— 双保险。
 */
import type { Track } from '../musicPlayer/types'
import type { MusicLocator, MusicSearchRow, MusicSite, MusicSiteId } from './types'
import { SITE_24BIT } from './site24bit'
import { SITE_FANGPI } from './siteFangpi'

/**
 * `Track.key`：做队列去重、收藏比对、下载排队的键。
 *
 * **绝不能用 `url` 当键**：地址带时效签名，同一首歌前后两次取到的可能完全不同
 * （同 video-parse 里 `progressKey()` 那条教训）。
 * 带上站点前缀是因为两个站点的 id 空间各自独立，`1720` 在两边是两首不同的歌。
 */
export const trackKeyOf = (site: MusicSiteId, id: string) => `${site}:${id}`

/**
 * 搜索结果 → 播放器认的 Track。**所有站点共用这一份**：
 * 各站点各写一遍的话，key 的拼法、resolver 的取值迟早在某个站点上漂移。
 *
 * 封面**不从搜索结果拿**：24bit 那边它是占位图（同一次搜索里所有条目完全相同，
 * 摆出来整页看着像同一首歌），fangpi 的搜索页压根不给。真封面取址成功后回填。
 */
export function rowToTrack(row: MusicSearchRow, tier?: string): Track {
  return {
    key: trackKeyOf(row.site, row.id),
    name: row.name,
    artist: row.player,
    album: row.album,
    /** 站点 id 直接当取址器名。**取址路由只看这个字段**，见 MusicLocator 的注释 */
    resolver: row.site,
    // 用户点了哪个档就从哪个开始试；没指定时闸门按站点声明的顺序来
    locator: { id: row.id, preferred: tier } satisfies MusicLocator,
  }
}

/** 按 id 找站点。找不到返回 undefined —— 老数据里可能有已经下线的站点名 */
export const siteById = (id?: string): MusicSite | undefined =>
  MUSIC_SITES.find(s => s.id === id)

/**
 * 注册表。**顺序决定界面上分区的先后**，排序按的是**「点下去多半能播」而不是音质**：
 * 24bit 对匿名访问按天限量（配额一满，整天所有曲目都只回一句 429，音质再好也播不了），
 * fangpi 没有这回事。把「有资源但可能取不到地址」的那段摆在前面，
 * 用户点第一排点到的多半是 429，得往下翻才有能播的——先后一换就没这回事了。
 */
export const MUSIC_SITES: MusicSite[] = [SITE_FANGPI, SITE_24BIT]
