# utools — 开发工具箱

纯前端（`ssr: false`）的在线工具集合，Nuxt 3 + Nuxt UI，部署在 Cloudflare Pages。
除「视频代理 / 解析」两个服务端接口外，所有处理都在浏览器里做，不上传用户文件。

## 启动（本地开发）

**固定用这条命令，端口固定 3000，代理必须带**：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 MEDIA_NO_PROXY=1 npm run dev
```

- **`HTTPS_PROXY` 不带就解析不了**：目标站点多被 DNS 污染，浏览器走系统代理而 Node 不走，
  表现是「浏览器能打开、接口报 `fetch failed`」。端口按本机代理软件改（常见 7897 / 7890）。
- **`MEDIA_NO_PROXY=1` 让视频流直连**（只有解析抓页走代理）。视频流跟着走代理常适得其反：
  出口 IP 一变很多 CDN 直接 403。实测 `vip.ffzy-play10.com` 的分片本机直连 200、经代理 403，
  **与 Referer 无关**。这种 403 极难归因（页面上是「分片红一片」，探测矩阵却显示代理通道可达），追了三轮才定位到。
- 视频流确实需要代理时改用 `MEDIA_HTTPS_PROXY=http://127.0.0.1:7897`（替代 `MEDIA_NO_PROXY`）。
- CF Pages 上没有这些变量，出口直连，不受影响。

端口被占时先杀掉旧进程再起，别换端口——`http://localhost:3000` 是固定约定。

其它命令：`npm run build`（构建）、`npm run generate`（静态产物）、`npm run deploy`（generate + wrangler 部署）。
仓库默认不带 `node_modules`，验证类型/构建先 `npm install`；未装依赖时 IDE 报「找不到模块 hls.js」属预期噪音。

## 技术栈与约定

- **Nuxt 3.15**（SPA）+ **@nuxt/ui 2.x**；Tailwind 锁 `3.4.17`，暗色用 `dark:`，`colorMode.preference: 'light'`
- **Nitro preset `cloudflare-pages`** → 服务端代码不能静态 `import` 任何 `node:*` / Node 专属包
- 图标一律 `i-heroicons-xxx`；页面 = 文件路由；composables 自动导入
- 界面文案中文；**注释写「为什么」不写「做什么」**，保持现有较高密度
- 重依赖一律**动态 import**（`jspdf`/`upng-js`/`hls.js`/`@ffmpeg/*`/`pdfjs-dist`/`quantize`）

### 目录

```
pages/          12 个工具页，一页一工具
composables/    跨页复用引擎；composables/videoPlayer/ 是播放器全部逻辑
components/     公共组件；components/videoPlayer/ 是播放器 UI 分块
utils/          前后端共用纯函数（mediaUrl.ts 的 isM3u8Url 等）
layouts/default.vue   侧边栏导航
server/api/proxy.ts   视频跨域/防盗链代理（解析链路取站点 js/wasm/接口也用它）
server/api/resolve.ts 播放页解析接口（薄壳，站点策略在 server/parsers/）
```

新增工具页要改三处，别漏：`pages/新页.vue`、`pages/index.vue` 的 `categories`、`layouts/default.vue` 的 `toolCategories`。

### 文件拆分

**单文件不超过 500 行**。页面文件只留装配（建控制器 → `provide` → 接生命周期），
逻辑进 `composables/<页面名>/`，UI 进 `components/<页面名>/`。播放器是样板。

两个配套动作：

- **`composables/` 的子目录要在 `nuxt.config.ts` 的 `imports.dirs` 里登记**（Nuxt 只扫顶层和 `*/index.ts`），
  漏登记的表现是「一堆 xxx is not defined」
- **别把数组常量和别的导出混在一个文件里**：unimport 扫描踩过一次——`export const PLAYBACK_RATES = [...]`
  后面紧跟的导出被静默漏掉，自动导入查无此名而 tsc 能过（tsc 走真实 import）。展示常量单独放（见 `videoPlayer/display.ts`）

## 工具清单

| 路由 | 能力 |
| --- | --- |
| `/pdf-tools` | 合并/拆分/压缩/水印/提取页/旋转/删页/图片→PDF/Word↔PDF |
| `/image-compress` | 批量压缩 → JPEG/WebP/PNG/PDF，PNG 走 upng-js 量化，支持 TIFF 输入 |
| `/image-convert` | 格式互转（含 SVG 输入），Canvas 实现 |
| `/video-to-gif` | 抽帧 → gif.js，可选抖动/调色板/帧率/裁剪 |
| `/audio-convert` | WebAudio 解码 + OfflineAudioContext 重采样 |
| `/video-player` | M3U8/MP4 播放器，见下节（最复杂的一页） |
| `/video-parse` | 播放页地址 → 整季选集 m3u8 → 送进播放器 |
| `/json-format` | 格式化 + 高亮 + 树形 + 智能解析（递归去转义 ≤3 层）+ 路径删除/撤销 |
| `/json-diff` | JSON 差异对比，可指定数组匹配键 |
| `/json-extract` | JQ 风格路径提取 |
| `/content-diff` | 文本集合运算 A-B / B-A / 交集 / 并集 |
| `/timestamp` | 时间戳 ↔ 日期，多时区多格式 |

## 视频播放器

核心难点：**跨域、防盗链、慢速源站、内存**。

### 模块

| 文件（`composables/videoPlayer/`） | 负责 |
| --- | --- |
| `types.ts` | 共享数据形状（`SavedState`/`HandoffPayload`/`HlsTuning`/query key）+ `migrateHlsTuning` |
| `display.ts` | 展示常量与格式化 |
| `useVideoMediaState.ts` | **裸状态**：只有 ref，存在目的是打断依赖环 |
| `useVideoHandoff.ts` | 交接槽、剧名/集名、按需取址作业单（全部按 URL 存） |
| `useVideoServerTier.ts` | 服务器档位与抗卡参数覆盖 |
| `useVideoConnStrategy.ts` | 可达性探测结论套用 / 线性阶梯兜底 / Origin-Referer 候选值 |
| `useVideoPlaylistCtl.ts` | 播放列表、切集、进度记忆、刷新链接、按需取址 |
| `useVideoEngine.ts` | hls.js 生命周期、三件套装配、加载超时、每秒心跳、可见性处理 |
| `useVideoAutoTune.ts` | 自愈调参环：自动分档 + 抗卡阶梯 + 生效倍速 + 按 host 记忆 |
| `useVideoEvents.ts` / `useVideoUiControls.ts` / `useVideoDeepLink.ts` | 事件 / 交互快捷键 / 地址栏同步 |
| `useVideoGestures.ts` | 画面手势：单击/双击/长按/滑动/锁定（建在 controls 之上，见下） |
| `useVideoPlayerController.ts` | **装配层**：接线 + 持久化 + 挂载卸载 |
| `useReachabilityProbe.ts` / `useHlsPrefetch.ts` / `useSegmentCache.ts` / `useStallTracker.ts` / `useM3u8.ts` / `useVideoDownload.ts` / `useVideoProxy.ts` / `videoDiag.ts` | 底层引擎 |

UI 分块：`SourceCard` / `PlaylistPanel` / `Stage` / `SettingsMenu` / `ConnSettings` / `HlsSettings` /
`StatsPanel` / `PreloadSettings` / `Shortcuts` / `CollapseCard`。

**页面只有三样东西是常显的：输入框、播放器、选集**。其余全在下方 `CollapseCard` 里**默认折叠**
（摊开会把播放器和选集挤出屏幕，手机上要滑三屏才看得到第 2 集）：

- 看片当下才改的（自动全屏 / 自动最佳倍速 / 跳过片头片尾）→ 控制栏的齿轮菜单 `SettingsMenu`，手不用离开画面。
  它浮在黑画面上，**不能用 UCheckbox/UInput**（亮色主题压在黑底上一片糊），用原生控件自己配色
- 排查问题才看的（连接策略 / 探测矩阵 / HLS 配置 / 预加载 / 快捷键）→ 折叠区。
  连接那块的开合复用 `showAdvancedProxy`，播放器标题栏的策略徽标点一下就掀开它（一个 ref 两处用）
- 折叠区里的组件**不要自带 `UCard`**：`CollapseCard` 自己就是卡片，套两层会出现卡中卡

**依赖方向单向**：`gestures → engine/events/controls → conn/tier/playlist → media/handoff`。反向需求一律用回调
（`deps.reload`、`registerTickHook`、`registerDestroyHook`、`registerAutoPlayHook`）——
在底层 import 上层会立刻循环依赖。

**子组件不传 props**，各自 `useVideoPlayerCtx()` 解构。因此**各模块返回的键名不能重复**。

`useHlsPrefetch.ts` 超 500 行未拆（热路径且调参密集）。

### 代理与防盗链

浏览器禁止 JS 设 `Origin`/`Referer`，必须绕服务端：`GET /api/proxy?url=&origin=&referer=&noref=1&noseg=1`

- `noref=1` 伪装下载器（不发头往往更快更稳）；`noseg=1` 分片 URL 不改写、直连 CDN
- m3u8 改写内部 URL；点播列表缓存 1 天、直播 `no-cache`；分片 200 缓存 1 天，**206 绝不缓存**
- Node 上动态加载 undici Agent（放宽 TLS、超时 5 分钟），CF Workers 降级原生 fetch
- `fetchWithHeaderProbe` 并发探「带头/不带头」，结果按 host 缓存 30 分钟

**连接方式只有一个来源：自动可达性探测**（`useReachabilityProbe.ts`）。起播前实测 manifest 轴与分片轴各自可达性。

**「站点规则」整张表已删**（`SiteRule`/`BUILTIN_RULES`/`matchSiteRule`/`video-player-site-rules` 全不存在）。
它想解决的事现在都有实测来源：连接方式→探测+lane 熔断；并发→闭环控制；档位→`classifyTier`+按 host 学习。
`composables/videoSiteRules.ts` 还在，但只剩档位预设与学习档案（文件名待改）。

**也没有手动模式**（`manualStrategyOverride` 已删）。原来「改任一连接设置就按住引擎」会让探测覆盖不到的情况被永久固化，
用户还看不出是谁按的。现在全部收敛进自动：

- **`originHint`/`refererHint` 是候选值不是配置**，喂给探测的 `headers` 通道，试不通照样降级。
  与 `requestOrigin`（最终生效值）**分开两个 ref**——合并会让「判定直连可达」时抹掉用户辛苦找到的域名。
  UI 用 `hintStatus` 标「已采用/未采用」。改候选值必须作废该 host 的 `reach` 缓存（缓存只按 host 存）。
- **「代理 Manifest」「双通道」是只读状态显示**：它们是 `resolveConnConfig` 算出来的，做成可点的只会让人以为能覆盖
- **lane 熔断兜底**（`markLaneFail`）：真实请求连续失败 3 次停用该 lane，双通道退回单通道
- **连接策略不写进地址栏**（入向仍认 `origin`/`referer` 当候选值）

### 两轴分开与 6 种组合

manifest 与分片常不在同一 host（实测 manifest 在 `bf.jisuziyuanbf.com:443`、分片在 `p.jisuts.com:999`），
CORS/防盗链/端口/证书各自独立。四通道（`direct` / `disguise`=代理不发头 / `headers`=注入源站 origin+referer /
`rootRef`=注入主域）× 两轴，靠归一化收敛成 6 种：

| 清单 | 分片 | 场景 | refs |
| --- | --- | --- | --- |
| 直连 | 直连 | 全站 ACAO:* 无防盗链 | 全关 |
| 代理·伪装 | 直连 | 清单无 CORS / mixed content，分片 CDN 开放 | `disguise, manifestOnly` |
| 代理·伪装 | 代理·伪装 | 两边都无 CORS，不校验防盗链 | `disguise` |
| 代理·防盗链 | 直连 | 清单要 Referer，分片开放 | `origin/referer, manifestOnly` |
| 代理·防盗链 | 代理·防盗链 | 全站防盗链 | `origin/referer` |
| 代理·防盗链·主域 | 同左 | 防盗链只认主域 | 同上 + `parentOrigin()` |

**`rootRef` 的由来**：有些站点防盗链只认主域——播放页 `ddys.ai`、视频 `v3.ddys.ai`，注入三级域名照样 403，
手填 `https://ddys.ai` 立刻能播。`parentOrigin()` 只剥一层子域（剥多了命中 `co.uk` 这类公共后缀），
IP 与二级域名返回空串。它是压箱底的一档，只在前三条都不通时才探（否则白等一个 8s 超时）；用户显式填了 Origin 时不启用。

**归一化**：分片要代理 → manifest 必须走同一种代理（分片 URL 重写只发生在服务端 `rewriteM3u8`）；
分片可直连 → manifest 取自己最优的那条，靠 `noseg=1` 保住直连。故「manifest 直连 + 分片代理」不实现。

**已知不支持**：manifest 只能直连 + 分片只能代理（两个方向相反的不对称同时出现）→ `resolveConnConfig` 返回 null → 退回线性阶梯。

### 探测的关键约束（改之前先看）

- **直连探测绝不能加 `Range` 头**：会触发 CORS 预检，很多 CDN 不处理 → 假阴性。探测必须与真实请求**完全同形**：
  裸 `fetch` + `referrerPolicy: 'no-referrer'`，拿到响应头立刻 `body.cancel()`
- **`unknown`（超时）≠ `fail`**：慢 ≠ 不可达。`skip` = 没探（已有更优通道）
- **mixed content 提前短路**：https 页上的 `http://` 直连必被拦，不发请求直接判 fail
- **AES key 折进分片轴**：`noseg=1` 时 key 留成直连地址，跟分片同通道
- **探测顺序**：manifest 先只探直连；代理通道慢得多（实测某些源 >10s），只在「直连不通」或「分片得走代理」时补测。
  ncat 那个源靠这条从 12s 降到 1.5s
- **两级超时**：单通道 8s + 整轮 12s 硬上限。四通道串行降级，慢源上后面的会被整轮截止跳过——这是有意的，
  **别为了「探全」调大 `OVERALL_TIMEOUT`**
- 结果按 host 存进 `video-player-learned-profiles` 的 `reach`，TTL 30 分钟。首访阻塞探测，命中缓存则秒起播 +
  后台静默复验（每 host 每会话只复验一次，否则会「复验→重载→又命中→又复验」）
- **双通道自动开的判据**：`分片.直连 === ok && 分片.代理·伪装 === ok && 最终分片通道 === 直连`。
  分片必须走代理时直连 lane 必 403，开了等于一半连接白扔。实测生效时预取线程 6 → 12
- 线性阶梯（`applyReachabilityStep`，5 级）只作「探测拿不到结论」的兜底。**每级必须把四个 ref 全写一遍**，
  漏写会让上一级残留值改变本级语义（典型：忘了关 `manifestOnly`，「全程代理」悄悄变成「分片直连」）

### 并发预取与抗卡

- `useHlsPrefetch.ts`：自定义 hls.js `fLoader`，命中预取缓存即时返回，按缓冲健康度动态调并发。
  浏览器同 host 只给 6 条连接，所以有**双通道**（同一分片给出直连与代理两个 origin，并发提到 ~12）
- **服务器档位** good/medium/bad（`SERVER_TIERS`）：濒卡/吃紧阈值、安全系数、并发下限、对冲延迟、跳片超时、竞速上限。
  `classifyTier` 自动分档，按 host 学习并持久化。`hedgeMs`/`maxRacers` 只留预设不开放覆盖（手调只是在换「多快开始浪费连接」）
- **缓冲健康区按「有效可播」（MSE + 预取缓存）分档，不是按 MSE 前向**。预取缓存由 `fLoader` 同步返回、不需网络等待；
  而 MSE 前向有天花板，深缓存时长期停在几十秒平台，那是稳态不是吃紧。踩过：有效可播 651s、卡顿 0 次仍判「吃紧」，
  降速守卫永不解除，自动倍速被死锁在 1x。**只有跳片才看 MSE**（`skipSegment` 自己量）

#### 卡顿记录（`useStallTracker.ts`）

以 `<video>` 真实停顿为地面真值，排除 seek 和用户 pause。

- **必须每次心跳调 `tick()`**（内含幂等 `bind()`）：`loadVideo` 里 `videoKey++` 会重建 `<video>`，
  只在起播时 bind 会绑到已卸载的旧元素，一个事件都收不到——表现是「卡顿恒 0 次 / 连续流畅恒 0s」
- 「连续流畅」只能读响应式的 `smoothSecs`，**模板里不能直接调 `getSmoothSecs()`**（普通函数不进依赖收集）
- **「卡顿中往前微跳」不能按 seek 处理**（`NUDGE_MAX_SEC`）：hls.js gap controller 会 nudge、`onWaiting` 会跳空洞，
  都触发 `seeking`。原来一律 `cancelStall()`，正在发生的卡顿被整段抹掉（卡到肉眼可见仍显示 0 次）。
  现在停顿位置往前 ≤3.5s 判为恢复动作。**微跳自带的 `timeupdate` 也要放过**，否则长卡顿被截成碎片再被逐个滤掉
- 事件之外还有**位置采样兜底**（`detectByPosition`，每秒比一次播放头）：`waiting` 并非每次卡顿都触发。
  起点要回填到上一拍，否则每次少记 1 秒

#### 自动最佳倍速（`useVideoAutoTune.applyEffectiveRate`）

- 上限是 `autoRateCap = max(2, desiredRate)`，**不是 `desiredRate`**——后者默认 1，直接当上限会让「自动」永远只能取 1x（踩过）
- 上限证据取「带宽模型」与「缓冲实况」中更宽松的：有效可播 ≥2×吃紧阈值且没在卡（`bufferRich`）就直接按 `autoRateCap`，
  因为带宽模型在预取吃饱后明显偏保守
- 提速另需 `healthZone === 'healthy'` + 连续流畅 ≥20s；降速只要目标持续低于当前 8s。
  **`bufferRich` 时免掉「连续流畅」**：该计时器暂停时恒为 0，起播被拦截或手动暂停期间永远攒不够 20s，会把提速锁死
  （踩过：健康 686s、最高流畅 18.75x，倍速纹丝不动）
- **算出目标一次到位，不设调整幅度上限**：`RATE_STEP = 0.25` 只用来对齐到 0.25 的整数倍。
  爬台阶从 1x 到 3x 要 8 次 × 25s ≈ 200 秒，慢到用户认定没生效（踩过）。节流交给 25s 惰性期 `RATE_HOLD_MS`
- 两个例外绕过惰性期：抗卡守卫（panic → `guardRateCeiling = 1`）；**用户动作**走 nudge 通道直接跳到目标值。
  **nudge 额度必须按「兑现」清，不能设墙钟过期**——点击那刻带宽模型可能还没采样（`maxFluentRate = 0`），
  旧实现给 5s 额度一过就作废，表现同样是「点了没反应」（踩过）

#### 内存（`useSegmentCache.ts`）

模块级单例，TTL 1 天 + LRU + seek 时批量 abort。跨组件卸载存活，但**刷新页面必然丢**（JS 堆机制）。

- **缓存里只可能有当前视频的分片**：`useCacheForVideo()` 在 URL 一变就整块 `clear()`。
  所以「清掉别的视频的缓存」是不存在的需求，真正堆积的是**当前视频已播过的分片**
- **预读深度与内存上限都不能一味给大**（两项曾都是 3600，是偶发「整个浏览器像卡死」的根因）：
  `maxBufferLength` 是 `effectivePrefetchTarget()` 的直接来源，3600 = 预读到一小时之后，1080p 3Mbps 堆出 1GB+；
  `maxBufferSizeMB` 是 LRU 天花板。现默认 600s / 1024MB。抗卡真正吃紧的是「濒卡 <30s」那段，
  缓 10 分钟与缓 1 小时对流畅度差别几乎为零，内存却差 5 倍
- **改默认值救不了老用户**（`video-player-state` 优先级更高）→ `types.ts` 的 `migrateHlsTuning` 做一次性迁移，
  **只认旧默认值 3600 精确匹配**，不做区间钳制（用户手填的数字是明确意图，悄悄改更糟）
- **后台标签页是浏览器内存回收的首选对象** → `visibilitychange → hidden` 时立刻 `purgePlayedSegments()`。
  否则几百 MB 跟着进后台，回来整体换页、主线程整段阻塞——症状是「浏览器像卡死，再切一次才好」，**只在播久了才偶现**
- 清理由 `useHlsPrefetch.purgePlayedSegments()` 做（缓存模块只提供 `purgeCache(谓词)`，它不认识 hls 和播放头，
  反向 import 立刻循环依赖）。判据是分片表的 `end` 对播放头，留 30s 回看余量；
  **拿不到分片表必须直接返回**——无从判断谁已播，一刀切会把前方预取也清掉，表现是「点一下清理立刻开始卡」。
  每小时自动跑一次，挂在已有心跳上（天然「不播就不清」，不用管卸载）

#### 切标签页相关的三个独立问题（别混）

1. **切回来卡一下 → 心跳被节流**：整个预取引擎挂在 1 秒心跳上，后台期间播放照常消耗缓存、补片却几乎停了。
   而并发是每拍 +1 慢慢爬的，**再切一次就好**（缓存已填回去）是该问题的特征现象；全屏没事同理（始终前台）。
   修法 `useVideoEngine.onVisibilityChange`：回前台立刻跑一拍闭环 + `primePrefetch()`。
   **必须先调 `stall.resetSampler()`**，否则 `tickAt` 还停在切走前，播放头恰好没动时会把整段后台时间回填成假卡顿，
   自愈环还会据此把倍速压回 1x
2. **残影/黑屏（音频与 `currentTime` 正常）→ 不是我们的问题**：浏览器把视频画在独立硬件 overlay 平面，
   切标签后那层没被重画（Chrome + 独显常见）。`forceRecomposite()` 在回前台改 `transform` 再撤销替用户做「再切一次」。
   **别用 `display:none`**——那会让 `<video>` 卸掉解码器再重建，真的会黑一下。
   根治在浏览器侧：去掉 `--ignore-gpu-blocklist`（它绕过针对驱动 bug 的保护），必要时 `--disable-direct-composition-video-overlays`
3. **整个浏览器僵住几秒 → 多半是系统级内存压力**，不是本项目。用 PowerShell 查（按私有内存而非 WorkingSet，
   后者会重复计入共享页）；提交内存接近上限时 Windows 会持续做内存压缩，任何程序都会随机僵住

判读工具：统计面板的**掉帧**（`getVideoPlaybackQuality()`）——缓冲读数照不出解码侧问题。
缓冲健康但掉帧涨 = 解码/GPU/倍速；缓冲空但掉帧不涨 = 网络/预取；切回来时一次性猛涨 = 换页/GC。

### 手势与移动端（`useVideoGestures.ts`）

鼠标与触摸走**同一套 Pointer Events**（`mousedown` 那套在触摸端不保证补发 move，只有「点一下能跳、拖不动」）。
一次 `pointerdown` 要在四种意图里判：点击 / 双击 / 长按 / 拖拽。

| 手势 | 行为 |
| --- | --- |
| 单击 | 只切控制栏显隐，**不播放/暂停**（想看一眼进度必然误触暂停） |
| 双击左右 30% | ∓5s，落点画水波纹（不给反馈的话「跳了」和「没点到」长得一样） |
| 双击中间 | 触摸：播放/暂停；鼠标：全屏（桌面双击全屏是肌肉记忆，换掉代价更大） |
| 长按右半屏 400ms | 临时 2x，松手回到闭环倍速。左半屏不给（那是「按住想看清画面」的位置） |
| 横滑 | 拖进度，松手才 seek；整宽映射 `min(duration, 600s)`，按比例映射长片 1px≈10s 根本对不准 |
| 竖滑 | **只在全屏内**：右音量、左亮度（CSS filter）。非全屏抢走垂直方向 = 页面滚不动了 |
| 锁定 | 屏蔽手势 + 控制栏 + **快捷键**，锁定态下点画面只让解锁键露 3s |

- `touch-action`：全屏 `none`、非全屏 `pan-y`。不设的话浏览器把横滑当滚动起手式，pointermove 直接被 cancel
- **长按倍速不写进 `playbackRate`**：那是自愈环算出来的稳态值，被临时值污染的话松手后闭环会以为用户改了倍速。
  只改 `<video>` 元素本身，`autoTune.setRate` 每次把叠加重新贴上去
- **`isLocked` 放在裸状态里**：快捷键在 controls 里，而 controls 是手势层的下游，反向 import 就成环
- 控制栏等自带交互的区域挂 `data-no-gesture`，手势层见到就整个不参与判定
- 单击必须等双击窗口（280ms）过完才执行，否则每次双击都先闪一下控制栏
- **触摸抬手后浏览器会补发一整套兼容鼠标事件**（`mousemove`/`mousedown`/`click`），与真实鼠标长得一模一样，
  只能按「刚刚有过触摸」滤（`onMouseMove` 里的 900ms 窗口）。不滤的话补发的 `mousemove` 会把控制栏顶成显示态，
  紧接着 280ms 的延迟单击再取反，表现是**弹出来 0.3 秒就收回**——一开始误以为是自动收起时间太短，
  调 3s→5s 毫无作用。同理单击的目标态要取「**按下那一刻**」的相反值，而不是定时器烧到时再取反
- 自动收起 5s（触摸端没有「移动鼠标续命」这回事），控制栏上任何指针动作都重新计时（`keepControlsAlive`）；
  **倍速菜单开着时不收**——菜单是控制栏的子元素，一收连菜单一起没，表现是「点开倍速还没选就没了」
- **进全屏时手机上锁横屏**（`screen.orientation.lock`）：竖屏全屏只是把 16:9 钉在屏幕中间，黑边比不全屏还大。
  必须等 `requestFullscreen` 兑现后再调（非全屏文档不允许），桌面/iOS 上直接 reject，吞掉即可。
  Esc / 系统手势退出不走 `toggleFullscreen`，解锁要挂在 `fullscreenchange` 上。
  iOS Safari 不给容器全屏 → 退到 `videoEl.webkitEnterFullscreen()`

### 自动全屏在手机上必须「挂起 + 补兑现」

手机浏览器要求**用户激活**才准 `requestFullscreen`，页面加载完自动调**必被拒**。
原来直接调 + `catch(console.log)`，于是这个开关在安卓上从来没生效过，界面上还看不出是被谁拒的。
现在 `onCanPlay` 只登记意图（`pendingAutoFullscreen`），由 controls 试；试不成就挂着，
用户第一次碰播放器（`togglePlay` / 手势层的 `pointerdown`）时 `consumeAutoFullscreen()` 补上。
用户自己退出全屏要把意图清掉，否则下一次点画面又被拽进去。

同理**自动播放也可能被拦**，所以暂停态的中央播放键要常驻且**整块可点**——
只让那枚 80px 的圆可点的话，手机上瞄不准，表现就是「点了没反应」。

### 切集必须上门闩（踩过：15 集点下一集直接落到 30 集）

切一集是**异步**的（按需取址一发请求 + 重建 hls.js），而这期间旧的 `<video>` 还在原地播、
`timeupdate` 照常每秒四次。「跳过片尾」正挂在 timeupdate 上判，条件在整个切集过程中一直成立
→ `playNext` 被连着调十几次，每次 +1 集。安卓上实测从第 15 集一路跑到第 30 集，
用户看到的却是「跳过片尾没生效」——因为落点完全不相干。

两道闩都要留：`playByIndex` 里的 `switching`（顺带挡住手快连点两下「下一集」），
和 `useVideoEvents` 里每集一次的 `outroFired`（`loadedmetadata` 时复位）。

**进度记忆不能记进片尾区**（同一个坑的另一半）：`skipOutro=90` 时进度会被存成 `duration-90`，
下次进这集恢复到那儿，**当场满足跳片尾判据被弹到下一集，这集永远看不成**
（踩过：看过 22 集后回头看 21 集，21 播完自动进 22，又立刻被弹到 23）。
`saveCurrentProgress` 越过 `duration - max(5, skipOutro)` 就**删记录**（视作看完，下次从头播）；
`onLoadedMetadata` 里再兜一道，把老版本留下的片尾区记录就地作废。

### 其它

- `useM3u8.ts`：m3u8-parser + AES-128 密钥/IV（`keyIv` 为 null 时用媒体序列号 `sn` 推导）
- `useVideoDownload.ts`：分片并发拉取 → AES 解密 → ffmpeg.wasm 合并 MP4（core 从 unpkg 拉）

### URL 参数直链

参数：`url`（可重复）、`urls`（`|` 分隔）、`index`、`origin`、`referer`、`proxy=1`、`noref=1`、`manifestOnly`、
`parseUrl` + `line`/`lineName` + `ep`、`handoff=1`。

**解析来的列表一律用 `?parseUrl=…&line=N&lineName=…&index=M&ep=…`**，链接里不带视频地址。
早先两种表达都不能分享：`?handoff=1`（列表在本机 localStorage）、`urls=a|b|c`（顶爆地址栏且带时效签名会死链）。

- **线路和集数各写两份：序号是位置，名字是身份**。源站增删线路/插集后序号就指到别处（实测 ylsp 有「上/下」加塞）。
  打开时**先按 `lineName`/`ep` 认，找不到才退回 `line`/`index`**
- **`index` 恒写**（哪怕 0），用户要能一眼看出第几集
- 交接槽照写：判断「是不是同一份」按 `pageUrl` + **线路名**（光比序号会把另一条线路的列表错当成这份）
- **槽里的 `index` 只在槽匹配时才能用**：否则分享链接会跳到收链接的人本机上一部剧的集数（实测抓到过）
- **解析那几秒页面上必须有东西**：Stage 是 `v-if="isVideoLoaded"`，它内部的遮罩此时没渲染，页面一片空白。
  所以 `pages/video-player.vue` 上单独有一张卡片，文案走 `resolveStage`

**入向** `parseQueryVideoParams()`（onMounted 调，优先于 localStorage）：

- **关键坑**：视频地址自带 query 时未编码的 `&` 会被路由拆成独立参数 → 从 `window.location.search` **原始串**手工解析，
  不在 `PAGE_QUERY_KEYS` 里的片段原样回写进最近的视频地址
- 只做 percent 解码，**不把 `+` 当空格**（签名里常有裸 `+`，转空格直接 403）
- `origin`/`referer` 收作候选值；`proxy`/`noref`/`manifestOnly` 直接忽略（引擎中间态，固化只会让探测绕远）。
  **但这五个 key 仍必须留在 `PAGE_QUERY_KEYS` 里**，否则老链接的 `&origin=…` 会被拼进视频地址导致 404

**出向** `syncUrlToQuery()`（在 `playByIndex`/`clearPlaylist` 里调）：

- 用原生 `history.replaceState` 而非 `router.replace`（本页只读 `window.location.search`，避免触发路由重解析、不污染后退栈）
- **连接策略一概不写**；多个地址用 `urls=a|b`；超 2000 字符或按需取址时转存交接槽（`?handoff=1`）
- **有 `playlistSource` 就一律写 `parseUrl` 那套**

## 视频解析（/video-parse）

### 分工（策略模式）

`server/api/resolve.ts` 只做四件事：**匹配站点 → 抓页 → 过反爬握手 → 交给策略**。站点差异全在 `server/parsers/`。

```
server/parsers/
  types.ts / utils.ts    接口定义 / 共用工具（absolutize、decodeEntities、innerTexts、parseTitle、pool）
  index.ts               注册表 + matchParser（用户规则 > 代码型站点 > 内置规则）
  htmlRule.ts            数据驱动策略：地址明文在页面里，靠正则抠
  challenges/cdndefend.ts 反爬握手
  sites/nbmovie.ts       页面里没地址，要另调签名接口
composables/
  videoParseRules.ts     规则表 + 代码型站点登记表 + 共用数据形状
  useClientResolve.ts    取址作业单的前端执行器注册表
  useHtmlSourceResolver.ts / useWasmUrlSigner.ts   两种执行器
  usePowSolver.ts        浏览器侧算工作量证明
  useResolvePlaylist.ts  完整流程（两个页面共用，两处各写一份必然漂移）
```

`server/utils/siteFetch.ts` 是抓网页用的 dispatcher，与 `proxy.ts` 里那份**不是同一个**（那份按分片下载调过参数），不要合并。

**接新站两条路**：

1. 地址明文在页面里 → 在 `BUILTIN_PARSE_RULES` 加一条规则，**不用写代码**。四条正则：
   `sourceRe` / `lineRe` / `episodeGroupRe` / `episodeRe`。可选字段：`sourceDecode`、`activeFlagRe`、
   `titleRe`、`referer`/`origin`、`playerOrigin`、`sourceMediaOnly`、`lazy`。
   **完整 SOP 与 MacCMS 模板在 skill `video-parse-site` 里，加站先看它**
2. 要调接口/签名/解密 → `server/parsers/sites/` 加一个 `SiteParser`，在 `CODED_PARSERS` 注册，
   **并在 `videoParseRules.ts` 的 `CODED_PARSE_SITES` 登记 pattern**（前端不能 import `server/`，
   漏登记的表现是「能解析但输入框不显示规则徽标」）

### 为什么 PoW 放前端算

ncat 系挂了 cdndefend：首访返回 **HTTP 850** + 挑战页，要暴力找 nonce 使 `SHA1(c + nonce)` 的第 `n1`、`n1+1`
字节等于 `0xB0 0x0B`（`n1 = parseInt(c[0], 16)`），期望约 65536 次哈希。
**CF Workers 免费版每请求只有 10ms CPU，服务端硬算必超**；而挑战是纯 SHA1、不依赖 DOM，放前端完全等价（实测 ~55ms）。

`usePowSolver.ts` 内置**同步** SHA1 而非 `crypto.subtle.digest`：后者异步，6.5 万次 await 的微任务开销比哈希本身大一个量级。
输入恒为 ≤55 字节，永远单个 512 位分组，所以只实现单块 SHA1。

挑战常量 `c` 是**全站级**的（同站不同影片页完全一样），一次 PoW 全站复用，服务端按 host 缓存 30 分钟。

### 取址作业单

有些站点页面里没有播放地址，服务端只能给一张作业单（`ParseResult.clientTask`），由浏览器补齐 `videoUrl`。

| kind | 用在 | 动机 |
| --- | --- | --- |
| `wasm-url-signer` | nbmovie 系 | 服务端**做不了**（算法只在 wasm，签名带时效） |
| `html-source` | 所有 `lazy` 的 htmlRule 站点 | 服务端**不该一次做完**（逐集抓页太重） |

`html-source` 的抠地址仍在服务端（`/api/resolve?only=1`），浏览器只负责「什么时候抓」。

wasm 那步非放浏览器不可的三条独立理由：① CF Workers 禁止运行时实例化非打包 wasm，而文件名带内容 hash 也没法预打包；
② 签名带时间戳有效期短，攒一批必过期；③ 顺带绕开「单请求 50 subrequest」硬顶。

`WasmSignerTask` 是**纯声明**（模块地址/函数名/实参/时间戳 meta id/`JsonUrlPick` 全由服务端下发），
接同类站点只写服务端那半边。**我们只调用站点公开导出的函数，不复刻算法**——站点换方案时前端不用动。

### 按需取址（`clientTask.lazy`）

两类站点都要，理由不同做法相同：**nbmovie 系是站点限流**（实测取到第 186 发开始回「请求过于频繁」）；
**htmlRule 站点是逐集抓页太重**（ylsp 186 集要分 5 批上百请求，而用户通常只看几集）。
**新加的 htmlRule 站点默认就该开 `lazy`**。

- 解析页只取传入那一集；列表里存的是**源站播放页地址占位**，切到哪集才现取哪集
- **占位地址不替换成真实地址**：真实地址带时效签名，存下来下次就是死链；占位地址永远有效，还天然当了进度和集名的稳定键
- 因此**进度不能按 `videoUrl` 存** → `progressKey()` 统一取 `playlist[currentIndex]`
- **必须走交接槽**，再短的列表也不能写进 `urls=`（query 里只有占位地址，没有作业单，分享出去全打不开）
- 令牌会过期 → 取址失败时用 `playlistSource` 重解析拿新作业单，**只重试一次**（真失效和真限流表现一样）
- **源站的 `/play/<slug>` 会轮换**，过期的交接列表最终整份失效，只能回解析页重来（站点行为，兜不住）

### 分批解析（长剧）

单请求最多 40 集（`MAX_EPISODES`，CF 免费版 50 subrequest 硬顶）。**超出不截断，用 `offset` 分批**：
接口返回 `batchFrom`/`batchTo`/`remaining`，前端带 `offset` 续拉并按下标合并（20 轮上限兜底）。

- 「该线路不给直链」的探测只在第一批做；探到时要把 `remaining` 归零，否则前端会继续拉注定为空的批次
- **解析未完成时禁用播放按钮**，否则「明明 73 集，跳过去只有 40 集」

### 长播放列表交接槽

key `video-player-handoff`，载荷 `{ urls, names, title, source, lazy, index, at }`，TTL 1 天。

- 长列表整份写槽 + 跳 `?handoff=1`；短列表地址仍走 `urls=`（能分享），但**集名照样写槽**，
  只在「槽里 urls 与 query 解析出的完全一致」时才取用 `names`
- `names` 解决「长剧每集地址都叫 `index.m3u8`，列表里全是重复项」
- **`playlistNames` 按 URL 存（`Record<url, name>`），不要改成按下标的数组**：按下标要跟 `playlist` 严格对齐，
  漏一处就串名。踩过——`parseAndLoad` 里的「清掉上一份集名」把刚从槽读出的名字冲没了，表现为一排 `index.m3u8`

### 刷新链接（就地重新解析）

部分线路地址带签名会过期（播着播着 403）。用槽里的 `source` 原地重解析并**整份替换**。

反馈必须说清「变了什么」：按「集名 → 地址」建对照表算出 `changed`/`added`/`removed`，三个都是 0 就明确告知「链接没有变化」。
Toast 会消失，所以标题栏常驻一个「已于 HH:MM 刷新」。

- **当前这集地址没变就不要重载**（无谓打断）
- **按集名认当前集，不按下标**（重解析后集数可能变）
- **进度按 URL 存**，地址一换就查不到 → 先把 `currentTime` 搬到新地址的 `savedProgress` 上

### URL 参数同步（/video-parse）

参数 `url` + `line`，做法与播放器同源（含未编码 `&` 那个坑）。

- 出向在解析成功和失败后都调用（失败也写，刷新能直接重试）
- `line` 只在 `result.pageUrl === 当前输入` 时才写，否则会把上次残留的线路号写进新地址
- **`window.history.replaceState` 必须写全 `window.`**：本组件有个叫 `history` 的 ref 会遮蔽全局

## 各站实测结论

### nbmovie 系（4kvm / ziziys）

**同一套程序换皮，一条 pattern 兜住全部**：页面结构逐字节同构（`<link id="wasm-cfg">` + `userlink` +
`handleEpisodeClick` + `<meta id="nb-plt">`），parser 里所有地址都从 `ctx.pageUrl` 的 origin 现拼。
接同族站点**只需往两处 pattern 各加一个域名**：`sites/nbmovie.ts` 的 `PATTERN` 和 `CODED_PARSE_SITES`，两边必须同步。

- **只有一条线路**，站点自报的线路名是内部标识（`alists`）→ 单线路时显示「默认线路」
- 真实地址要拿 `dataid` 调 `/video/play?p=&v=&q=&s=&t=&k=`，整串 query 由 wasm 的 `build_play_url` 生成
- **`k`（令牌）来自页面里的 `userlink`，匿名访问也有**。少了它回 401「请提供访问令牌」，签名过期也是 401（文案不同）
- **wasm 会读 `<meta id="nb-plt">` 当时间戳**，我们的页面得自己补，且**每次签名前都要刷新**（共用旧时间戳会让后面几集过期）
- 胶水 js 走 blob 再 import（动态 import 按响应 MIME 校验，代理回来的 content-type 未必过得来）；
  wasm 传 **ArrayBuffer** 而非 URL（避开 `instantiateStreaming` 的 `application/wasm` 校验）
- **别用剥标签的办法取集名**：开标签的 `x-effect` 属性里有 `=>`，`<[^>]*>` 会在属性中间断开（踩过）。用 `innerTexts` 取最后一个 `<span>`
- 档位表里 4K 那条 `locked: true` 且 url 是 `"1"` 这种占位值 → 按 `locked` + 协议头两道筛
- **同一部片里各集地址不一定同源**：多数是 `oss.douyinbit.com` 的 m3u8，最新一集却是天翼云盘的预签名 mp4 →
  「带时效签名」的判断要连 `expires`/`signature` 一起看

### MacCMS 系（ylsp / netflixgc）

地址在内联 `player_aaaa={...}` 的 `url` 字段里，接这类站基本只是改四个正则。

- **`encrypt` 决定编码但不要按它分支**（0=明文 / 1=percent / 2=base64 套 percent，同站不同线路可以不同）。
  `sourceDecode: 'maccms'` 自适应剥到 http 开头，**层数硬封在 2 层**（地址本身常带 percent 编码的签名，无限解码会越解越坏）
- **当前线路的 class 标记各站不同**（ylsp `active`、netflixgc `on`）→ `activeFlagRe`。认错不报错，只是悄悄落到第一条线路
- **选集容器不能用 `</div>` 收尾**：ylsp 当前集的 `<a>` 里嵌了 `<div class="playon">`，非贪婪匹配断在那，整条线路只剩 1 集（踩过）
- **防盗链域名可以跟播放页毫无关系，而且不该写死**：netflixgc 视频挂在 `v.fengbao10.com`，防盗链认的是它自己的播放器页
  `cjbfq.netflixgc.tv`，播放页域名和主域都 403。用 `ParseRule.playerOrigin` 从 `/static/js/playerconfig.js` 的 `parse` 字段现取
  （**抓回来的 HTML 里没有那个 iframe**，是 JS 运行时注入的）。按 host 缓存 30 分钟。
  验证「动态取到还是走了兜底」的办法：把兜底临时改成假值看返回值变不变
- **`<title>` 可能是一长串 SEO 文案**（实测 90+ 字符）→ 用 `titleRe` 从书名号里取

### kpkuang（看片狂人）— 每条线路的防盗链域名都不一样

FED 模板，**不走 `player_aaaa`**，地址在播放器 iframe 属性上。

- **地址在 `data-play`，是「随机前缀 + base64」**：前缀每次刷新都变 → `sourceDecode: 'base64-scan'` 从偏移 0 逐个试到解出 http
- **防盗链域名每条线路一份，写在 `data-pars` 上**（睿映认 `soul.flixfiend.top`、电影天堂认 `vip.dyttzyplay.com`…）。
  于是 `playerOrigin.url` 改成可选（不给 url 就对当前页 HTML 跑正则）。这种**绝不能按 host 缓存**——
  一缓存就把上一条线路的域名喂给下一条，表现是切线路后开始 403
- **`?line=N` 指到别的线路时必须按探测页重算域名**（`base` 里那份属于用户传进来那条线路）
- **26 条线路里有 4 条给的是第三方播放页而不是直链**（芒果、爱奇艺-VIP、超清 AB/BY/EV）→ `sourceMediaOnly: true`，
  当 `lineUnsupported` 报出来并配 `lineUnsupportedReason`（原来的固定文案说的是 ncat 4K 线那种「页面把地址留空」，
  用在这里会让人以为是正则写坏了）。**这类线路做不到**：真实地址由第三方解析服务在浏览器里用混淆 JS 现算，
  没有公开接口（试过 `api.php`/`jx.php` 都 404），跨域 iframe 又读不到
- 选集容器**必须从 `fed-play-item` 起锚**（页面上另有两个空的 `fed-part-rows`，直接匹配会错位），
  且 class 后不能收在 `"` 上（超清三条线带了 `style` 属性）
- active 标记是 `uk-active` 且在**外层 `<li>`** 上
- 实测 26 条线路 × 最多 71 集，开 `lazy`

#### 内嵌播放器的「反内嵌」自检（提示都提 Sandbox，别当成防盗链或正则问题）

- **超清EV线（ezplayer）探的是 sandbox 属性本身，跟广告无关**：bundle 里
  `try { document.domain = document.domain } catch (e) { if (e.toString().includes('sandboxed')) … }`——
  沙箱文档里这句必抛，一抛就报 `Opss! Sandboxed our player is not allowed`。
  **没有 token 可解**：「sandboxed document.domain flag」只要挂了 `sandbox` 就必然置位，而
  `allow-document-domain` **压根不是合法 token**，非法 token 被静默忽略、改完现象一模一样——**别再往加 flag 的方向试**。
  唯一出路是整个摘掉属性 → 做成「限制广告」开关（`embedSandbox`，存 `video-parse-embed-sandbox`），
  **默认关**：挂着 sandbox 能挡广告的顶层跳转，但会让一部分线路彻底播不了，而这块 UI 的存在意义就是「能播」。
  换线路**不复位**（那是用户偏好）。iframe 的 `:key` 必须带上这个档位——**sandbox 是文档创建时定死的**，
  光 patch 属性不重建毫无效果。
  追这类问题别猜 flag：**把它的 bundle 拉下来搜 `Sandbox`，检测函数就在旁边**
- **超清AB线（abyssplayer）要的是真广告**：点遮罩触发 `window.open`，失败计数到 2 就 `document.write` 掉播放器。
  给 `allow-popups` 能过，但用户装了拦截插件照样过不了（弹窗域名被拦 → 返回 null），这个兜不住
- 两者都**不给 `allow-popups-to-escape-sandbox`**（弹出窗继承同一套限制）也**不给 `allow-top-navigation*`**
  （那一项最恶心：点一下播放整页被劫走，用户只会以为是本站跳的）
- **内嵌线路的选集不能在取址期间互相按住**：原来 `:disabled` 把非当前集全禁掉，表现是「整排突然置灰」，
  看不出在等谁（实测被问过）。改成自增 `embedSeq` 认领结果，后点的作废先点的——连失败 toast 一起丢

## 状态持久化（localStorage）

| key | 用途 |
| --- | --- |
| `video-player-state` | 播放器全量状态（地址/列表/进度/音量/倍速/HLS 配置/档位覆盖） |
| `video-player-learned-profiles` | 按 host 学到的档位 + 可达性探测结果（`reach`，TTL 30 分钟） |
| `video-player-handoff` | 长播放列表交接槽，TTL 1 天 |
| `video-player-origin-history` / `-referer-history` | Origin/Referer 输入历史 |
| `video-parse-rules` | 用户自定义解析规则 |
| `video-parse-embed-sandbox` | 内嵌播放器是否挂 sandbox（默认关） |
| `json-*-settings` / `content-diff-settings` / `timestamp-settings` | 各页设置 |
| `json-extract-import` | json-format → json-extract 跨页传值 |
| `utools-history-<page>` | 通用历史：最多 50 条，单条 1MB，总量 256MB |

## 踩过的坑（通用）

- **CF Workers 无 `process`**：判空后再动态 `import('undici')`，specifier 必须用变量 + `@vite-ignore`，否则 Vite 在 CF 构建时静态解析报错
- **`@ffmpeg/*` 必须 `optimizeDeps.exclude`**（已在 nuxt.config.ts）
- **`/api/proxy` 遇到上游非 2xx 必须原样透传状态码，绝不能进 m3u8 改写**。漏了这条极其隐蔽（实测 `vip.ffzy-play10.com`）：
  源站回 403 + 一页 HTML，被 `rewriteM3u8` 逐行当相对 URI 拼上 baseUrl，最后以 **200 + m3u8 MIME** 返回。连锁反应：
  ① 探测不报错 → 判 `ok`（假阳性）；② 解析出 0 个分片 → **分片轴整轮 `skip`**；③ 选中一条实际 403 的通道。
  「分片轴全 skip 而清单显示可达」这个现象追了三轮。第二道防线在 `loadManifest`：**解析不出任何分片就判 `fail`**
- **判断「是不是 m3u8」绝不能用 `url.includes('.m3u8')`**，一律走 `utils/mediaUrl.ts` 的 `isM3u8Url()`。
  有的站点把 `.m3u8` 当**目录名**（实测 `feikuai.in`）：全串匹配会把 ts 分片判成清单，
  ① 代理对二进制走 `response.text()` 回一堆乱码；② `noseg=1` 失效。表现是**页面反复闪动、「已缓冲」一直涨却永远播不了**，
  而探测每一路都是 200。判据是**看路径最后一段的扩展名**
- **改连接策略必须重载视频**，否则 hls.js 还在用上次解析出的分片 URL
- **CF Workers 会静默吞掉非标端口**：`wrangler.json` 的 `compatibility_date` 必须 ≥ `2024-09-02`，否则线上
  `fetch('https://host:999/x.ts')` 被降级成 `:443`（实测 `p.jisuts.com:999`、`208.69.102.105:11306` 的 `:443` 根本没监听），
  而本地 Node 一切正常。**千万别顺手加 `compatibility_flags: ["allow_custom_ports"]`**——该 flag 已是默认值，
  显式声明会让 Pages 部署在**最后一步**失败。只改日期，不加 flag
- **两个 compatibilityDate 是两回事**：`nuxt.config.ts` 的是 Nitro 特性门控（构建日志打印的就是它）；
  真正决定 CF 运行时行为的是 `wrangler.json` 的。看到日志里是 2024-07-01 不代表线上就是它
- **`crossorigin="anonymous"`** 只对远程源加，本地 blob 要设 `undefined`
