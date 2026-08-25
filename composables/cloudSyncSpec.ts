/**
 * 要同步哪几份清单，以及每一份怎么算「同一条」、怎么算「哪条更新」。
 *
 * 只收**清单信息**，一个播放地址都不收：24bit 的地址带时效签名、约 20 分钟就过期，
 * 存下来下次打开必是死链而且失败是静默的（见 `useMusicFavorites.ts` 顶部那段）。
 * 收藏里本来存的就是「key + 元数据 + resolver」这样的占位，直接同步即可。
 *
 * 同样不收的还有 `music-24bit-cookie`：那是用户在第三方站的凭证，
 * `useMusic24bitAuth.ts` 已经承诺过「只存在本机、不上传到任何我们自己的存储」。
 * 视频解析历史（`utools-history-video-parse`，上限 2000 条）也不收 —— 它是四份清单加起来还大的一份，
 * 而它的价值（重新解析某个地址）本来就依赖那个站还活着。
 *
 * **本文件只导出 `SYNC_COLLECTIONS` 这一个数组常量**，后面不再放任何东西：
 * unimport 会静默漏掉紧跟数组常量之后的导出，而 tsc 照样能过（CLAUDE.md 里那条）。
 */
import type { SyncSpec } from './cloudSyncMerge'
import { reloadFavorites } from './useMusicFavorites'

/** 两份搜索历史都是 `HistoryItem<{kw}>`，身份口径与 `useHistory.ts` 里的去重保持一致 */
const historyKeyOf = (it: any) => { try { return JSON.stringify(it?.data) } catch { return '' } }
const historyTimeOf = (it: any) => Number(it?.timestamp) || 0

export const SYNC_COLLECTIONS: SyncSpec[] = [
  {
    id: 'video-watch',
    lsKey: 'video-watch-history',
    label: '追剧进度',
    kind: 'map',
    // 与 useWatchHistory 的 MAX_SHOWS 一致
    cap: 200,
    timeOf: r => Number(r?.at) || 0,
  },
  {
    id: 'video-search',
    lsKey: 'utools-history-video-search',
    label: '片名搜索历史',
    kind: 'list',
    cap: 200,
    keyOf: historyKeyOf,
    timeOf: historyTimeOf,
  },
  {
    id: 'music-fav',
    lsKey: 'music-favorites',
    label: '音乐收藏',
    kind: 'list',
    // 与 useMusicFavorites 的 MAX_FAVORITES 一致
    cap: 500,
    // 名字会重（同名翻唱）、地址会变，只有 key 是稳定的
    keyOf: t => String(t?.key ?? ''),
    timeOf: t => Number(t?.at) || 0,
    // 收藏是模块级单例 ref，直接改 localStorage 它不会知道
    onApplied: reloadFavorites,
  },
  {
    id: 'music-search',
    lsKey: 'utools-history-music-search',
    label: '音乐搜索历史',
    kind: 'list',
    cap: 200,
    keyOf: historyKeyOf,
    timeOf: historyTimeOf,
  },
  {
    id: 'show-prefs',
    lsKey: 'video-show-prefs',
    label: '每部剧的倍速与片头片尾',
    kind: 'map',
    cap: 200,
    /**
     * 按 `mt`（真的改过设置的时间）比，不按 `at`。
     * `at` 在 `applyShowPrefs` 里也会被刷一次（那是 LRU 淘汰用的「最近看过」），
     * 拿它做先后判断就会出现「A 上改了倍速、B 上只是打开看了一眼这部剧，结果 B 的旧值赢」。
     * 旧记录没有 `mt`，退回 `at`。
     */
    timeOf: p => Number(p?.mt) || Number(p?.at) || 0,
  },
]
