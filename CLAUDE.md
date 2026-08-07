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
composables/    跨页复用的处理引擎（PDF/GIF/TIFF/历史/解析）
composables/videoPlayer/   播放器这一页的全部逻辑模块，见「视频播放器」一节
components/     FileUpload（拖拽上传，播放器已不用，其余工具页仍在用）、ColorModeButton
components/videoPlayer/    播放器这一页的 UI 分块（自动导入名带 VideoPlayer 前缀）
utils/          前后端共用的纯函数（如 mediaUrl.ts 的「是不是 m3u8 清单」判据）
layouts/default.vue   侧边栏导航（新增页面需在此 + pages/index.vue 各登记一次）
server/api/proxy.ts   视频跨域/防盗链代理（也给解析链路取站点自己的 js/wasm/接口用）
server/api/resolve.ts 播放页解析接口，薄壳；站点策略在 server/parsers/ 下
server/parsers/       每站一个策略，见「视频解析」一节
```

新增工具页的落地点有三处，别漏：`pages/新页.vue`、`pages/index.vue` 的 `categories`、`layouts/default.vue` 的 `toolCategories`。

### 文件拆分约定

**单文件不超过 500 行**，超了就按功能模块拆。页面文件（`pages/*.vue`）只留装配：
建控制器 → `provide` → 接生命周期；逻辑进 `composables/<页面名>/`，UI 分块进 `components/<页面名>/`。
播放器（`/video-player`）是这个约定的样板，新页面长大了照它拆。

两个必须记得的配套动作：

- **`composables/` 的子目录要在 `nuxt.config.ts` 的 `imports.dirs` 里登记**。Nuxt 默认只扫
  `composables/` 顶层和 `composables/*/index.ts`，漏登记的表现是「一堆 xxx is not defined」。
- **别把数组常量和别的导出混在一个文件里**：unimport 的导出扫描踩过一次——
  `export const PLAYBACK_RATES = [...]` 后面紧跟的那个导出被静默漏掉，自动导入里查无此名，
  而 tsc 又能过（tsc 走的是真实 import）。展示常量单独放（见 `composables/videoPlayer/display.ts`），
  或者就近放进用它的那个组件。

## 工具清单

| 页面 | 路由 | 能力 |
| --- | --- | --- |
| `pdf-tools.vue` | `/pdf-tools` | 合并（可按页范围）/拆分/压缩/加删水印/提取页/旋转/删页/图片→PDF/Word↔PDF |
| `image-compress.vue` | `/image-compress` | 批量压缩，输出 JPEG/WebP/PNG/**PDF**，PNG 走 upng-js 调色板量化，支持 TIFF 输入 |
| `image-convert.vue` | `/image-convert` | 格式互转（含 SVG 输入），Canvas 实现 |
| `video-to-gif.vue` | `/video-to-gif` | 视频抽帧 → gif.js 编码，可选抖动算法/调色板（quantize）/帧率/裁剪 |
| `audio-convert.vue` | `/audio-convert` | WebAudio 解码 + OfflineAudioContext 重采样，采样率/位深可调 |
| `video-player.vue` | `/video-player` | M3U8/MP4 播放器，见下节（本项目最复杂的一页） |
| `video-parse.vue` | `/video-parse` | 粘贴视频站播放页地址 → 解析整季选集的真实 m3u8 → 一键送进播放器，见下节 |
| `json-format.vue` | `/json-format` | 格式化 + 语法高亮 + 树形视图 + 智能解析（从任意文本里捞 JSON、递归去转义最多 3 层）+ 路径删除/撤销 |
| `json-diff.vue` | `/json-diff` | 两份 JSON 差异对比，可指定字段做数组匹配键，差异分组排序可配 |
| `json-extract.vue` | `/json-extract` | JQ 风格路径提取，输出每行一个 / JSON 数组 / 逗号分隔，可排序去重 |
| `content-diff.vue` | `/content-diff` | 文本集合运算：A-B / B-A / 交集 / 并集，分隔符可选 |
| `timestamp.vue` | `/timestamp` | 时间戳 ↔ 日期互转，多时区多格式 |

## 视频播放器（重点模块）

核心难点是**跨域、防盗链、慢速源站**。

### 模块划分

`pages/video-player.vue` 只有装配（建控制器 → provide → 生命周期），逻辑全在 `composables/videoPlayer/`：

| 文件 | 负责 |
| --- | --- |
| `types.ts` | 跨模块共享的数据形状（`SavedState` / `HandoffPayload` / `HlsTuning` / query 参数名） |
| `display.ts` | 纯展示常量与格式化（倍速档位、`formatTime`） |
| `useVideoMediaState.ts` | **裸状态**：只有 ref，没有逻辑。存在的唯一目的是打断模块间依赖环 |
| `useVideoHandoff.ts` | 交接槽读写、剧名/集名、按需取址作业单（全部**按 URL 存**，见下） |
| `useVideoServerTier.ts` | 服务器档位（好/中/差）与抗卡参数覆盖 |
| `useVideoConnStrategy.ts` | 可达性探测 → 结论套用 / 线性阶梯兜底 / Origin-Referer 候选值与历史 |
| `useVideoPlaylistCtl.ts` | 播放列表、切集、进度记忆、刷新链接、按需取址 |
| `useVideoEngine.ts` | hls.js 生命周期、预取/缓存/卡顿三件套装配、加载超时、每秒心跳 |
| `useVideoAutoTune.ts` | 自愈调参环：自动分档 + 抗卡阶梯 + 生效倍速 + 按 host 记忆 |
| `useVideoEvents.ts` | `<video>` 事件回调 + 起播预缓冲 |
| `useVideoUiControls.ts` | 播放/进度条/音量/全屏/画中画/控制栏显隐/快捷键 |
| `useVideoDeepLink.ts` | 地址栏双向同步 |
| `useVideoPlayerController.ts` | **装配层**：接线 + 持久化 + 挂载/卸载 |
| `useVideoProxy.ts` / `useReachabilityProbe.ts` / `useHlsPrefetch.ts` / `useSegmentCache.ts` / `useStallTracker.ts` / `useM3u8.ts` / `useVideoDownload.ts` / `videoDiag.ts` | 底层引擎，见后续各节 |

UI 分块在 `components/videoPlayer/`：`SourceCard`（输入+连接策略+探测矩阵）、`PlaylistPanel`、
`Stage`（播放器+控制栏）、`HlsSettings`、`StatsPanel`、`PreloadSettings`、`Shortcuts`。
自动导入名带前缀，如 `<VideoPlayerStage />`。

**依赖方向是单向的**：`engine/events/controls → conn/tier/playlist → media/handoff`。
反向的需求（conn 要能重载视频、engine 心跳要跑自愈环）一律用**回调/钩子**：
`deps.reload`、`registerTickHook`、`registerDestroyHook`、`registerAutoPlayHook`。
所以不要在底层模块里 import 上层模块——会立刻转成循环依赖。

**子组件不传 props**，各自 `useVideoPlayerCtx()` 解构自己要的那几项（控制器把所有模块平铺成一层）。
因此**各模块返回的键名不能重复**，新增导出时注意。解构出来才能在模板里自动解包 ref、直接写 `v-model`。

`videoPlayer/useHlsPrefetch.ts` 目前 620 行，仍超 500 行约定——它是热路径且调参密集，暂未拆。

### 代理与防盗链

浏览器禁止 JS 设置 `Origin`/`Referer`（forbidden headers），所以必须绕服务端：

`GET /api/proxy?url=&origin=&referer=&noref=1&noseg=1`
- `noref=1` 伪装下载器：不发 Origin/Referer（很多源站不校验，不带头反而更快更稳）
- `noseg=1` m3u8 内分片 URL 不改写，让分片直连 CDN（更快、省服务器流量）
- m3u8 会被改写内部 URL；master/点播列表缓存 1 天，直播列表 `no-cache`
- 分片 200 响应缓存 1 天；**206 分块响应绝不缓存**（同 URL 不同 Range 混用会拼出损坏分片）
- Node 上动态加载 undici Agent 放宽 TLS、超时拉到 5 分钟；CF Workers 上降级原生 fetch
- `fetchWithHeaderProbe` 会并发探测「带头/不带头」哪种能过，结果按 host 缓存 30 分钟

**连接方式只有一个来源：自动可达性探测**（`composables/videoPlayer/useReachabilityProbe.ts`）。
起播前用几个小请求把 **manifest 轴**和**分片轴**各自的可达性实测出来再决策，
取代了早先「直连→失败重载→代理→失败重载→代理+防盗链」的线性盲试。

**「站点规则」整张表已删除**：`SiteRule` / `BUILTIN_RULES`（jisuzyv、xhscdn、huyall）/ `matchSiteRule` /
`ruleControlsReachability` / `loadUserSiteRules` / `localStorage` 的 `video-player-site-rules` 全部不复存在。
它是一堆写死的静态判断，而它想解决的每件事现在都有实测来源：
连接方式 → 可达性探测 + lane 熔断；并发 → `useHlsPrefetch` 的闭环控制；档位 → `classifyTier` + 按 host 学习。
留着它唯一的作用只剩「源站改了策略之后整站播不了，还看不出是被谁按住的」。
`composables/videoSiteRules.ts` 这个文件还在，但**只剩服务器档位预设与按 host 的学习档案**（文件名待改）。

**也没有手动模式了**（`manualStrategyOverride` 已整条删除）。原来「用户改任一连接设置就把引擎的手按住」
带来的问题是：探测覆盖不到的情况（分片轴没测到、双通道没证据）会被一个手动开关永久固化，
用户还看不出是自己按住的还是引擎判的。现在全部收敛进自动：

- **`originHint` / `refererHint`**：用户填的防盗链**候选值**，不是配置。喂给探测的 `headers` 通道，
  试得通就用、试不通照样降级到别的通道。与 `requestOrigin`（引擎最终生效值）**分开两个 ref**——
  合并成一个的话，探测判定直连可达时会顺手把用户辛苦找到的域名抹掉。
  UI 上用 `hintStatus` 标「已采用 / 未采用」，否则用户没法判断是自己填错了还是引擎压根没试。
  改动候选值必须作废该 host 的 `reach` 缓存（缓存只按 host 存、不含候选值，不清就没机会被试到）。
- **「代理 Manifest」「直连+代理双通道」改成只读状态显示**：它们本来就是 `resolveConnConfig` 每次算出来的，
  做成可点的复选框只会让人以为能覆盖，下次加载又被写回去。
- **`lane 熔断` 兜最后一道**（`useHlsPrefetch` 的 `markLaneFail`）：真实请求连续失败 3 次就停用那条 lane，
  双通道自动退回单通道。探测不可能覆盖所有情况，真实请求本身就是最后一次探测。
- **连接策略不再写进地址栏**：`origin/referer/proxy/noref/manifestOnly` 都不产出了（入向仍认
  `origin`/`referer` 当候选值，且这些 key **必须留在 `PAGE_QUERY_KEYS` 里**，
  否则老链接里的 `&origin=` 会被当成视频地址的一部分回写进 URL）。

### 为什么必须两轴分开

manifest 与分片经常不在同一个 host（实测：manifest 在 `bf.jisuziyuanbf.com:443`、分片在 `p.jisuts.com:999`），
CORS 头、防盗链、端口、证书都各自独立。四通道（`direct` / `disguise`=代理不发头 /
`headers`=代理注入源站自己的 Origin+Referer / `rootRef`=同上但注入**主域**）
× 两轴，靠一条归一化规则收敛成 6 种有效组合：

| 清单 | 分片 | 典型场景 | refs |
| --- | --- | --- | --- |
| 直连 | 直连 | 全站 `ACAO: *` 无防盗链 | 全关 |
| 代理·伪装 | **直连** | 清单无 CORS / mixed content，分片 CDN 开放；或分片端口非标代理打不通 | `disguise=true, manifestOnly=true` |
| 代理·伪装 | 代理·伪装 | 两边都无 CORS，源站不校验防盗链 | `disguise=true, manifestOnly=false` |
| 代理·防盗链 | **直连** | 清单要 Referer，分片 CDN 开放 | `origin/referer, manifestOnly=true` |
| 代理·防盗链 | 代理·防盗链 | 全站防盗链 | `origin/referer, manifestOnly=false` |
| 代理·防盗链·主域 | 同左 | 防盗链只认主域 | 同上，但 origin 取 `parentOrigin()` |

**`rootRef`（主域）这一档的由来**：`headers` 注入的是视频地址自己的 origin，可有些站点的防盗链只认主域——
播放页在 `ddys.ai`、视频在 `v3.ddys.ai`，注入三级域名照样 403，四条路里前三条全挂，手填 `https://ddys.ai` 立刻能播。
`parentOrigin()` 只剥一层子域（剥多了会命中 `co.uk` 这种公共后缀），IP 和二级域名直接返回空串。
它是压箱底的一档，只在前三条都不通时才探——多数站点认自己的 origin，平白多探一路只是白等一个 8s 超时。
用户显式填了 Origin 时不启用（那是明确指令，不该背着他换域名）。

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
  四条通道是串行降级的（直连+伪装并发 → 防盗链 → 主域），慢源上后面的通道会被整轮截止直接跳过（`expired()`）。
  这是有意的：宁可少探一路退回阶梯，也不能让首访干等半分钟。所以别为了「探全」去调大 `OVERALL_TIMEOUT`。
- 结果按 host 存进 `video-player-learned-profiles` 的 `reach` 字段，TTL 30 分钟。
  首访阻塞探测（显示「正在探测连接方式…」），命中缓存则秒起播 + 后台静默复验，结论变了才重载一次
  （每 host 每会话只复验一次，否则「复验→重载→又命中刚写的缓存→又复验」会白跑）。
- **双通道自动开的判据**：`分片.直连 === ok && 分片.代理·伪装 === ok && 最终分片通道 === 直连`。
  分片必须走代理时直连 lane 必 403/CORS，开了等于一半连接白扔。实测生效时预取线程从 6 → 12。
- 线性阶梯（`applyReachabilityStep`，5 级，末级同为主域防盗链）只留作「探测拿不到结论」（断网/全超时）的兜底。
  **每一级都必须把四个 ref 全写一遍**——漏写任何一个都会让上一级的残留值改变本级语义
  （典型：忘了关 `manifestOnly`，「全程代理」会悄悄变成「分片直连」）。

### 并发预取与抗卡

- `videoPlayer/useHlsPrefetch.ts`：自定义 hls.js `fLoader`，命中预取缓存即时返回；按缓冲健康度动态调并发。
  浏览器同 host 只给 6 条连接（`MAX_CONN`），所以有**双通道**——同一分片给出「直连 CDN」和「/api/proxy」两个 origin 的 URL，并发提到 ~12。
- **服务器档位** good/medium/bad（`SERVER_TIERS`）：一套抗卡参数（濒卡/吃紧阈值、安全系数、并发下限、对冲延迟、跳片超时、竞速上限）。
  由 `classifyTier` 自动分档（站点规则已删除，不再有「锁定档位」）；页面「抗卡策略」区可覆盖其中几项
  （`hedgeMs`/`maxRacers` 只留预设不开放覆盖：手调它们只是在换「多快开始浪费连接」，帮不上忙）。
  分档结果按 host 学习并持久化（`loadLearnedProfile`/`saveLearnedProfile`），下次进同站直接从最优起步。
- `videoPlayer/useStallTracker.ts`：以 `<video>` 真实停顿（waiting/stalled）为地面真值反馈调参，排除 seek 和用户 pause。
  **必须每次心跳都调一次 `tick()`（内含幂等 `bind()`）**：`loadVideo` 里 `videoKey++` 会重建 `<video>`，
  而 `videoEl` ref 要等 Vue 打完补丁才指向新元素——只在起播时 bind 一次会绑到已卸载的旧元素上，
  一个事件都收不到，表现是统计面板「卡顿恒 0 次 / 连续流畅恒 0s」，且从面板完全看不出是绑错了。
  另外「连续流畅」只能读响应式的 `smoothSecs`，**不能在模板里直接调 `getSmoothSecs()`**——
  普通函数不进依赖收集，模板只会显示首次渲染的那个值。
  **「卡顿中往前微跳」不能按 seek 处理**（`NUDGE_MAX_SEC`）：hls.js 的 gap controller 卡住时会
  nudge 播放头（`currentTime += 0.1`），`useVideoEvents.onWaiting` 还会主动跳过 <3s 的缓冲空洞，
  两者都触发 `seeking`。原来一律 `cancelStall()`，正在发生的那次卡顿被整段抹掉，
  表现是卡到肉眼可见、面板仍显示「卡顿 0 次 / 0.0s」（踩过）。现在停顿位置往前 ≤3.5s 的跳判为恢复动作：
  停顿继续记，等真正播起来才收尾。**微跳自带的那个 `timeupdate` 也要放过**（规范里 `timeupdate` 先于
  `seeked` 触发，位置确实前进了 0.1s 但画面没动），否则一次长卡顿会被从中间截成若干不到
  `MIN_STALL_MS` 的碎片，再被逐个滤掉，读数照样回到 0 次。
  事件之外还有一层**位置采样兜底**（`detectByPosition`，跟着心跳每秒比一次播放头）：
  `waiting` 并非每次卡顿都触发，而用户眼里的卡顿就是「画面不动」。起点要回填到上一拍
  （`beginStall(tickAt)`），否则每次都少记 1 秒。
- **缓冲健康区（`healthZone`）按「有效可播」（MSE + 预取缓存）分档，不是按 MSE 前向**。
  预取缓存里的分片由 `fLoader` 同步返回，不需要任何网络等待，所以它算真实可播；
  而 MSE 前向自己有天花板（`maxBufferLength` / 浏览器 MSE 配额），深缓存时会长期停在几十秒的平台上，
  那是稳态不是吃紧。按 MSE 分档踩过一次：有效可播 651s、真实卡顿 0 次仍判「吃紧」，
  降速守卫等不到 `healthy` 就永不解除，自动最佳倍速被死锁在 1x。**只有跳片才看 MSE**，它自己量（`skipSegment`）。
- **自动最佳倍速**（`useVideoAutoTune.applyEffectiveRate`）的上限是 `autoRateCap = max(2, desiredRate)`，
  **不是 `desiredRate` 本身**：后者默认 1，直接当上限会让「自动」永远只能取 1x，勾选框看着有效实际一步都迈不出去（踩过）。
  上限证据取「带宽模型」与「缓冲实况」中更宽松的一个——有效可播 ≥2×吃紧阈值且没在卡（`bufferRich`）
  就直接按 `autoRateCap` 走，因为带宽模型在预取吃饱、测速采样变稀之后会明显偏保守。
  提速另需 `healthZone === 'healthy'` + 连续流畅 ≥20s；降速只要目标持续低于当前 8s。
  **`bufferRich` 时免掉「连续流畅」这一条**：该计时器在暂停时恒为 0（`useStallTracker.onPause`），
  起播被浏览器拦截或用户手动暂停期间永远攒不够 20s，会把提速彻底锁死（踩过：健康 686s、
  最高流畅倍速 18.75x，倍速仍纹丝不动）。
  **调整幅度不设限，算出目标就一次到位**：`RATE_STEP = 0.25` 现在只用来把目标对齐到 0.25 的整数倍，
  不再当每次的步长上限——爬台阶从 1x 到 3x 要 8 次 × 25s ≈ 200 秒，慢到用户认定它没生效（踩过）。
  节流全部交给 25s 惰性期（`RATE_HOLD_MS`），它管的是「多久允许再调一次」——倍速一变就要重排预取节奏，
  不停微调比慢一点更难受。降速同理一次到位，慢慢往下挪只会让卡顿多持续几十秒。
  两个例外可以绕过惰性期：抗卡守卫（panic → `guardRateCeiling = 1`）立刻压回 1x；
  **用户动作**（勾开关 / 改倍速档位）走 nudge 通道**直接跳到目标值**，不等流畅时长——
  勾了要等 20s 才动第一步，用户只会认为开关坏了（踩过）。
  **nudge 额度必须按「兑现」清，不能设墙钟过期**：点击那一刻带宽模型可能还没采到样
  （`maxFluentRate = 0` → `target` 就是 1），nudge 分支根本走不到；旧实现给的 5s 额度一过就作废，
  之后只剩 0.25x/25s 的慢爬（1x→3x 要 200 秒），表现同样是「点了没反应」（踩过）。
- `videoPlayer/useSegmentCache.ts`：模块级单例内存缓存，TTL 1 天 + 内存上限 LRU + seek 时批量 abort。
  只在「TTL 过期」或「切到别的视频」时清；跨组件卸载存活，但**刷新页面必然丢**（JS 堆机制）。
  - **缓存里只可能有当前视频的分片**：`useCacheForVideo()` 在视频 URL 一变就整块 `clear()`。
    所以「清掉别的视频的缓存」是个不存在的需求，真正堆积的是**当前视频已经播过的分片**
    （原来要等 TTL 1 天或内存上限才淘汰）。
  - **`maxBufferSizeMB` 不能跟着别的缓冲项一起给大值**：它是这份 JS 缓存的 LRU 天花板，
    曾默认 3600（要堆到 3.6GB 才淘汰），长时间播放下 GC 压力足以让整个页面发卡。现默认 1024。
    注意**改默认值救不了老用户**：`video-player-state` 优先级高于默认，得点「重置默认」。
  - 清理由 `useHlsPrefetch.purgePlayedSegments()` 做（缓存模块只提供 `purgeCache(谓词)`，
    它不认识 hls 和播放头，反向 import 会立刻变成循环依赖）。判据是分片表的 `end` 对播放头，
    留 30s 回看余量；**拿不到分片表时必须直接返回**——此时无从判断谁已播，
    一刀切等于把前方预取也清了，表现是「点一下清理立刻开始卡」。
    每小时自动跑一次，挂在已有心跳上而不是另起定时器（天然「不播就不清」，也不用管卸载）。
- `videoPlayer/useM3u8.ts`：m3u8-parser 解析 + AES-128 密钥/IV（`keyIv` 为 null 时用媒体序列号 `sn` 推导）
- `videoPlayer/useVideoDownload.ts`：分片并发拉取 → AES 解密 → ffmpeg.wasm 合并 MP4（core 从 unpkg 拉）

### URL 参数直链（地址栏双向同步）

参数：`url`（可重复，组成播放列表）、`urls`（`|` 或换行分隔）、`index`（起播第几个，0 基）、
`origin`、`referer`、`proxy=1`、`noref=1`、`manifestOnly=0|1`、
`parseUrl` + `line`/`lineName` + `index`/`ep`（解析来的列表走这套，见下）、`handoff=1`。

**解析来的列表一律用 `?parseUrl=…&line=N&lineName=…&index=M&ep=…`**，链接里不带任何视频地址。

早先只有两种表达，都不能分享：`?handoff=1`（列表在本机 localStorage 里，别人打开一片空白）、
`urls=a|b|c`（几十集顶爆地址栏，而且解析出的地址不少带时效签名，隔几小时就是一堆死链）。
换成「从哪解析的」则链接短、永不过期——别人打开时播放器现场解析一遍，拿到的永远是新地址。

- **线路和集数各写两份：序号是位置，名字是身份**。源站增删线路、往中间插集（实测 ylsp 有
  「虚天战纪上/下」这种加塞）之后序号就指到别处了，而分享链接的寿命以天计。
  打开时**先按 `lineName`/`ep` 认，名字找不到才退回 `line`/`index`**。
  线路名对不上当前解析结果时会换条线路再解析一次（多一个来回，只在真漂了时发生）。
- **`index` 恒写**（哪怕是 0）：用户要能从链接上一眼看出这是第几集。
- **交接槽照写不误**：从 `/video-parse` 点进来、或本机刷新时，槽里就是同一份列表，
  直接用能省掉一次好几秒的解析。判断「是不是同一份」按 `pageUrl` + **线路名**比，
  光比序号会在源站增删线路后把另一条线路的列表错当成这一份用上。
- **槽里的 `index` 只在槽匹配时才能用**。不匹配还用它的话，分享链接（不带 index、本该从第 1 集起播）
  会跳到收链接的人本机上一部剧看到的集数，对方完全不知道为什么开在第 5 集（实测抓到过）。
- **解析那几秒页面上必须有东西**：Stage 是 `v-if="isVideoLoaded"` 的，它内部那个
  「正在获取播放地址」的遮罩此时根本没渲染，页面就是一片空白，用户只会以为链接坏了。
  所以 `pages/video-player.vue` 上单独有一张卡片（`isResolvingUrl && !isVideoLoaded`），
  文案走 `resolveStage`（「正在获取页面…」→「正在解析选集…」，反爬站点还会有校验那一段）。

**入向** `parseQueryVideoParams()`（onMounted 调用，优先于 localStorage 恢复）：
- **关键坑**：视频地址自带 query（`?token=1&sign=2`）时未编码的 `&` 会被路由拆成独立参数，
  `route.query.url` 只能拿到 `sign` 之前的部分。所以从 `window.location.search` **原始串**手工解析，
  凡不在 `PAGE_QUERY_KEYS` 里的片段一律原样回写进最近的那个视频地址。
- 只做 percent 解码，**不把 `+` 当空格**（签名里常有裸 `+`，转空格直接 403）
- 地址自带参数名与本页参数重名时才需 `encodeURIComponent` 整串编码
- `origin`/`referer` 收作**候选值**（`originHint`/`refererHint`）交给探测，不再强制生效；
  `proxy`/`noref`/`manifestOnly` 直接忽略——它们是引擎的中间态，固化下来只会让探测绕远。
  **但这五个 key 仍必须留在 `PAGE_QUERY_KEYS` 里**：不认它们的话，老链接里的 `&origin=…`
  会走「未知片段一律回写进视频地址」那条路，把参数拼进 URL 里，源站直接 404。

**出向** `syncUrlToQuery()`：在 `playByIndex` / `clearPlaylist` / `handleLocalFiles` 里调用，
把当前播放列表 + 集数写回地址栏。
- 用原生 `history.replaceState` 而非 `router.replace`——本页只读 `window.location.search`，
  不经 vue-router，避免 query 变化触发路由重解析，也不污染后退栈
- 播放器已移除本地文件（拖拽上传）功能：只放网络地址，`crossorigin` 恒为 `anonymous`
- **连接策略一概不写**：全部由可达性探测实时决定，写进链接只是把中间态带走，下次打开反而绕远
- 多个地址用 `urls=a|b` 省长度；超 2000 字符或按需取址时转存交接槽（`?handoff=1`）
- 入向的非规范写法（未编码的 `&`）会在出向被自动规范成 percent 编码
- **有 `playlistSource` 就一律写 `parseUrl` 那套**，上面这些只用于手工贴进来的地址

## 视频解析（/video-parse）

把「网站播放页地址」变成「整季选集的真实 m3u8」，再拼成 `urls=a|b|c&index=N` 跳去 `/video-player`。

### 分工（策略模式）

每个站点 = 一个 `SiteParser`。`server/api/resolve.ts` 只做四件事——**匹配站点 → 抓页 → 过反爬握手 →
把 HTML 交给策略**，站点差异全部收在 `server/parsers/` 下，接新站不用碰接口层。

```
server/parsers/
  types.ts               SiteParser / ParserContext / ChallengeHandler 接口
  utils.ts               各策略共用：absolutize / decodeEntities / innerTexts / parseTitle / pool …
  index.ts               注册表 + matchParser（用户规则 > 代码型站点 > 内置规则）
  htmlRule.ts            数据驱动策略：地址明文在页面里，靠正则抠（覆盖 ncat / ylsp / netflixgc + 全部用户自定义规则）
  challenges/cdndefend.ts 反爬握手：认出挑战页 + 抠常量（nonce 交前端算）
  sites/nbmovie.ts       4kvm，页面里没有地址，要另调签名接口
composables/
  videoParseRules.ts     规则表 + 代码型站点登记表 + 前后端共用的数据形状
  useClientResolve.ts    「取址作业单」的前端执行器注册表，按 kind 分发
  useHtmlSourceResolver.ts 执行器之一：按需逐集抓源站播放页取址（htmlRule 的 lazy 站点）
  useWasmUrlSigner.ts    执行器之一：跑站点自带 wasm 签接口地址，再从 JSON 里挑播放地址
  usePowSolver.ts        浏览器侧算反爬的工作量证明
  useResolvePlaylist.ts  完整流程（PoW → 分批续拉 / 作业单 → 合并），两个页面共用
```

**接新站两条路**：

1. 地址明文写在页面里 → 在 `BUILTIN_PARSE_RULES` 加一条规则，**不用写代码**。
   规则就四条正则：`sourceRe`（当前集地址）/ `lineRe`（线路标签）/ `episodeGroupRe`（选集容器）/
   `episodeRe`（组内单集），pattern 语义见 `matchParseSite`（`/正则/` 或 host 子串）。
   另有几个可选字段兜住各站差异：`sourceDecode`（`maccms` = 自适应剥 base64/percent）、
   `activeFlagRe`（当前线路的 class 标记，默认 `active`）、`titleRe`（`<title>` 是 SEO 长串时用）、
   `referer`/`origin`（防盗链认的域名与播放页不同时才写）、`lazy`（按需取址，见下）。
   **完整 SOP、可复制的 MacCMS 模板、逐条验证正则的脚本都在 skill `video-parse-site` 里**，加站先看它。
2. 要另调接口 / 要签名 / 要解密 → 在 `server/parsers/sites/` 加一个 `.ts` 导出 `SiteParser`，
   在 `server/parsers/index.ts` 的 `CODED_PARSERS` 注册，**并在 `videoParseRules.ts` 的
   `CODED_PARSE_SITES` 登记 pattern**——前端 `matchParseSite()` 要靠它判断「这个地址支持不支持」，
   而前端不能 import `server/` 下的代码，漏登记的表现是「能解析但输入框上不显示规则徽标」。

`server/utils/siteFetch.ts` — 抓网页用的 undici dispatcher（放宽 TLS + 支持 `HTTPS_PROXY`）。
与 `proxy.ts` 里那份**不是同一个**：那份面向视频流、连接数和超时按分片下载调过，不要合并
（两份都支持 `HTTPS_PROXY`，本地开发才不会「解析页出得来、取址全 502」）。

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
- 跳转 `/video-player` 时**带上源站播放页的 origin**（`playAll` 里的 `originOfPage`）当防盗链候选值：
  这类站点的防盗链认的是播放页域名，而视频常挂在毫不相干的 CDN 上
  （实测视频在 `vod1.maowushi.com`、防盗链认 `aeete.com`），播放器光看视频地址永远推不出来。
  只是候选值，探测仍从直连开始逐级降级，带上它不会平白多绕一层代理。
  **`proxy`/`noref`/`manifestOnly` 仍然不带**——那是引擎中间态，固化下来只会让探测绕远
  （gsuus 系正是靠「manifest 先只探直连」从 12s 降到 1.5s 的）
- **线路上的集数徽标不等于实际能解析的集数**：徽标是站点自报的 `source-item-num`，
  真实集数以解析出的 `episode-item` 锚点数为准（同一部片子各线路可能不同，实测 40 / 53 / 73 都有）

### 取址作业单（服务端做不完、必须由浏览器收尾的那类站点）

有些站点页面里根本没有播放地址，服务端只能给一张**作业单**（`ParseResult.clientTask`），
由浏览器补齐每集的 `videoUrl`。`useResolvePlaylist` 见到 `clientTask` 就走 `useClientResolve`
按 `kind` 分发，走完直接返回，**不走分批**。执行器有两种：

| kind | 用在 | 动机 |
| --- | --- | --- |
| `wasm-url-signer` | 4kvm | 服务端**做不了**（算法只存在于 wasm，签名还带时效） |
| `html-source` | 所有 `lazy: true` 的 htmlRule 站点 | 服务端**不该一次做完**（逐集抓页太重，见下节） |

`html-source` 的抠地址那步仍在服务端（`/api/resolve?only=1`，只取这一集、不解析选集），
浏览器只负责「什么时候抓」——正则和解码没必要在两边各写一份。

为什么 wasm 那步非得放浏览器（三条各自独立成立的理由）：

1. **CF Workers 禁止运行时实例化非打包的 wasm**，服务端跑不了；而 wasm 文件名带内容 hash
   （站点一更新就变），也没法预先打进产物里
2. **签名带时间戳，有效期很短**，服务端攒一批再用必然过期，只能现签现用
3. 顺带绕开「单请求 50 subrequest」硬顶：浏览器逐发打 `/api/proxy`，每发都是独立 Worker 调用，
   所以 185 集也不用像 `htmlRule` 那样分批

`WasmSignerTask` 是**纯声明**，不含站点专有逻辑：模块地址 / 函数名 / 每集实参 / 时间戳 meta 的 id /
怎么从接口 JSON 里挑地址（`JsonUrlPick`：`listPath`+`urlKey`+`skipFlags`+`rankKey`）全由服务端下发。
接一个同类站点只写服务端那半边，前端一行不用改。

### 按需取址（`clientTask.lazy`）

两类站点都要它，理由不同但做法完全一样：

- **4kvm：站点限流**，不许一次把整季取完——实测一口气取 185 集，打到第 186 发就开始回
  「请求过于频繁，请稍后再试」。站点自己就是「点一集才给一集」，我们照做。
- **htmlRule 站点（`ParseRule.lazy`）：逐集抓页太重**。这类站点的地址是一集一个子请求抠出来的，
  实测 ylsp 186 集要分 5 批上百个请求，而用户通常只看几集。开了之后解析阶段只花 1 个请求
  （当前集地址直接从本页拿，`useResolvePlaylist` 见 `videoUrl` 已有就不再取一遍）。
  **新加的 htmlRule 站点默认就该开**，除非集数很少且确实要一次拿到全部地址。

共同的约定：

- **解析页**只取传入的那一集（验证链路能通 + 给个能复制的真实地址），其余集不动
- **播放列表里存的是源站播放页地址占位**，不是真实地址；播放器 `playByIndex` 切到哪集，
  `resolveLazyUrl` 才现取哪集。整条链路一部剧只发 2（wasm）/ 1（html-source）+ 1/集 发请求
- **占位地址不替换成取到的真实地址**：真实地址带时效签名，存下来下次进来就是死链；
  而占位地址永远有效，还天然当了进度和集名的稳定键
- 因此**进度不能按 `videoUrl` 存**（每次现取的地址都不同，等于每次都查不到）。
  `progressKey()` 统一取 `playlist[currentIndex]`，普通列表下它就等于 `videoUrl`，行为不变
- **必须走交接槽**，再短的列表也不能写进 `urls=`：query 里只有占位地址，
  没有随槽带过去的作业单，分享出去就是一堆打不开的链接。`syncUrlToQuery` 对 lazy 强制 `?handoff=1`
- 作业单里的令牌是源站按次渲染的、会过期 → 取址失败时用 `playlistSource` 重解析一次拿新作业单再试，
  **只重试一次**（真失效和真限流的表现一样，无限重试只会把限流坐实）
- **源站的 `/play/<slug>` 会轮换**：实测隔一阵旧 slug 直接 404。所以过期的交接列表最终会整份失效，
  这时只能回解析页重来——这是站点行为，兜不住

**我们只加载并调用站点公开导出的函数，不复刻它的算法**——所以站点换签名方案时前端不用动，
只要页面上还能读到模块地址就继续能用。

### 4kvm / ziziys（nbmovie 系）实测结论

**同一套程序换皮开的站，一条 pattern 兜住全部**：ziziys.org 与 4kvm.org 页面结构逐字节同构
（`<link id="wasm-cfg">` + `userlink` + `handleEpisodeClick` + `<meta id="nb-plt">`），
parser 里所有地址都从 `ctx.pageUrl` 的 origin 现拼、没有写死的域名，所以接同族站点
**只需往两处 pattern 各加一个域名，解析逻辑一行不用改**：
`server/parsers/sites/nbmovie.ts` 的 `PATTERN` 和 `videoParseRules.ts` 的 `CODED_PARSE_SITES`。
两边必须同步——只改服务端的表现是「能解析但输入框不显示规则徽标」（前端不能 import `server/`）。


- **只有一条线路**，站点自报的线路名是内部标识（`alists`），没展示价值 → 单线路时显示「默认线路」
- 页面结构：`<a href="/play/xxx" @click.prevent="handleEpisodeClick($el.getAttribute('href'), 'dataid', 线路, 集号)">`，
  真实地址要拿 `dataid` 调 `/video/play?p=&v=&q=&s=&t=&k=`，整串 query 由
  `<link id="wasm-cfg">` 指向的 wasm 的 `build_play_url(dataid, slug, quality, userlink)` 生成
- **`k`（令牌）来自页面里的 `userlink:'…'`，匿名访问也有**，不需要登录、不需要 cookie。
  少了它接口回 401「请提供访问令牌」，签名过期也是 401（两种 401 的文案不同，排查时看 body）
- **wasm 会读 `<meta id="nb-plt">` 的 content 当时间戳**（站点原页面由内联脚本写 `Date.now()`）。
  我们的页面得自己补一个，且**每次签名前都要刷新**——整批共用一个旧时间戳会让后面几集签出过期地址
- 胶水 js 走 blob 再 `import`（而不是直接 import 代理地址）：动态 import 按响应 MIME 校验，
  代理回来的 content-type 不一定过得来；wasm 同理传 **ArrayBuffer** 而不是 URL，避开
  `instantiateStreaming` 的 `application/wasm` 校验
- **别用剥标签的办法从选集锚点里取集名**：开标签的 `x-effect` 属性里有 `=>`，`<[^>]*>` 会在属性中间断开，
  把剩下的属性当正文吐出来（踩过）。取锚点里最后一个 `<span>` 的文本才对（`innerTexts`）
- 档位表里 4K 那条 `locked: true` 且 `url` 是 `"1"` 这种占位值 → 必须按 `locked` + 协议头两道筛
- **同一部片子里各集的地址不一定同源**：实测大部分是 `oss.douyinbit.com` 的 m3u8，
  最新一集却是天翼云盘的**预签名 mp4**（带 `Expires`/`Signature`）。所以「带时效签名」的提示
  要连 `expires`/`signature` 一起判，不能只看 `sign`/`timestamp`
- **一次取满整季必被限流**：186 发之后接口开始回「请求过于频繁，请稍后再试」，
  所以这个站点必须 `lazy: true`，见上一节

### MacCMS 系（ylsp / netflixgc）实测结论

国内影视站的绝大多数是苹果 CMS，地址都在内联的 `player_aaaa={...}` 的 `url` 字段里，
接这类站基本只是复制一条规则改四个正则。**加站的完整 SOP 在 skill `video-parse-site`**。

- **`encrypt` 决定编码但不要按它分支**：0=明文 / 1=percent / 2=base64 套 percent，
  同一站点不同线路的值可以不同（实测 ylsp=0、netflixgc=2）。`sourceDecode: 'maccms'`
  自适应剥到 http 开头为止，层数硬性封在 2 层——地址本身常带 percent 编码的签名参数，
  无限循环解码会把它越解越坏。明文那档还要先还原 JSON 里的 `\/` 转义
- **当前线路的 class 标记各站不同**（ylsp `active`、netflixgc `on`），故有 `activeFlagRe`。
  认错不报错，只是默认落到第一条线路——用户点开的那条被悄悄换掉，从界面上看不出来
- **选集容器不能用 `</div>` 收尾**：ylsp 当前集的 `<a>` 里嵌了 `<div class="playon">`，
  非贪婪匹配断在那，整条线路只剩 1 集（踩过）。改用 `</div></div></div>`，
  或挑个不嵌套的标签当边界（netflixgc 用 `<ul>…</ul>`）
- **防盗链认的域名可以跟播放页毫无关系，而且不该写死**：netflixgc.net 的视频挂在
  `v.fengbao10.com` 这类无关 CDN 上，防盗链认的是站点自己的播放器页 `cjbfq.netflixgc.tv`，
  播放页域名和主域都是 403，四条探测通道全挂。
  这个域名**别写死**——用 `ParseRule.playerOrigin` 从站点自己的配置里现取：
  MacCMS 把它放在 `/static/js/playerconfig.js` 的 `parse` 字段里，每条线路（`player_aaaa.from`）一份。
  注意**抓回来的 HTML 里没有那个 iframe**（是 JS 运行时注入的），只能去配置文件里找。
  结果按 host 缓存 30 分钟——按需取址时每一集都要用它，不缓存等于每集多一个子请求。
  规则里的 `origin`/`referer` 退化成配置文件取不到时的兜底。
  验证「到底是动态取到还是走了兜底」的办法：把兜底临时改成假值，看返回值变不变
- **`<title>` 可能是一长串 SEO 文案**（netflixgc 实测 90+ 字符），兜底削站名削不干净，
  而这个值会顶掉播放器标题栏 → 用 `titleRe` 从书名号里取
- 两站都开 `lazy: true`：ylsp 实测 7 条线路 × 186 集，不开要分 5 批上百个请求

### kpkuang（看片狂人）实测结论 — 「每条线路的防盗链域名都不一样」

苹果 CMS 的 FED 模板，但**不走 `player_aaaa`**，地址在播放器 iframe 的属性上，
所以催生了两个新的规则字段。接同类站点（FED 模板 + 第三方解析线路）直接照抄这条。

- **地址在 `data-play`，是「3 个随机字符 + base64」**：前缀每次刷新都变，直接 atob 只得到乱码。
  `sourceDecode: 'base64-scan'` → `decodeScannedBase64` **不写死剥 3 个**，
  从偏移 0 逐个试到解出 http 开头为止（前缀长度对站点来说改成 2 或 4 的成本是 0）
- **防盗链域名每条线路一份，且就写在播放页的 `data-pars` 上**（那是这条线路用的解析播放器前缀）：
  睿映线认 `soul.flixfiend.top`、电影天堂线认 `vip.dyttzyplay.com`、芒果线认 `jx.xmflv.com`，
  而视频分别挂在 `cdn.ryplay11.com` / `vip.dytt-tvs.com` 之类毫不相干的 CDN 上。
  于是 `playerOrigin.url` 改成**可选**：不给 url 就对当前页 HTML 跑正则，不发请求。
  这种**绝不能按 host 缓存**（配置文件那种才能）——一缓存就把上一条线路的域名喂给下一条，
  表现是切线路后开始 403。
- **`?line=N` 指到别的线路时，必须按探测页重算一遍域名**：`base` 里那份是从 `ctx.pageUrl` 抠的，
  它属于用户传进来那条线路，跟 N 无关。不重算就把别人的域名带出去，第一集直接 403
- **26 条线路里有 4 条给的是第三方站点的播放页而不是直链**（芒果线给 `www.mgtv.com/b/…`、
  「爱奇艺-VIP解析」给 `www.iqiyi.com/v_…`、超清 AB/BY/EV 给 `abyssplayer.com/…`）。
  它们是合法 http 地址，不筛掉就一路喂进播放器黑屏 → `sourceMediaOnly: true`，
  当 `lineUnsupported` 报出来。**这类线路做不到**：真实地址由第三方解析服务
  （虾米解析 `jx.xmflv.com` 等）在浏览器里用混淆过的 JS 现算，页面上没有、
  也没有可调的公开接口（试过 `api.php`/`jx.php` 都 404），跨域 iframe 又读不到里面的东西。
  于是补了 `ParseResult.lineUnsupportedReason`——原来的固定文案说的是 ncat 4K 线那种
  「页面把地址留空」，用在这里会让人以为是我们的正则写坏了（实测被问过）
- **内嵌这类播放器会撞上「反内嵌」自检，而且每家一套**（提示都提 Sandbox，
  别当成防盗链或我们的规则问题去追）。两条线路实测到的两种，对应 iframe 上多给的两个 token：
  - **超清EV线（ezplayer，`gms.ezplayer.me`）探的是 sandbox 属性本身，跟广告无关**：
    `assets/index-*.js` 里 `if (window.top === window) return; try { document.domain = document.domain }
    catch (e) { if (e.toString().includes('sandboxed')) … }`——沙箱文档里这句必抛 SecurityError，
    一抛就报 `Opss! Sandboxed our player is not allowed`。
    **这种没有 token 可解**：规范里的「sandboxed document.domain flag」只要挂了 `sandbox` 就必然置位，
    而 `allow-document-domain` **压根不是合法 token**（合法的只有 allow-scripts / allow-same-origin /
    allow-forms / allow-popups / allow-popups-to-escape-sandbox / allow-modals / allow-downloads /
    allow-presentation / allow-orientation-lock / allow-pointer-lock / allow-top-navigation*），
    非法 token 被静默忽略，改完现象跟没改一模一样——**别再往加 flag 的方向试**。
    唯一出路是整个摘掉 `sandbox` 属性。于是做成「限制广告」开关（`embedSandbox`，
    存 `video-parse-embed-sandbox`）——**默认关**：挂着 sandbox 能挡广告的顶层跳转，
    但会让一部分线路彻底播不了，而这一整块 UI 的存在意义就是「能播」，
    所以默认让位给可用性，把选择权摆在旁边（开关而不是一次性确认弹窗：它是个能来回切的状态）。
    换线路**不复位**，那是用户偏好不是线路状态。
    iframe 的 `:key` 必须带上这个档位：**sandbox 是文档创建时定死的**，光 patch 属性不重建 iframe 毫无效果。
    追这类问题别猜 flag：把它的 bundle 拉下来搜 `Sandbox`，检测函数就在旁边
  - **超清AB线（abyssplayer）要的是真广告**：点遮罩触发 `window.open(广告页)`，
    失败计数到 2 就 `document.write` 掉播放器，报
    `Due to certain reasons (AdBlock/Sandbox), ads are not being displayed`。给 **`allow-popups`** 能过，
    但**用户装了拦截插件照样过不了**（弹窗域名被拦 → `window.open` 返回 null），这个兜不住
  - 两者都**不给 `allow-popups-to-escape-sandbox`**（弹出窗继承同一套限制，落地页的二次跳转/
    自动下载仍被关着），也**不给 `allow-top-navigation*`**——那一项才是最恶心的：
    点一下播放整页被劫走，用户只会以为是本站跳的
- **内嵌线路的选集不能在取址期间互相按住**：取址那一发要打源站、常要好几秒，
  原来 `:disabled` 把非当前集全禁掉，表现是「整排突然置灰点不动」，从界面上看不出是在等谁（实测被问过）。
  改成自增 `embedSeq` 认领结果，后点的作废先点的——连失败 toast 一起丢，
  那是上一次点击的事，弹出来只会误导
- 选集容器**必须从 `fed-play-item` 起锚**：页面上另有两个空的 `<ul class="fed-part-rows">`
  （选集区前后各一个），直接匹配这个 ul 会多出两组、整张线路×集数表错位一位。
  且 class 后面不能收在 `"` 上——超清 AB/BY/EV 三条线的这个 ul 带了 `style` 属性（会漏 3 组）
- active 标记是 `uk-active`，且在**外层 `<li>`** 上而不是 `<a>` 上，所以 `lineRe` 捕获的是 li 的 class
- 实测 26 条线路 × 最多 71 集（各线路集数不等：71 / 32 / 31 / 26 / 21 都有），开 `lazy: true`

### 刷新链接（就地重新解析）

部分线路给的是带签名的地址（`?sign=…&timestamp=…`），过一阵会失效，表现为播着播着 403。
播放列表上的「刷新链接」按钮用交接槽里的 `source`（源页面地址 + 线路序号）原地重解析并替换，不用回解析页。

完整解析流程（工作量证明 + 分批续拉 + cookie 复用）抽在 `composables/useResolvePlaylist.ts`，
`/video-parse` 和播放器共用同一份——两处各写一份必然漂移，尤其是分批合并那段，漏一轮会静默少几集。

刷新是**整份替换**：源站新增的集会进列表，所有地址都换成新解析出的。

反馈必须说清「变了什么」，不能只报「已刷新 N 集」——那等于没说。
做法是刷新前后按「集名 → 地址」建对照表，算出 `changed`/`added`/`removed` 三个数报给用户；
三个都是 0 就明确告知「链接没有变化」。Toast 会消失，所以标题栏还常驻一个「已于 HH:MM 刷新」。

刷新时几个要点：
- **当前这集地址没变就不要重载**：正播着呢，无谓重载纯属打断（`curChanged` 判断）
- **按集名认当前集，不按下标**：重解析后集数可能变，下标会错位
- **播放进度是按 URL 存的**，地址一换就查不到 → 先把 `currentTime` 搬到新地址的 `savedProgress` 上，
  后面 `loadVideo` 里的 `getSavedProgress` 才能原位续播
- 只需重载当前这一集；其余集的新地址进列表即可，切过去时自然生效

### 分批解析（长剧）

单请求最多解析 40 集（`MAX_EPISODES`）——CF 免费版单请求 50 subrequest 硬顶，留出主页面那一发和余量。
**超出的不截断，用 `offset` 分批**：接口返回 `batchFrom` / `batchTo` / `remaining`，
前端拿到 `remaining > 0` 就带 `offset=batchTo` 继续拉下一批，把地址按下标合并进已有结构。
每批是一次独立请求，各自的 subrequest 预算互不叠加，所以多少集都能解析完（前端 20 轮上限兜底）。

「该线路不给直链」的探测只在第一批做（`offset === 0`）：后续批次已经知道线路是好的，不必再多花一个来回。
探到不给直链时要把 `remaining` 归零，否则前端会继续去拉注定为空的后续批次。

**解析未完成时禁用播放按钮**——长剧分多批拉，中途点「播放全部」只会把已解析的那部分带过去
（表现为「明明有 73 集，跳过去只有 40 集」）。

### 长播放列表交接槽

几十集的地址拼进 query 会顶爆地址栏（部分浏览器 2000 字符上界，硬刷新还要过 CF 的请求头上限）。
早先 video-parse 是截成 31 集的窗口、video-player 是退化成只带当前一集——两边都在偷偷丢集数。

现改走 **localStorage 交接槽**（key `video-player-handoff`，槽由 `video-player.vue` 持有，任何页面都能当生产者）：

- 载荷 `{ urls, names, title, source, lazy, index, at }`，TTL 1 天（防止半个月前的残留列表被翻出来）
- `title` 是剧名，播放器用它顶掉「播放器」「播放列表」这两个泛标题
- `source` 是 `{ pageUrl, line }`，即解析来源。有它播放列表才显示「刷新链接」按钮
- `lazy` 是按需取址的作业单（见上一节）。有它时 `urls` 里装的是**源站播放页地址占位**，
  作业单必须跟着列表一起交接，漏了就一集都播不了
- 长列表：video-parse 整份写槽 + 跳 `?handoff=1`；video-player 的 `syncUrlToQuery` 超长时也写槽并把地址栏收敛成 `?handoff=1`
  （比原来退化成单集更好：刷新后整个列表还在，因为 query 优先级高于 savedState）
- 短列表：地址仍走 `urls=`（这样的链接能直接分享，交接槽是本机存储分享不了），
  但**集名照样写槽**；video-player 在「槽里的 urls 与 query 解析出的完全一致」时才取用其中的 `names`
- `names` 解决的是：长剧每一集的地址都叫 `index.m3u8`，播放列表光看 URL 全是重复项、认不出第几集。
  `getVideoName` 优先查 `playlistNames`，查不到才退回从 URL 猜文件名
- **`playlistNames` 按 URL 存（`Record<url, name>`），不要改成按下标存的数组**：
  按下标要跟 `playlist` 严格对齐，每一处重新赋值 `playlist` 都得记着同步清理，漏一处就串名。
  这里踩过一次——`onMounted` 加载 query 地址走的是 `parseAndLoad`，而 `parseAndLoad` 里的
  「清掉上一份集名」正好把刚从交接槽读出的名字冲没了，表现为播放列表还是一排 `index.m3u8`。
  按 URL 存则天然对齐，残留条目只是查不中，无害，也不需要任何清理逻辑
- 集名不进 `video-player-state`：刷新时靠 `?handoff=1` 重新从槽里读回来

### URL 参数双向同步（/video-parse）

参数：`url`（播放页地址）、`line`（线路序号，0 基）。做法与 video-player 同源，包括那个坑：
播放页地址自带 query 时未编码的 `&` 会被拆成独立参数，所以从原始 `window.location.search` 手工解析，
不在 `PAGE_QUERY_KEYS` 里的片段原样回写进地址。

- 出向在解析成功和失败后都调用（失败也写，刷新能直接重试同一地址）
- `line` 只在 `result.pageUrl === 当前输入` 时才写——否则换片子/解析失败时会把上一次残留的线路号
  写进新地址，分享出去直接跳到一条不相干的线路
- **`window.history.replaceState` 必须写全 `window.`**：本组件有个叫 `history` 的 ref（解析历史），
  会遮蔽全局 `history`，直接写 `history.replaceState` 会报 `is not a function`

### 本地开发注意

若目标站点被 DNS 污染或需要代理才能访问，会出现「浏览器能打开、接口报 `fetch failed`」——
因为浏览器走系统代理而 Node 默认不走。起 dev 前设一下即可：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 MEDIA_NO_PROXY=1 npm run dev
```

**`MEDIA_NO_PROXY=1` 很关键**：`HTTPS_PROXY` 会同时作用于 `siteFetch.ts`（抓解析页）和 `api/proxy.ts`
（转发视频流），而**视频流跟着走代理往往适得其反**——出口 IP 一变很多 CDN 直接 403。
实测 `vip.ffzy-play10.com` 的分片：本机直连 200，经本地代理出口 403，**与 Referer 完全无关**
（带不带、带哪个域名都一样）。这种 403 极难归因：页面上看到的是「所有分片红一片」，
探测矩阵还显示某条代理通道可达，非常容易误判成防盗链或连接策略的问题——追了三轮才定位到出口 IP。
所以 `api/proxy.ts` 单独认 `MEDIA_NO_PROXY=1`（媒体流直连）和 `MEDIA_HTTPS_PROXY`（媒体流单独指定代理）。

CF Pages 上没有这些变量，出口直连，不受影响。

## 状态持久化

全部走 localStorage，无后端。key 一览：

| key | 用途 |
| --- | --- |
| `video-player-state` | 播放器全量状态（地址/播放列表/进度/音量/倍速/代理设置/HLS 配置/档位覆盖） |
| `video-parse-rules` | 用户自定义解析规则（`/video-parse`） |
| `video-parse-embed-sandbox` | 内嵌播放器是否挂 sandbox（「限制广告」开关，默认关） |
| `video-player-learned-profiles` | 按 host 学到的服务器档位 + 可达性探测结果（`reach`，TTL 30 分钟） |
| `video-player-handoff` | 长播放列表交接槽 `{ urls, names, title, source, lazy, index, at }`，TTL 1 天，`/video-parse` → `/video-player` 传值 |
| `video-player-origin-history` / `-referer-history` | Origin/Referer 输入历史（下拉复用） |
| `json-format-settings` / `json-diff-settings` / `json-extract-settings` / `content-diff-settings` / `timestamp-settings` | 各页设置 |
| `json-extract-import` | json-format → json-extract 的跨页传值 |
| `utools-history-<page>` | `useHistory.ts` 通用历史：最多 50 条，单条 1MB，总量 256MB |

## 踩过的坑

- **CF Workers 无 `process`**：服务端代码判空后再动态 `import('undici')`，specifier 必须用变量 + `@vite-ignore` 包住，否则 Vite 会在 CF 构建时静态解析报错
- **`@ffmpeg/*` 必须 `optimizeDeps.exclude`**（已在 nuxt.config.ts）
- **206 Range 响应不可缓存**，见上
- **`/api/proxy` 遇到上游非 2xx 必须原样透传状态码，绝不能进 m3u8 改写**。
  漏了这条的表现极其隐蔽（实测 `vip.ffzy-play10.com`）：源站回 403 + 一页 HTML，而请求的是 `.m3u8`，
  于是这页 HTML 被 `rewriteM3u8` 逐行当成相对 URI 拼上 baseUrl，最后以
  **200 + `application/vnd.apple.mpegurl`** 返回。连锁反应是：
  ① 可达性探测的 `fetchM3u8Manifest` 不报错 → 该通道判 `ok`（假阳性）；
  ② 但解析出 0 个分片 → `segmentUrl` 为空 → **分片轴整轮跳过、四格全 `skip`**；
  ③ 结论只好让分片跟随清单，选中一条实际 403 的通道，播放器满屏红。
  「分片轴全 skip 而清单显示可达」这个现象追了三轮才定位到这里。
  第二道防线在 `loadManifest`：**解析不出任何分片就判 `fail`**，别的源回 200 垃圾时也能兜住。
- **判断「是不是 m3u8 清单」绝不能用 `url.includes('.m3u8')`**，一律走 `utils/mediaUrl.ts` 的 `isM3u8Url()`。
  有的站点把 `.m3u8` 当**目录名**：`https://cdn/video/xxx/20241110HVeUlTF2index.m3u8/0000000.ts`
  （实测 `feikuai.in` → `p.bvvvvvvvvv1f.com` 这条链路）。全串匹配会把 ts 分片判成清单，两处同时坏掉：
  ① `/api/proxy` 对二进制分片走 `response.text()`，回一堆乱码 + `application/vnd.apple.mpegurl`；
  ② `noseg=1` 失效，分片被逐个改写成代理地址，分片直连的优化全丢。
  表现是**页面反复闪动、「已缓冲」一直涨但永远播不了**，而可达性探测每一路都是 200，从探测结果完全看不出问题。
  判据是「看路径最后一段的扩展名」，不是全串搜索。
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
