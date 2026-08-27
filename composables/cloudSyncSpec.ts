/**
 * 要同步哪几份清单，以及每一份怎么算「同一条」、怎么算「哪条更新」。
 *
 * 只收**清单信息**，一个播放地址都不收：解析出来的地址普遍带时效签名，
 * 存下来下次打开必是死链，而且失败是静默的。
 * 视频解析历史（`utools-history-video-parse`，上限 2000 条）也不收 —— 它比其余几份加起来还大，
 * 而它的价值（重新解析某个地址）本来就依赖那个站还活着。
 *
 * **本文件只导出 `SYNC_COLLECTIONS` 这一个数组常量**，后面不再放任何东西：
 * unimport 会静默漏掉紧跟数组常量之后的导出，而 tsc 照样能过（CLAUDE.md 里那条）。
 */
import type { SyncSpec } from './cloudSyncMerge'

/** 搜索历史是 `HistoryItem<{kw}>`，身份口径与 `useHistory.ts` 里的去重保持一致 */
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
    /**
     * `at` 是「最后看这部剧的时刻」，同一部剧两边都有时**按它比大小，谁看得晚谁赢**。
     *
     * 曾经这里是「一律取本机」（`preferLocal`），理由是「本机那条记的是眼前正在发生的观看」。
     * 那个保险是多余的：正在播的那部剧，`recordWatchProgress` 每次保存进度都会把 `at` 刷成现在，
     * 本机那条天然就是最新的、按时间比照样赢。而代价大得多 ——
     * **两台设备都看过的剧永远合不进来**（本机反过来把云端顶掉），
     * 表现就是「换台设备接着看，进度根本不同步」，而只在同一部剧上发作，一部新剧试又是好的。
     */
    timeOf: r => Number(r?.at) || 0,
  },
  {
    id: 'video-fav',
    lsKey: 'video-favorites',
    label: '收藏影片',
    kind: 'map',
    // 与 useFavorites 的 MAX_FAVS 一致
    cap: 500,
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
