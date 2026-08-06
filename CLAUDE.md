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
| `video-parse.vue` | `/video-parse` | 粘贴视频站播放页地址 → 解析整季选集的真实 m3u8 → 一键送进播放器，见下节 |
| `json-format.vue` | `/json-format` | 格式化 + 语法高亮 + 树形视图 + 智能解析（从任意文本里捞 JSON、递归去转义最多 3 层）+ 路径删除/撤销 |
| `json-diff.vue` | `/json-diff` | 两份 JSON 差异对比，可指定字段做数组匹配键，差异分组排序可配 |
| `json-extract.vue` | `/json-extract` | JQ 风格路径提取，输出每行一个 / JSON 数组 / 逗号分隔，可排序去重 |
| `content-diff.vue` | `/content-diff` | 文本集合运算：A-B / B-A / 交集 / 并集，分隔符可选 |
| `timestamp.vue` | `/timestamp` | 时间戳 ↔ 日期互转，多时区多格式 |

## 视频播放器（重点模块）

`pages/video-player.vue` + 8 个 composable + `server/api/proxy.ts`。核心难点是**跨域、防盗链、慢速源站**。

### 代理与防盗链

浏览器禁止 JS 设置 `Origin`/`Referer`（forbidden headers），所以必须绕服务端：

`GET /api/proxy?url=&origin=&referer=&noref=1&noseg=1`
- `noref=1` 伪装下载器：不发 Origin/Referer（很多源站不校验，不带头反而更快更稳）
- `noseg=1` m3u8 内分片 URL 不改写，让分片直连 CDN（更快、省服务器流量）
- m3u8 会被改写内部 URL；master/点播列表缓存 1 天，直播列表 `no-cache`
- 分片 200 响应缓存 1 天；**206 分块响应绝不缓存**（同 URL 不同 Range 混用会拼出损坏分片）
- Node 上动态加载 undici Agent 放宽 TLS、超时拉到 5 分钟；CF Workers 上降级原生 fetch
- `fetchWithHeaderProbe` 会并发探测「带头/不带头」哪种能过，结果按 host 缓存 30 分钟

页面侧有三层策略，优先级 **手动 > 站点规则 > 自动探测**：

1. **自动可达性探测**（`composables/useReachabilityProbe.ts`）：起播前用几个小请求把
   **manifest 轴**和**分片轴**各自的可达性实测出来，再决策。取代了早先「直连→失败重载→代理→失败重载→代理+防盗链」的线性盲试。
2. **站点规则**（`composables/videoSiteRules.ts`）：按 host 子串或 `/正则/` 匹配，内置 jisuzyv/xhscdn/huyall 三条，用户规则存 localStorage 且优先。
   注意：规则里只要写了 `useProxy`/`manifestOnly`/`disguiseAsDownloader`/`origin`/`referer` 任一字段就算「接管可达性」，会整站跳过探测——只想调并发就别写这些字段。
3. **手动**：用户改任一连接设置即置 `manualStrategyOverride`，引擎不再覆盖（改动必须 `loadVideo()` 重载——连接策略只在加载时生效）

### 为什么必须两轴分开

manifest 与分片经常不在同一个 host（实测：manifest 在 `bf.jisuziyuanbf.com:443`、分片在 `p.jisuts.com:999`），
CORS 头、防盗链、端口、证书都各自独立。三通道（`direct` / `disguise`=代理不发头 / `headers`=代理注入 Origin+Referer）
× 两轴，靠一条归一化规则收敛成 5 种有效组合：

| 清单 | 分片 | 典型场景 | refs |
| --- | --- | --- | --- |
| 直连 | 直连 | 全站 `ACAO: *` 无防盗链 | 全关 |
| 代理·伪装 | **直连** | 清单无 CORS / mixed content，分片 CDN 开放；或分片端口非标代理打不通 | `disguise=true, manifestOnly=true` |
| 代理·伪装 | 代理·伪装 | 两边都无 CORS，源站不校验防盗链 | `disguise=true, manifestOnly=false` |
| 代理·防盗链 | **直连** | 清单要 Referer，分片 CDN 开放 | `origin/referer, manifestOnly=true` |
| 代理·防盗链 | 代理·防盗链 | 全站防盗链 | `origin/referer, manifestOnly=false` |

归一化规则：**分片要代理 → manifest 必须走同一种代理**（分片 URL 的重写只发生在服务端 `rewriteM3u8`，
manifest 不过代理就没法把分片指向代理）；**分片可直连 → manifest 取自己最优的那条**，靠 `noseg=1` 保住分片直连。
故「manifest 直连 + 分片代理」不单独实现（归到全代理，只多一跳 manifest）。

**已知不支持的角落**：manifest 只能直连（服务端到该 host 不通）+ 分片只能代理（浏览器到该 host 不通）。
两个方向相反的不对称同时出现，`resolveConnConfig` 返回 null → 退回线性阶梯。要支持得再加一个「只代理分片」的 ref，暂不值得。

### 探测的几个关键约束（改之前先看）

- **直连探测绝不能加 `Range` 头**。跨域带自定义头会触发 CORS 预检 OPTIONS，很多 CDN 不处理 → 探测假阴性；
  而真实分片请求（`useHlsPrefetch` 里的 `fetch`）是不带自定义头的 simple request。探测必须与真实请求**完全同形**：
  裸 `fetch` + `referrerPolicy: 'no-referrer'`，拿到响应头立刻 `body.cancel()`。
- **`unknown`（超时）≠ `fail`**。慢 ≠ 不可达，超时判死会把慢源误判成要代理。`skip` = 没探（已有更优通道）。
- **mixed content 提前短路**：https 页面上的 `http://` 地址直连必被浏览器拦，不发请求直接判 fail。
- **AES key 折进分片轴**：`noseg=1` 时服务端只重写 `.m3u8`，key 留成直连地址由浏览器直接取，所以 key 跟分片同通道。
- **探测顺序有讲究**：manifest 先只探直连；代理通道慢得多（绕服务端回源，实测某些源 >10s），
  只在「直连不通」或「分片得走代理」时才补测。ncat 那个源靠这条从 12s 降到 1.5s。
- **两级超时**：单通道 8s + 整轮 12s 硬上限（探测阻塞起播，不能让多个超时叠加）。
- 结果按 host 存进 `video-player-learned-profiles` 的 `reach` 字段，TTL 30 分钟。
  首访阻塞探测（显示「正在探测连接方式…」），命中缓存则秒起播 + 后台静默复验，结论变了才重载一次
  （每 host 每会话只复验一次，否则「复验→重载→又命中刚写的缓存→又复验」会白跑）。
- **双通道自动开的判据**：`分片.直连 === ok && 分片.代理·伪装 === ok && 最终分片通道 === 直连`。
  分片必须走代理时直连 lane 必 403/CORS，开了等于一半连接白扔。实测生效时预取线程从 6 → 12。
- 线性阶梯（`applyReachabilityStep`，4 级）只留作「探测拿不到结论」（断网/全超时）的兜底。
  **每一级都必须把四个 ref 全写一遍**——漏写任何一个都会让上一级的残留值改变本级语义
  （典型：忘了关 `manifestOnly`，「全程代理」会悄悄变成「分片直连」）。

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

## 视频解析（/video-parse）

`pages/video-parse.vue` + `composables/videoParseRules.ts` + `composables/usePowSolver.ts` + `server/api/resolve.ts`。
把「网站播放页地址」变成「整季选集的真实 m3u8」，再拼成 `urls=a|b|c&index=N` 跳去 `/video-player`。

### 分工

- `videoParseRules.ts` — 规则表，pattern 语义与 `videoSiteRules.ts` 完全一致（`/正则/` 或 host 子串），
  内置 `ncat` 一条。规则只是四条正则：`sourceRe`（当前集地址）/ `lineRe`（线路标签）/
  `episodeGroupRe`（选集容器）/ `episodeRe`（组内单集）。加新站 = 加一条规则，不改代码。
- `server/api/resolve.ts` — 两步式接口。浏览器有 CORS，取第三方页面只能绕服务端。
- `usePowSolver.ts` — 浏览器侧算反爬的工作量证明。
- `server/utils/siteFetch.ts` — 抓网页用的 undici dispatcher（放宽 TLS + 支持 `HTTPS_PROXY`）。
  与 `proxy.ts` 里那份**不是同一个**：那份面向视频流、连接数和超时按分片下载调过，不要合并。

### 为什么 PoW 放前端算

ncat 系挂了 cdndefend：首访返回 **HTTP 850** + 挑战页，要求暴力找 nonce 使
`SHA1(c + nonce)` 的第 `n1`、`n1+1` 字节等于 `0xB0 0x0B`（`n1 = parseInt(c[0], 16)`），
再带 cookie `cdndefend_js_cookie = c + nonce` 重取。期望约 65536 次哈希。

**CF Workers 免费版每请求只有 10ms CPU，服务端硬算必超**。而挑战是纯 SHA1、不依赖 DOM 或
浏览器指纹，放前端完全等价（实测浏览器 ~55ms）。所以 `step=challenge` 只把常量丢给前端，
`step=extract` 拿前端算好的 cookie 重取。

`usePowSolver.ts` 内置同步 SHA1 而非 `crypto.subtle.digest`：后者是异步的，
6.5 万次 await 的微任务开销比哈希本身大一个量级。输入恒为「40 位常量 + 十进制 nonce」
（≤55 字节），永远单个 512 位分组，所以只实现了单块 SHA1。

### 几个实测结论（改之前先看）

- **挑战常量 `c` 是全站级的**：同站不同影片页拿到的完全一样，且数分钟内稳定 →
  一次 PoW 全站复用。服务端按 host 缓存 cookie，TTL 30 分钟（与 `proxy.ts` 的 `headerModeCache` 对齐）
- **线路标签与选集容器按出现顺序严格一一对应**，三个不同页面实测恒等（16/16、18/18、17/17）。
  且**全部线路的选集都渲染在同一页**（非当前线路 `display:none`），所以线路 × 集数表只需一次请求
- **不是所有线路都给直链**：如「4K」线路把 `playSource.src` 渲染成空串，地址由前端运行时另取。
  这类线路整条都取不到 → 先探第一集，拿不到就立刻收工并回 `lineUnsupported`，
  否则要白等完剩下几十集的请求才知道结果是空的
- **有些线路的地址带时效签名**（`?sign=…&timestamp=…`），会过期，UI 上要提示别收藏/分享
- 跳转 `/video-player` 时**不带** `proxy`/`noref`/`origin`/`referer`：这些会置 `manualStrategyOverride`，
  把可达性探测整个关掉。gsuus 系正是靠「manifest 先只探直连」从 12s 降到 1.5s 的
- 单次请求最多解析 40 集（CF 免费版单请求 50 subrequest 硬顶），超出用 `truncated` 回报，不静默截断

### 本地开发注意

若目标站点被 DNS 污染或需要代理才能访问，会出现「浏览器能打开、接口报 `fetch failed`」——
因为浏览器走系统代理而 Node 默认不走。起 dev 前设一下即可：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'   # 换成你本机代理端口
npm run dev
```

CF Pages 上没有这些变量，出口直连，不受影响。

## 状态持久化

全部走 localStorage，无后端。key 一览：

| key | 用途 |
| --- | --- |
| `video-player-state` | 播放器全量状态（地址/播放列表/进度/音量/倍速/代理设置/HLS 配置/档位覆盖） |
| `video-player-site-rules` | 用户自定义站点规则 |
| `video-parse-rules` | 用户自定义解析规则（`/video-parse`，与站点规则分开存，别混用） |
| `video-player-learned-profiles` | 按 host 学到的服务器档位 + 可达性探测结果（`reach`，TTL 30 分钟） |
| `video-player-origin-history` / `-referer-history` | Origin/Referer 输入历史（下拉复用） |
| `json-format-settings` / `json-diff-settings` / `json-extract-settings` / `content-diff-settings` / `timestamp-settings` | 各页设置 |
| `json-extract-import` | json-format → json-extract 的跨页传值 |
| `utools-history-<page>` | `useHistory.ts` 通用历史：最多 50 条，单条 1MB，总量 256MB |

## 踩过的坑

- **CF Workers 无 `process`**：服务端代码判空后再动态 `import('undici')`，specifier 必须用变量 + `@vite-ignore` 包住，否则 Vite 会在 CF 构建时静态解析报错
- **`@ffmpeg/*` 必须 `optimizeDeps.exclude`**（已在 nuxt.config.ts）
- **206 Range 响应不可缓存**，见上
- **改连接策略必须重载视频**，否则 hls.js 还在用上次解析出的分片 URL，看起来「改了没生效」
- **CF Workers 会静默吞掉非标端口**：`wrangler.json` 的 `compatibility_date` 必须 ≥ `2024-09-02`，
  否则线上 `fetch('https://host:999/x.ts')` 被降级成 `:443`，`/api/proxy` 拉这类分片必然失败，而本地 Node/undici 一切正常 —— 极难排查。
  实测 `p.jisuts.com:999` 与 `208.69.102.105:11306` 两个源都属这一类（它们的 `:443` 根本没监听）。
  **千万别顺手加 `compatibility_flags: ["allow_custom_ports"]`**：该 flag 自 2024-09-02 起已是默认值，
  日期达标后再显式声明会让 Pages 部署在**最后一步**失败（前面 build/上传全成功，只在 publish Function 时报
  `The compatibility flag allow_custom_ports became the default as of 2024-09-02 so does not need to be specified anymore`）。
  只改日期，不加 flag。
- **两个 compatibilityDate 是两回事，别混**：`nuxt.config.ts` 的 `compatibilityDate`（现为 `2024-07-01`）是
  Nitro 自己的特性门控，构建日志里打印的就是它（`preset: cloudflare-pages, compatibility date: 2024-07-01`）；
  真正决定 CF 运行时行为（含上面的端口问题）的是 `wrangler.json` 的 `compatibility_date`。
  看到日志里是 2024-07-01 不代表线上就是它，别据此改错文件
- **`crossorigin="anonymous"`** 只对远程源加，本地 blob 文件要设 `undefined`
