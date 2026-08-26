/**
 * 允许同步的清单 id 白名单。
 *
 * 与前端 `composables/cloudSyncSpec.ts` 里那份 `SYNC_COLLECTIONS` 的 `id` 一一对应，
 * 但**故意不共用一份**：前端那份带着 localStorage 键、合并函数、上限这些浏览器侧的东西，
 * 服务端不该也不能 import 它（同 `videoParseRules.ts` 里「服务端拿不到 localStorage」那条）。
 * 服务端只需要回答一个问题：这个 coll 名字是不是我们认的。
 *
 * 不认的名字必须**拒掉**而不是照存：否则 `user_blobs` 会变成任意 key-value 存储，
 * 谁拿到一个 token 就能往里塞任意数据、把免费额度的 500MB 灌满。
 *
 * 这个文件**只放这一个数组常量**（CLAUDE.md：数组常量和别的导出混在一个文件里，
 * unimport 会静默漏掉紧跟其后的导出，而 tsc 照样能过）。
 */
export const SYNC_COLL_IDS = [
  'video-watch',   // video-watch-history：每部剧看到第几集
  'video-fav',     // video-favorites：收藏的影片
  'video-search',  // utools-history-video-search：按片名搜索历史
  'show-prefs',    // video-show-prefs：按剧的倍速与片头片尾
] as const
