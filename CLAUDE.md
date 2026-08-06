# utools — 开发工具箱

纯前端（SSR 关闭）的在线工具集合，Nuxt 3 + Nuxt UI，部署在 Cloudflare Pages。
除「视频代理」一个服务端接口外，所有处理都在浏览器里做，不上传用户文件。

## 技术栈与约定

- **Nuxt 3.15**（`ssr: false`，SPA）+ **@nuxt/ui 2.x**（UButton/UCard/UFormGroup/UInput/UBadge…）
- **Tailwind**（由 Nuxt UI 带入，锁 `3.4.17`），暗色模式用 `dark:` 变体；`colorMode.preference: 'light'`
- **Nitro preset `cloudflare-pages`** → 服务端代码不能静态 `import` 任何 `node:*` / Node 专属包
- 图标一律用 heroicons 字符串名：`i-heroicons-xxx`
- 页面 = 文件路由（`pages/*.vue` → `/xxx`），composables 自动导入，`ref/computed/onMounted` 无需 import
- 界面文案中文；代码注释写「为什么」而非「做什么」（现有注释密度较高，保持一致）
- 重依赖一律**动态 import**（`jspdf`/`upng-js`/`hls.js`/`@ffmpeg/*`/`pdfjs-dist`/`quantize`），避免首屏体积和 SSR/CF 构建问题

### 命令

```bash
npm run dev        # 本地开发
npm run build      # 构建
npm run generate   # 静态产物（部署用）
npm run deploy     # generate + wrangler pages deploy .output/public
```

注意：仓库默认**不带 `node_modules`**，改完代码若要验证类型/构建需先 `npm install`。
未装依赖时 IDE 会报 `找不到模块 hls.js` 之类，属预期噪音。

## 目录结构

```
pages/          12 个工具页，一页一工具，逻辑基本自包含
composables/    跨页复用的处理引擎（视频/PDF/GIF/TIFF/历史）
components/     FileUpload（拖拽上传）、ColorModeButton
layouts/default.vue   侧边栏导航（新增页面需在此 + pages/index.vue 各登记一次）
server/api/proxy.ts   唯一服务端接口：视频跨域/防盗链代理
```

新增工具页的落地点有三处，别漏：`pages/新页.vue`、`pages/index.vue` 的 `categories`、`layouts/default.vue` 的 `toolCategories`。

## 工具清单

| 页面 | 路由 | 能力 |
| --- | --- | --- |
| `pdf-tools.vue` | `/pdf-tools` | 合并（可按页范围）/拆分/压缩/加删水印/提取页/旋转/删页/图片→PDF/Word↔PDF |
| `image-compress.vue` | `/image-compress` | 批量压缩，输出 JPEG/WebP/PNG/**PDF**，PNG 走 upng-js 调色板量化，支持 TIFF 输入 |
| `image-convert.vue` | `/image-convert` | 格式互转（含 SVG 输入），Canvas 实现 |
| `video-to-gif.vue` | `/video-to-gif` | 视频抽帧 → gif.js 编码，可选抖动算法/调色板（quantize）/帧率/裁剪 |
| `audio-convert.vue` | `/audio-convert` | WebAudio 解码 + OfflineAudioContext 重采样，采样率/位深可调 |
| `video-player.vue` | `/video-player` | M3U8/MP4 播放器，见下节（本项目最复杂的一页，105K） |
| `json-format.vue` | `/json-format` | 格式化 + 语法高亮 + 树形视图 + 智能解析（从任意文本里捞 JSON、递归去转义最多 3 层）+ 路径删除/撤销 |
| `json-diff.vue` | `/json-diff` | 两份 JSON 差异对比，可指定字段做数组匹配键，差异分组排序可配 |
| `json-extract.vue` | `/json-extract` | JQ 风格路径提取，输出每行一个 / JSON 数组 / 逗号分隔，可排序去重 |
| `content-diff.vue` | `/content-diff` | 文本集合运算：A-B / B-A / 交集 / 并集，分隔符可选 |
| `timestamp.vue` | `/timestamp` | 时间戳 ↔ 日期互转，多时区多格式 |

## 视频播放器（重点模块）

`pages/video-player.vue` + 7 个 composable + `server/api/proxy.ts`。核心难点是**跨域、防盗链、慢速源站**。

### 代理与防盗链

浏览器禁止 JS 设置 `Origin`/`Referer`（forbidden headers），所以必须绕服务端：

`GET /api/proxy?url=&origin=&referer=&noref=1&noseg=1`
- `noref=1` 伪装下载器：不发 Origin/Referer（很多源站不校验，不带头反而更快更稳）
- `noseg=1` m3u8 内分片 URL 不改写，让分片直连 CDN（更快、省服务器流量）
- m3u8 会被改写内部 URL；master/点播列表缓存 1 天，直播列表 `no-cache`
- 分片 200 响应缓存 1 天；**206 分块响应绝不缓存**（同 URL 不同 Range 混用会拼出损坏分片）
- Node 上动态加载 undici Agent 放宽 TLS、超时拉到 5 分钟；CF Workers 上降级原生 fetch
- `fetchWithHeaderProbe` 会并发探测「带头/不带头」哪种能过，结果按 host 缓存 30 分钟

页面侧有三层策略，优先级 **手动 > 站点规则 > 自动阶梯**：
1. **自动可达性阶梯**（`applyReachabilityStep`）：直连 → 代理·伪装 → 代理·防盗链，失败自动升级重载
2. **站点规则**（`composables/videoSiteRules.ts`）：按 host 子串或 `/正则/` 匹配，内置 jisuzyv/xhscdn/huyall 三条，用户规则存 localStorage 且优先
3. **手动**：用户改任一连接设置即置 `manualStrategyOverride`，引擎不再覆盖（改动必须 `loadVideo()` 重载——连接策略只在加载时生效）

### 并发预取与抗卡

- `useHlsPrefetch.ts`：自定义 hls.js `fLoader`，命中预取缓存即时返回；按缓冲健康度动态调并发。
  浏览器同 host 只给 6 条连接（`MAX_CONN`），所以有**双通道**——同一分片给出「直连 CDN」和「/api/proxy」两个 origin 的 URL，并发提到 ~12。
- **服务器档位** good/medium/bad（`SERVER_TIERS`）：一套抗卡参数（濒卡/吃紧阈值、安全系数、并发下限、对冲延迟、跳片超时、竞速上限）。
  可自动分档（`classifyTier`）或站点规则锁定；页面「抗卡策略」区可逐项覆盖。
  分档结果按 host 学习并持久化（`loadLearnedProfile`/`saveLearnedProfile`），下次进同站直接从最优起步。
- `useStallTracker.ts`：以 `<video>` 真实停顿（waiting/stalled）为地面真值反馈调参，排除 seek 和用户 pause。
- `useSegmentCache.ts`：模块级单例内存缓存，TTL 1 天 + 内存上限 LRU + seek 时批量 abort。
  只在「TTL 过期」或「切到别的视频」时清；跨组件卸载存活，但**刷新页面必然丢**（JS 堆机制）。
- `useM3u8.ts`：m3u8-parser 解析 + AES-128 密钥/IV（`keyIv` 为 null 时用媒体序列号 `sn` 推导）
- `useVideoDownload.ts`：分片并发拉取 → AES 解密 → ffmpeg.wasm 合并 MP4（core 从 unpkg 拉）

### URL 参数直链（地址栏双向同步）

参数：`url`（可重复，组成播放列表）、`urls`（`|` 或换行分隔）、`index`（起播第几个，0 基）、
`origin`、`referer`、`proxy=1`、`noref=1`、`manifestOnly=0|1`。

**入向** `parseQueryVideoParams()`（onMounted 调用，优先于 localStorage 恢复）：
- **关键坑**：视频地址自带 query（`?token=1&sign=2`）时未编码的 `&` 会被路由拆成独立参数，
  `route.query.url` 只能拿到 `sign` 之前的部分。所以从 `window.location.search` **原始串**手工解析，
  凡不在 `PAGE_QUERY_KEYS` 里的片段一律原样回写进最近的那个视频地址。
- 只做 percent 解码，**不把 `+` 当空格**（签名里常有裸 `+`，转空格直接 403）
- 地址自带参数名与本页参数重名时才需 `encodeURIComponent` 整串编码
- 传了任一策略参数会置 `manualStrategyOverride = true`，否则自动阶梯会把注入的 Origin/Referer 冲掉

**出向** `syncUrlToQuery()`：在 `playByIndex` / `clearPlaylist` / `handleLocalFiles` /
`onManualProxyChange` / `resetToAuto` 里调用，把当前播放列表 + 集数 + 手动策略写回地址栏。
- 用原生 `history.replaceState` 而非 `router.replace`——本页只读 `window.location.search`，
  不经 vue-router，避免 query 变化触发路由重解析，也不污染后退栈
- 本地文件是 `blob:` 地址，不可分享 → 清空 query 而不是写进去
- 只写手动策略；自动阶梯是引擎实时试探的，固化中间态反而让下次进来绕远
- 多个地址用 `urls=a|b` 省长度；超 2000 字符退化成只带当前这一集
- 入向的非规范写法（未编码的 `&`）会在出向被自动规范成 percent 编码

## 状态持久化

全部走 localStorage，无后端。key 一览：

| key | 用途 |
| --- | --- |
| `video-player-state` | 播放器全量状态（地址/播放列表/进度/音量/倍速/代理设置/HLS 配置/档位覆盖） |
| `video-player-site-rules` | 用户自定义站点规则 |
| `video-player-learned-profiles` | 按 host 学到的服务器档位 |
| `video-player-origin-history` / `-referer-history` | Origin/Referer 输入历史（下拉复用） |
| `json-format-settings` / `json-diff-settings` / `json-extract-settings` / `content-diff-settings` / `timestamp-settings` | 各页设置 |
| `json-extract-import` | json-format → json-extract 的跨页传值 |
| `utools-history-<page>` | `useHistory.ts` 通用历史：最多 50 条，单条 1MB，总量 256MB |

## 踩过的坑

- **CF Workers 无 `process`**：服务端代码判空后再动态 `import('undici')`，specifier 必须用变量 + `@vite-ignore` 包住，否则 Vite 会在 CF 构建时静态解析报错
- **`@ffmpeg/*` 必须 `optimizeDeps.exclude`**（已在 nuxt.config.ts）
- **206 Range 响应不可缓存**，见上
- **改连接策略必须重载视频**，否则 hls.js 还在用上次解析出的分片 URL，看起来「改了没生效」
- **`crossorigin="anonymous"`** 只对远程源加，本地 blob 文件要设 `undefined`
