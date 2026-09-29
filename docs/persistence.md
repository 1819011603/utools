# persistence

> 从 CLAUDE.md 下沉的细节（原样保留）。需要时再读。

## 状态持久化（localStorage）

`video-player-state` · `video-probe-dead-direct`（按 host 记「直连是黑洞」）· `video-player-learned-profiles` ·
`video-player-origin-history` / `-referer-history` · `video-parse-rules` /
`-embed-sandbox` / `video-parse-last-result`（1 小时）· `video-watch-history`（**看到第几集**，按剧名存）·
`video-show-prefs`（**倍速与片头片尾**，按剧名存）· `video-favorites`（**收藏影片**，按剧名存）·
`video-cover-miss`（封面补不到的剧，24 小时内不再试）· `video-player-metrics`（**本机播放记录**，每集一条、最近 50 条，
只存本机不上云，见 player.md「本机播放记录」）· 各页 `*-settings` · `utools-history-<page>`。

同步账号那侧：`cloud-sync-token` / `cloud-sync-user`（令牌与用户名）· `cloud-sync-meta`（见下）。

**「永久保存」= `navigator.storage.persist()`，不是「localStorage 没有 TTL」**：没授权时 Chrome/Edge 会按 LRU
**整个 origin 一起驱逐**，Safari（ITP）**7 天不访问就删**且不支持 `persist()`（只能如实标出来）。先 `persisted()`
再 `persist()`（已授权还去调会在 Firefox 白弹一次窗）；**请求时机必须挂在「真的写下了一条」之后**，绝不在页面加载时请求。
