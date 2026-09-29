# utools — 晚风（在线工具集）

纯前端（`ssr: false`）在线工具集，Nuxt 3 + Nuxt UI，部署在 Cloudflare Pages。`/video-player` 对外叫「放映厅」。
主色 `rose`、灰阶 `zinc`（`app.config.ts`），**氛围靠底色和留白，不靠把颜色调重**。
除「视频代理 / 解析」两个服务端接口外，所有处理都在浏览器里做。

> 本文件只留**每轮必须遵守的铁律 + 细节索引**；展开的判据/踩坑已下沉到 `docs/`，需要时再读。

## 启动（本地开发）

```bash
HTTPS_PROXY=http://127.0.0.1:7897 MEDIA_NO_PROXY=1 npm run dev   # 端口固定 3000
```

- **不带 `HTTPS_PROXY` 就解析不了**：目标站多被 DNS 污染 →「浏览器能打开、接口 `fetch failed`」
- **`MEDIA_NO_PROXY=1` 让视频流直连**：出口 IP 一变很多 CDN 直接 403。真要代理用 `MEDIA_HTTPS_PROXY=`
- **3000 上已有 dev server 时先确认它带没带代理**，没带就杀掉重起（页面/HMR 全正常、只有抓源站那步失败，看着像规则写坏了）：
  `ps eww -o command -p $(lsof -ti:3000 | head -1) | tr ' ' '\n' | grep -iE 'PROXY|MEDIA_'`

## 技术栈与约定

- **Nuxt 3.15**（SPA）+ **@nuxt/ui 2.x**，Tailwind 锁 `3.4.17`；**Nitro preset `cloudflare-pages`** →
  服务端不能静态 `import` 任何 `node:*`
- 图标 `i-heroicons-xxx`；文案中文；**注释写「为什么」不写「做什么」**；重依赖动态 import
- **测试**：`npm test`（vitest）。纯逻辑模块的单测放同目录 `*.test.ts`（如 `prefetch/strategy.test.ts`）——
  带宽模型用桩，一条用例只验一级，失败时能直接点名是哪一级
- 新增工具页要改三处：`pages/新页.vue`、`pages/index.vue` 的 `categories`、`layouts/default.vue` 的 `toolCategories`
- **单文件不超过 500 行**，页面只留装配（播放器是样板）。两个配套动作：
  **`composables/` 的子目录要在 `nuxt.config.ts` 的 `imports.dirs` 里登记**（漏登记 =「一堆 xxx is not defined」）；
  **别把数组常量和别的导出混在一个文件里**（unimport 会静默漏掉紧跟其后的导出，tsc 却能过）

## 视频播放器（铁律）

核心难点：**跨域、防盗链、慢速源站、内存**。

- **依赖方向单向**：`gestures → engine/events/controls → conn/tier/playlist → media/handoff`，反向一律用回调
  （`deps.reload`、`registerTickHook`…）。`useVideoMediaState` 是**裸状态**（存在目的是打断依赖环），
  `useVideoPlayerController` 是装配层。**子组件不传 props**（各自 `useVideoPlayerCtx()`）→ **各模块返回的键名不能重复**。
- **连接方式只有一个来源：自动可达性探测**。站点规则表与手动模式已删；`originHint`/`refererHint` 是**候选值不是配置**。
- **进度按稳定键存，且认「媒体元素真装着的那一集」`playingIndex`**，不是乐观的 `currentIndex`（切集异步，见下）。
- **「先能播」优先**：起播门槛单位是「够播几秒」（× 倍速）；**存货不够时少开线程**（决定能不能播的只有紧邻播放头那一两片）；
  单条连接够快就少开（关键分片走 `fragLoader` 的对冲竞速，不受预取上限约束；
  反过来**预取要给它让槽**：总在途到 hostCap 就停补，见 `prefetchSlots`）。
- **切集是异步的**：`currentIndex` 一开始就乐观指向目标集，而旧 `<video>` 还在播 → 门闩、进度、自动下一集都要按这个前提写。

细节（按需读）：

| 文档 | 内容 |
|---|---|
| [docs/player.md](docs/player.md) | 起播/切集 · 转圈与卡死自救 · 代理与探测 · **并发预取与抗卡** · 内存 · 预热与死地址 · 下载(HLS/MP4) · FLV · 手势与移动端 · 切集门闩与进度 · 媒体库与换源 · URL 直链 |
| [docs/search.md](docs/search.md) | 按片名搜索（`/video-search`） |
| [docs/parse.md](docs/parse.md) | 视频解析（`/video-parse`）、接新站两条路 |
| [docs/sites.md](docs/sites.md) | 各站实测结论（nbmovie / MacCMS / kpkuang…） |
| [docs/persistence.md](docs/persistence.md) | localStorage 各键 · 「永久保存」= `navigator.storage.persist()` |
| [docs/account-sync.md](docs/account-sync.md) | 账号与云同步（Cloudflare D1）· 部署四步 |
| [docs/pitfalls.md](docs/pitfalls.md) | 通用坑（CF Workers / 代理 / 下线源 / m3u8 判据…） |

## 目录

```
pages/ 12 个工具页   composables/videoPlayer/ 播放器全部逻辑   composables/pdf/ PDF 操作   utils/ 前后端共用纯函数
docs/ CLAUDE.md 下沉的细节   server/api/proxy.ts 跨域/防盗链代理   server/api/resolve.ts 解析接口（薄壳，站点策略在 server/parsers/）
```

工具：`/pdf-tools` · `/image-compress` · `/image-convert` · `/video-to-gif` · `/audio-convert` · `/video-player` ·
`/video-parse` · `/video-search` · `/json-format` · `/json-diff` · `/json-extract` · `/content-diff` · `/timestamp`
