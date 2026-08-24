# utools — 晚风（在线工具集）

纯前端（`ssr: false`）在线工具集，Nuxt 3 + Nuxt UI，部署在 Cloudflare Pages。`/video-player` 对外叫「放映厅」。
主色 `rose`、灰阶 `zinc`（`app.config.ts`），**氛围靠底色和留白，不靠把颜色调重**。
除「视频代理 / 解析」两个服务端接口外，所有处理都在浏览器里做。

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
- 新增工具页要改三处：`pages/新页.vue`、`pages/index.vue` 的 `categories`、`layouts/default.vue` 的 `toolCategories`
- **单文件不超过 500 行**，页面只留装配（播放器是样板）。两个配套动作：
  **`composables/` 的子目录要在 `nuxt.config.ts` 的 `imports.dirs` 里登记**（漏登记 =「一堆 xxx is not defined」）；
  **别把数组常量和别的导出混在一个文件里**（unimport 会静默漏掉紧跟其后的导出，tsc 却能过）

```
pages/ 12 个工具页   composables/videoPlayer/ 播放器全部逻辑   utils/ 前后端共用纯函数
server/api/proxy.ts 跨域/防盗链代理      server/api/resolve.ts 解析接口（薄壳，站点策略在 server/parsers/）
```

工具：`/pdf-tools` · `/image-compress` · `/image-convert` · `/video-to-gif` · `/audio-convert` · `/video-player` ·
`/video-parse` · `/video-search` · `/json-format` · `/json-diff` · `/json-extract` · `/content-diff` · `/timestamp`

## 视频播放器

核心难点：**跨域、防盗链、慢速源站、内存**。

**依赖方向单向**：`gestures → engine/events/controls → conn/tier/playlist → media/handoff`，反向一律用回调
（`deps.reload`、`registerTickHook`…）。`useVideoMediaState` 是**裸状态**，存在目的是打断依赖环；
`useVideoPlayerController` 是装配层。**子组件不传 props**（各自 `useVideoPlayerCtx()`）→ **各模块返回的键名不能重复**。

**版式参照腾讯视频移动端**：播放器排最前、手机通栏贴边，进度条内联在按钮行里（宽屏才 `order-first` 独占一行）。
**只有输入框、播放器、选集常显**；看片当下才改的进控制栏齿轮菜单（浮在黑画面上，**不能用 UCheckbox/UInput**），
排查才看的进 `CollapseCard`（里面的组件**不要自带 `UCard`**）。

### 起播与切集（「先能播」优先）

- **HLS→HLS 切集复用同一个 `<video>`**（只有 HLS↔MP4 互转或出错才重建）：重建要付等待、解码器重建、
  `play()` 撞 attach 变 `AbortError`、**画面立刻变黑**四笔账。复用前要 `removeAttribute('src') + load()`
- **切集靠占位元素接力保住画中画**（`engine/pipHandoff.ts`）：换流必然换 src，小窗绑的是换掉之前那个；退出再申请要用户激活，
  而自动切集没有点击。规范豁免是「`pictureInPictureElement` 非空时申请免激活」→ 换流**前**交给占位 `<video>`，
  新流 `loadedmetadata` 时要回来。第一段必须赶在 `destroyHls` / `removeAttribute('src')` **之前**。
  **占位画面的比例默认跟着小窗，不能写死 16:9**（`currentAspect()`）：小窗比例跟着当前在画中画里的
  那个元素走，占位一塞进去窗口就被顶一次。**比例只能从 `PictureInPictureWindow` 的 `width/height` 读**
  ——`videoWidth/videoHeight` 是视频固有尺寸，窗口被拖过就不是一回事了；而它**只能在 `enterpictureinpicture`
  那一刻拿**（DOM 里没有 `document.pictureInPictureWindow`），且要挂在 **`document` 捕获阶段**
  （事件不冒泡、`<video>` 会被 `videoKey++` 换掉、原生控件进小窗不走 `togglePiP`）
- **画中画小窗只会自己变大，绝不自己变小**（实测日志）：一部 2.40:1 的片子（1920×800）里 ABR 切到
  16:9 那档（1920×1080），小窗当场 384×160 → 384×216（**宽度不动只长高**）；比例切回 2.40:1 后
  **小窗赖在 384×216 不动**。**标准 PiP API 没有任何尺寸/比例参数**，唯一能让浏览器重算尺寸的动作是「重进一次」
  → `resyncPiPAspect`（听 `<video>` 的 `resize`）。**绝不能真的 `exitPictureInPicture()`**：一 exit
  豁免就没了，而比例变化是自动发生的、手上没有点击 → 必被 `NotAllowedError` 拒，小窗关掉再也开不回来。
  走**两跳**（占位进 → 真视频要回来，全程「有主」）实测有效，且要有冷却（比例会来回抖，每次重开都闪一下黑）
- **起播门槛的单位是「够播几秒」不是「缓冲几秒」**（`autoPlayTarget`，一律 × 倍速），且随近期卡顿次数翻倍
  （慢源上「五次一秒的卡」远比「一次四秒的等」难受）。**这一块只留一个秒数常量 `PLAYABLE_SECS = 2`**
  ——起播门槛（冷启动 ×2）与「连续流畅就归零」共用它，别再往回加第二个旋钮。
  **下坡路要短（归零线 = 2s × 倍速，倍速夹在 1~3x，原来是固定 20s）**：断网/换网必然制造卡顿，
  而那些卡顿不是源站的错，却一样把门槛翻上去 → 网络一恢复 `onWaiting` 就主动 pause 去攒 `2^stalls`
  （1x 下 stalls=2 就要 24s，必然吃满 8s 封顶）→ **「网络早通了画面还要再等 8 秒」**。
  归零线跟着倍速涨是因为高倍速下缓冲消耗快、「刚好喘匀这几秒」的偶然性大，但**不能不封顶**（超快倍速那一档本来就必卡）
- **跳过片头走 hls.js 的 `startPosition`**，不在 `loadedmetadata` 里手动 seek。进度优先于片头
- **探测顺手下载的 m3u8 原文喂给 hls.js**（`pLoader` + `takeSeededManifest`）：**回调必须延到下一个宏任务**，
  同步回会赶在 MediaSource `sourceopen` 之前 →「分片一个接一个 200、缓冲恒 0、一直转圈」。
  **交给 hls.js 的 URL 必须是重定向后的最终地址**（`manifestFinalUrl`），它拿它当基准还原相对分片 URI
- **切集门闩 latest-wins**但**封顶 3 次**（坏源一 attach 就 `ended`，会把整份列表飞快走完）
- **上/下一集按钮切集期间只换转圈图标，绝不 `:disabled`**：disabled 控件不派发鼠标事件，那一下会被手势层接走 →「点切集结果全屏了」
- **字幕默认关**（没有字幕 UI）。浏览器的「实时字幕」不是我们能关的（它能盖在播放器**外面**）

### 转圈遮罩与卡死自救

**点亮只能走 `engine.armBufferingGate()`**：150ms 后只有「有效可播（MSE + 预取缓存）也不足 2s」才亮；
800ms 后货在手上却没播起来 = 反常，必须让用户看见。心跳里还要**兜底熄灯**（正播着的视频不会再补发 `playing`）。

**「缓冲几百秒却卡死」有两个不同根因：**

- **MSE 在播放头处有洞**（`engine/stallRecovery.ts`）：真凶是 `fLoader` 命中缓存时**同步回调**——hls.js 是在 `load()`
  返回**之后**才记账，同步交货没人收，**缓存越满越容易发生** → `setTimeout(0)`。判据：连 `startLoad` 都救不回来、
  播放头一秒不动。另外 `bufferStalledError` 非致命且每秒复发，`if (!data.fatal) return` 会把唯一线索丢掉。
  自救按**阶梯**升级、每级只用一次、播放头一动就归零（跳洞后 → `startLoad` → 微跳 0.5s → `recoverMediaError` → 停手报错），
  **播放头处有货就一律不动手**，且要 2s 冷却（hls.js 自己的 nudge 也在动 `currentTime`）
- **那一片音视轨不对齐**（`maxBufferHole`）：`buffered` 是两轨**交集**而 hls.js 按视轨记账 → 认定已缓冲 →
  停在 IDLE **永不再请求分片**（死锁不是慢）。**唯一出路是整片放弃**，且**清缓冲范围只给这一片，绝不 `endOffset: Infinity`**。
  排查**必须把分片抠出来 ffprobe**（有的 CDN 把分片伪装成 PNG）

### 代理与探测

`GET /api/proxy?url=&origin=&referer=&noref=1&noseg=1`：`noref=1` 伪装下载器，`noseg=1` 分片不改写、直连 CDN。

**连接方式只有一个来源：自动可达性探测**。**「站点规则」表和手动模式都已删**——`originHint`/`refererHint` 是
**候选值不是配置**（试不通照样降级），与 `requestOrigin`（生效值）分开两个 ref；改候选值要作废该 host 的 `reach` 缓存。
兜底有 `markLaneFail`（连续失败 3 次停用 lane）。manifest 与分片常不在同一 host → **两轴分开**，四通道
（`direct`/`disguise`/`headers`/`manifestOnly`）归一化成 5 种组合：分片要代理 → manifest 必须走同一种代理；
分片可直连 → manifest 取自己最优的，靠 `noseg=1` 保住直连。不对称同时出现时退回线性阶梯（4 级，**每级必须把四个 ref 全写一遍**）。

- **直连探测绝不能加 `Range` 头**（触发 CORS 预检 → 假阴性），必须与真实请求**完全同形**
- **`unknown`（超时）≠ `fail`**；`skip` = 没探。mixed content 直接判 fail
- **判定恒按 `CHANNEL_ORDER`（`pickChannel`）不按到达顺序**，否则本可直连的源会被按到代理上
- **两根轴的等待策略不同**：清单轴 budget=0（三路同时发、首个可达即收工）；分片轴保留 400ms `PRIORITY_BUDGET`
  （这轴上「直连也 ok」决定分片走不走代理）。**`HEDGE_DELAY` 只决定要不要补防盗链，绝不能用它收工**
  ——它比预算短，会拿一份缺页的矩阵下判断（事后看矩阵两条全 ok，最难查）
- **两级超时**：单通道 8s + 整轮 12s 硬顶，别为了「探全」调大
- **探测结果不按 host 缓存也不跨页复用，每次加载都实测**：按需取址的站点每集都是现签地址，上一集的结论对这一集就是 403
  →「切一集就播不了」。只按 host 记「直连是黑洞」（`isDirectDead`，存的是「等多久」不是「用哪条」，直连一通就清 → 自愈）。
  唯一例外是**预热**（同一完整 URL 的实测结果，用完即弃）
- **整片 MP4 一律先直连不探测**（探测判据是给 HLS 写的）。配套 **`<video>` 不加 `crossorigin`**（否则变 CORS 模式，
  网盘直链一个 ACAO 都不给）
- **判读一律走 `diagnoseProbe`、渲染走 `ProbeMatrix.vue`**（「三条全 fail」与「没测过（全 skip）」长得像却含义相反）。
  `fatal` **当场弹 toast**（否则用户盯着阶梯盲试转圈一分多钟），但**盲试照旧**

### 并发预取与抗卡

自定义 hls.js `fLoader`，命中预取缓存即时返回。同 host 只给 6 条连接 → 有**双通道**（同一分片给出直连与代理两个 origin）。

- **每一个「失败额度」都必须是「连续失败」，断网期间一律不计数**：`maxRacers` 管「同时几条」不是「一共几次」；
  lane 熔断要能自愈；`hlsRetryCount` 必须由加载成功归零；离线时错误不计数、超时闹钟顺延（含 `skipMs`）、不跳片。
  否则症状全是「网络早恢复了画面还转圈」
- **网络变化的信号只有 `engine/netWatch.ts` 一个来源，绝不各自读 `navigator.onLine`**：
  **换 Wi-Fi / 切蜂窝时 `onLine` 全程是 `true`**，`online`/`offline` 一个都不发 → 熔断记录不作废（干等 30s）、
  重试额度 3×1s 飞快烧完 → 掉进「重新取址（30s）→ 重探通道（12s）→ 销毁播放器」，**每一步都跟源站/地址/通道无关**。
  所以并成三个信号：`online`/`offline` + `navigator.connection` 的 `change`（**只认 `type`/`effectiveType` 变了**，
  `downlink`/`rtt` 一直在抖）+ 回前台（后台期间 `change` 会被吞）。对外只有「有没有网」和
  **「刚刚变过没有」（`isRecovering()`，8s 窗口）**：窗口内 fatal 网络错误**不计额度、快退重试 300/600/1200ms、
  不进重新取址与重探**，`hedgeMs` 对折、换连接间隔 500→200ms，两档加载闹钟各让路一次。
  **不做主动 ping**——`startLoad()` 本身就是最好的探针
- **网络变了要做的事**：作废熔断 → 作废可达性结论（`invalidateReachCache` + `clearDirectDead`，它们是**上一个网络**
  测出来的）→ `startLoad(currentTime)`（**只在没在播时**，且**必须带位置**：不带就按断网前的 `nextLoadPosition` 挑片）
  → `primePrefetch()`。**且要补枪**：刚重连那一两秒请求常常还发不出去，只开一枪打空就又落回慢路径 →
  心跳在恢复窗口内每秒复查、最多 4 次
- **等网络的回调必须幂等 + 一次性 + 「已经有网就直接跑」**（`waitForNet`）：老的 `waitForOnline` 每次 fatal 挂一个
  不去重的一次性监听，`online` 若恰好在挂之前发生，那一发 `startLoad` **永远不会来**
- **搭在途预取的便车时，那趟车翻了必须当场自己上**：`spawnPrefetch` 失败 resolve 的是**空 ArrayBuffer 而不是 reject**，
  漏了 `else` 就只能干等 `hedgeMs` → **「预取缓存还有几十秒，拖完进度却转两三秒圈」**
- **存货不够时少开线程**（反直觉）：判据 = 缓存秒数 ÷ 倍速（`SAFE_WALL_SECS`），阶梯 2/3/4/6 → 放开。
  决定「能不能播下去」的只有紧邻播放头那一两片，多开的都在抢同样 6 个槽 → **越缺越多开，最需要的那片越晚到**。
  过线后再压两档（否则 2→12 跳变）。**阶梯必须有地板**（`catchUpFloor`），否则慢源自锁：2 条连维持播放都不够 →
  存货永远涨不到放开线。冷启动没样本时退回按 host 学到的并发（**阶梯地板和 `computeTargetConcurrency` 两处都要改**）
- **并发决策优先级**（取 `min`，最后是 `max`）：① 冷启动帽 ≤3 ② 存货墙钟阶梯 ③ 卡顿守卫 ④ 聚合拐点 ⑤ 缺口速率 ⑥ 地板。
  ③ 的分岔点是**聚合速度够不够喂**（不是单连接速度）：够喂却还卡 = 摊薄 → 收到 3 条；喂不动 = 真慢 → 抬到 hostCap
- **存货快够了也要少开**（`headroomConnCap`）：`需要的吞吐 = 播放消耗(倍速) + 缺口 ÷ 60s`，**判据是速率不是存量**。
  播放消耗那项存货厚时打折，但折扣要**按缺口淡入**——只看存货厚会把平衡点永久钉在目标下方（看着像源站慢）
- `concurrencyFloor` 已删；`panicSecs`/`lowSecs` 只驱动抗卡动作**不再参与并发**。
  **缓冲健康区按「有效可播」分档不是 MSE 前向**（后者有天花板，长期停在平台是稳态不是吃紧）；**只有跳片才看 MSE**
- **卡顿记录必须每次心跳调 `tick()`**（只在起播 bind 会绑到已卸载的旧元素 →「卡顿恒 0 次」）；「卡顿中往前微跳」
  不能按 seek 处理；**事件之外还要位置采样兜底**
- **自动最佳倍速**：上限 `autoRateCap = max(2, desiredRate)`；`bufferRich` 时免掉「连续流畅 20s」（否则提速被锁死）；
  **算出目标一次到位不设幅度上限**（爬台阶要 200 秒，用户会认定没生效），节流交给惰性期。
  超快倍速 3.5~5x 默认关（**4x 往上多数浏览器直接静音**，是浏览器硬规则）

### 内存（`useSegmentCache.ts`）

模块级单例，TTL 1 天 + LRU；缓存里只可能有当前视频的分片，真正堆积的是**已播过的**那些。

- **「预加载时长」的单位是「够播几秒」（墙钟）**，换算只在 `effectivePrefetchTarget` 一处做。默认 60 秒可播 / 1024MB
- **它不参与 hls.js 的 MSE 窗口**（单位不同，窗口写死 30 / `MSE_CEILING_SECS`）。**预读深度与内存上限都不能一味给大**
  （曾是偶发「整个浏览器像卡死」的根因）；改默认值救不了老用户 → `migrateHlsTuning` **只认旧默认值精确匹配**
- **后台标签页是内存回收首选对象** → `hidden` 时立刻 `purgePlayedSegments()`；**拿不到分片表必须直接返回**
  （一刀切会把前方预取也清掉 =「点一下清理立刻开始卡」）
- **切标签页的三个问题别混**：① 切回来卡一下 = 心跳被节流（回前台补跑一拍，**必须先 `stall.resetSampler()`**，
  否则把后台时间回填成假卡顿）；② 残影/黑屏 = 硬件 overlay 平面没重画，`forceRecomposite()` **在两个视觉等价的 transform
  间切换**（别用 `display:none`；第一次之后不再撤销，否则每次都看得见地闪），**暂停也要补一次**；
  ③ 整个浏览器僵住几秒 = 系统内存压力，不是本项目。判读看统计面板的**掉帧**

### 预热与死地址自救

**下一集预热**（`useVideoPrewarm.ts`）把「取址 → 探测 → manifest → 前几片」四段串行等提前做掉；分片进**暂存区**
（主缓存会整块 clear），地址只能从**那份 manifest 原文**解析。**提前量宁可短不可长**（地址带签名、站点会限流），
每集一次、失败不重试、**全程静默**（碰 `isResolvingUrl`/`errorMessage` 会在正播的这集上盖遮罩）。

**死地址必须能自己走回原链路**（`refetchCurrentUrl`）：`reload()` 从不重新取址，所以恢复顺序是
**重新取址 → 重探 → 才报错**。**加载 10s 那档必须静默**（它必然误伤慢源）。**取址的等待必须封三道顶**
（单发 30s / 预热让路 3s / **前台点击 15s**——点击可能复用一条正在排队让路的预热请求，能叠成一分钟）。
取址**同集去重 + 预热单向让路**，但**前台复用了预热那一发而它失败 → 自己立刻重来**，配套预热死线要比前台短。

### 手势与移动端

鼠标与触摸走**同一套 Pointer Events**。桌面单击播放暂停/双击全屏；触摸全屏内单击只切控制栏（误触暂停最烦）、
双击左右 ∓5s、中间播放暂停；长按右半屏 2x；横滑拖进度（松手才 seek）、竖滑**只在全屏内**调音量/亮度。

- **锁定只在「全屏 + 正在播」成立**，退出全屏或暂停就自动解锁；**解锁键在锁定态下无条件渲染**——
  它是画面上唯一的出口，共用「窄屏不出」条件会导致「全屏锁定 → 来电退出全屏」之后**只能刷新页面**
- **切走再回来要把全屏要回去**（安卓系统常退掉），会被拒 → 挂起-补兑现（`pendingAutoFullscreen`）
- **自动全屏也是挂起 + 补兑现**，且**只在触摸端生效**（`isTouchPrimary()`）——桌面上会变成「点画面任何位置都被拽进全屏」
- **自动播放失败要分两类**：`NotAllowedError` 才是被策略拦了（改静音重播），其余（**主要是 `AbortError`**）
  是被新的 load 打断、重试即可——一律按「被拦」处理的表现是**自动跳到下一集却停在暂停**
- 控制栏默认收起且暂停时也收；窄屏减项且**不能 `flex-wrap`**；**倍速菜单开着时不自动收**；
  **窄屏也要有「上一集」**（否则用户会去点那个位置，那儿是画面，连点两下正好进全屏）
- 控制栏挂 `data-no-gesture`，**原生可交互元素也一律放过**（漏挂一处 =「点按钮却被当成双击拽进全屏」）
- 单击必须等双击窗口（280ms）。**触摸抬手后浏览器会补发一整套兼容鼠标事件**，只能按「刚刚有过触摸」滤；
  同理单击目标态要取**按下那一刻**的相反值——否则控制栏「弹出来 0.3 秒就收回」
- **长按倍速不写进 `playbackRate`**（那是闭环算出的稳态值）；进全屏时手机上锁横屏（解锁挂 `fullscreenchange`）

### 切集门闩与进度（踩过：15 集点下一集直接落到 30 集）

切集是**异步**的而旧 `<video>` 还在播，「跳过片尾」条件全程成立 → `playNext` 被连调十几次。两道闩：`switching` 与每集一次的 `outroFired`。

- **`playNext(auto)` 必须区分「自动」和「用户点的」**（`currentIndex` 一开始就乐观指向目标集）：自动的在切集期间作废；
  用户的在**自动**切集期间也作废（他看到画面没动才点的，+1 会多跳一集）；但连点两下仍要跳两集。
  模板里必须写 `playNext()`——`@click="playNext"` 会把 MouseEvent 当 `auto` 实参
- **取址失败必须把 `currentIndex` 退回去**，否则「没跳过去」和「跳了两集」会连着来
- **进度记忆不能记进片尾区**（越过就删记录），否则恢复进度后当场被弹走，**这集永远看不成**
- **进度按 URL 存** → `progressKey()` 取 `playlist[currentIndex]`（按需取址时 `videoUrl` 是现签的）
- **「现在是第几集」要一眼看得到**（画面下方一枚实色徽标）；选集面板 `scrollIntoView({ block: 'nearest' })`
  **必须用 ResizeObserver 不能用 IntersectionObserver**（`v-show` 折叠时是空操作，展开没有事件可听，IO 又要等进视口）
- **跨天续看靠 `useWatchHistory`（按剧名记一条）**，解析页和播放器**两处都要有入口**；三条闭嘴规则：
  深链带了 `index`/`ep`、落点就是正在播的那集、**用户自己动过集数就永久闭嘴**。也**不自动跳过去**
- **倍速与片头片尾按剧存**（`useShowPrefs`：目标倍速 / 片头 / 片尾 / 自动最佳倍速 / 超快倍速）。
  **没有本剧记录就一个字都不改**——当前值就是「上一次」，而「上一次」由 `saveState` 天然维护，
  fallback 不需要代码。三个坑：**键必须复用 `useWatchHistory` 的 `showKeyOf`**（各写一套归一化 =
  「续看记在这部剧、设置记在另一部」，只在标题多个空格时发作）；**套用必须 `flush: 'sync'`**
  （`skipIntro` 就是 `startPosition`，晚一步则本剧第一集拿着上一部剧的片头秒数起播，切到第二集又正常）；
  **全局那份（`hydrate()`）必须排在按剧那份之前**，否则把本剧的设置盖回去——`mount()` 里 hydrate 之后
  补一发 `applyShowPrefs()` 就是把这个顺序钉死（眼下没有哪条路会更早拿到剧名，是给将来留的）。
  写回不需要标志位：值与记录一致就跳过，继承来的值压根没变也就不落库

### URL 参数直链

**解析来的列表一律用 `?parseUrl=…&line=N&lineName=…&index=M&ep=…`**，链接里不带视频地址（另两种表达都不能分享）。
**线路和集数各写两份：序号是位置，名字是身份**，打开时先按名字认；`index` 恒写；这条路上一律重解析、不吃任何缓存。
**「交接槽」（`video-player-handoff`：解析页写 localStorage + 跳 `?handoff=1`）已整套删除**——`parseUrl` 分支恒命中，
那个槽写了没人读，两条读它的分支（长列表 / 按需取址）也因此永远走不到。`handoff` 只剩个**留在 `PAGE_QUERY_KEYS` 里
被忽略的历史键**（不认它，老书签上的 `&handoff=1` 会被当成视频地址的尾巴接上去）。

- **入向关键坑**：视频地址自带 query 时未编码的 `&` 会被路由拆散 → 从 `window.location.search` **原始串**手工解析，
  非 `PAGE_QUERY_KEYS` 的片段回写进最近的视频地址。只做 percent 解码，**不把 `+` 当空格**（签名里常有裸 `+`）。
  `origin`/`referer` 收作候选值，`proxy`/`noref`/`manifestOnly` 忽略，**但仍必须留在 `PAGE_QUERY_KEYS` 里**
- **出向**用原生 `history.replaceState`；连接策略一概不写；手工贴的列表超 2000 字符就**地址栏什么都不写**
  （刷新靠 `video-player-state` 里那份完整 playlist 恢复，效果一样）
- **解析那几秒页面上必须有东西**（Stage 是 `v-if="isVideoLoaded"`），文案走 `resolveStage`

## 按片名搜索（/video-search）

关键词 → 各站**并发**搜（`server/api/search.ts` **一次只搜一个站**，串起来等于按最慢的算）→ 点一格新标签打开解析页。
**全部配置化**（`videoSearchRules.ts` 一张 `SEARCH_RULES`，执行器不认识任何具体站点）。反爬 cookie 与解析互通。

- 站点列表**左侧竖排不是顶部 tab**；折叠时**两种状态的格子必须一样高**，否则 hover 展开→变矮→`mouseleave` 形成
  几何反馈环，表现是**鼠标停在最下面几格上一直闪**（加延时治不了）
- **搜索历史写入要 `{ bump: true }`**（追剧天天搜同一个词，默认「重复返回 false」会让它最先被淘汰）；
  **`saveCache()` 必须写在「自动选中第一个有结果的站」逻辑之外**，否则后面几站一份都存不进去
- **「有没有下一页」不能按「页面上有没有那颗按钮」判**（MacCMS 最后一页照样渲染，只是指回自己），
  判据是**链接里的页码 > 当前页**；页码不写进地址栏
- **kpkuang 的 `/vodsearch/` 挂着 CF 人机校验**（只打在这条路径上，换 UA / 指纹伪装没用）→ 绕去首页那个 JSONP 接口
  （规则表的 `json` 模式）；不带 `Referer` 恒回空，偶发空要重试且**每次重试都要重新 `buildSearchUrl`**
- **ncat 搜索要一个 `t`**（页面隐藏字段，全站同值）；它的**封面不在站点域名下**，可用图床在 `rdul.js` 里 → `picBase` 现抠现用；
  封面失败**按图床 host 记在模块级 Set 里**（否则一页几十个白跑的请求）

## 视频解析（/video-parse）

`resolve.ts` 只做四件事：**匹配站点 → 抓页 → 过反爬握手 → 交给策略**，站点差异全在 `server/parsers/`。
**接新站两条路**：① 地址明文在页面里 → `BUILTIN_PARSE_RULES` 加一条规则，**不用写代码**（**完整 SOP 在 skill
`video-parse-site` 里**）；② 要调接口/签名 → 加 `SiteParser` 并在 `CODED_PARSERS` 注册，**同时在 `CODED_PARSE_SITES`
登记 pattern**（前端不能 import `server/`，漏登记 =「能解析但不显示徽标」）。

- **详情页也能解析**（`detailRe`/`detailPlayRe`）：搜索结果多半是详情页，服务端换成第 1 集播放页，
  **`ParseResult.pageUrl` 是换过之后的**，页面要把 `inputUrl` 跟着回写
- **PoW 放前端算**：**CF Workers 免费版每请求只有 10ms CPU**，而挑战要约 6.5 万次 SHA1。`usePowSolver.ts` 内置**同步**
  SHA1（`crypto.subtle` 异步，6.5 万次 await 的开销比哈希本身还大）
- **取址作业单**：`wasm-url-signer`（nbmovie 系，服务端**做不了**——CF 禁止运行时实例化非打包 wasm、签名带时效）、
  `html-source`（`lazy` 的 htmlRule 站点，抠地址仍在服务端 `?only=1`，浏览器只负责「什么时候抓」）。
  **我们只调用站点公开导出的函数，不复刻算法**
- **按需取址（`lazy`）：新加的 htmlRule 站点默认就该开**。**「整张线路×集数表一次拿到」不等于地址也一次拿到**
  （ncat 因此长期误判没开，点一下线路 7.8s → 0.5s）。列表里存的是**播放页地址占位、不替换成真实地址**
  （真实地址带签名，存下来下次就是死链；占位地址还天然当了进度和集名的稳定键），因此**作业单必须跟着列表走**
  （`?parseUrl=` 那条路上由播放器重解析时现拿，刷新时从 `video-player-state` 的 `lazyTask` 回来）
- **选集用网格不用列表**；**能不能点不能按 `videoUrl` 判**（内嵌线路和按需取址的列表里压根没有真实地址）
- **分批解析**：单请求最多 40 集（CF 50 subrequest 硬顶），超出用 `offset` 分批不截断；**未解析完时禁用播放按钮**
- **可达性检测按钮**（`ReachCheck.vue`）：**解析出地址 ≠ 播得动**。喂给它的 Origin/Referer **必须与送进播放器的完全一致**；
  **点到哪条线路就自动测哪条** → **必须防竞态**（abort + **自增序号认领结果**，被中止的那轮不抛异常而是带 `unknown` 正常返回）。
  **结论没过才二次确认，过了一句不问**（每次都弹会把用户训练成无脑点确认）。
  **播放器开新标签**（`window.open` 只能在用户手势调用栈里同步调）
- **刷新链接**：原地重解析整份替换，按「集名 → 地址」算出增删改并明确回报；**按集名认当前集不按下标**；
  地址一换要先把 `currentTime` 搬到新地址上
- **`playlistNames` 按 URL 存**不要改成按下标的数组；**`window.history.replaceState` 必须写全 `window.`**
  （本组件有个叫 `history` 的 ref 会遮蔽全局）

## 各站实测结论

- **nbmovie 系（4kvm / ziziys）**：同一套程序换皮，接同族站点只需往 `PATTERN` 和 `CODED_PARSE_SITES` 各加一个域名
  （**两边必须同步**），地址一律从 `ctx.pageUrl` 的 origin 现拼。真实地址由 wasm 的 `build_play_url` 生成，
  **令牌 `k` 来自页面里的 `userlink`**（少了 401）；**wasm 会读 `<meta id="nb-plt">` 当时间戳，每次签名前都要刷新**。
  wasm 传 **ArrayBuffer** 避开 MIME 校验。**别用剥标签的办法取集名**（属性里有 `=>`，`<[^>]*>` 会断在中间）
- **MacCMS 系（ylsp / netflixgc）**：地址在 `player_aaaa` 的 `url` 里。**`encrypt` 决定编码但不要按它分支**
  （同站不同线路可以不同）→ `sourceDecode: 'maccms'` 自适应剥到 http 开头、**层数硬封在 2 层**。
  **当前线路的 class 标记各站不同**（`activeFlagRe`，认错不报错只是悄悄落到第一条）。
  **选集容器不能用 `</div>` 收尾**（当前集的 `<a>` 里嵌了 `<div>` → 整条线路只剩 1 集）。
  **防盗链域名可以跟播放页毫无关系且不该写死** → `playerOrigin` 从站点播放器配置里现取
- **kpkuang**：地址在 `data-play`（**随机前缀 + base64** → `base64-scan`）。**防盗链域名每条线路一份**
  （写在 `data-pars` 上）→ **绝不能按 host 缓存**。26 条线路里 4 条给的是第三方播放页 → `sourceMediaOnly: true`
  （**这类做不到**：地址由第三方在浏览器里用混淆 JS 现算）
- **内嵌播放器的「反内嵌」自检提示都提 Sandbox，别当成防盗链或正则问题**：EV 线探的是 `document.domain` 在沙箱里必抛，
  **没有 token 可解**（`allow-document-domain` 不是合法 token，加了现象一模一样——别再往那个方向试），
  唯一出路是整个摘掉属性 →「限制广告」开关（**默认关**，iframe 的 `:key` **必须带上它**，sandbox 是文档创建时定死的）。
  追这类问题别猜 flag：**拉下 bundle 搜 `Sandbox`**

## 状态持久化（localStorage）

`video-player-state` · `video-probe-dead-direct`（按 host 记「直连是黑洞」）· `video-player-learned-profiles` ·
`video-player-origin-history` / `-referer-history` · `video-parse-rules` /
`-embed-sandbox` / `video-parse-last-result`（1 小时）· `video-watch-history`（**看到第几集**，按剧名存）·
`video-show-prefs`（**倍速与片头片尾**，按剧名存）· 各页 `*-settings` · `utools-history-<page>`。

**「永久保存」= `navigator.storage.persist()`，不是「localStorage 没有 TTL」**：没授权时 Chrome/Edge 会按 LRU
**整个 origin 一起驱逐**，Safari（ITP）**7 天不访问就删**且不支持 `persist()`（只能如实标出来）。先 `persisted()`
再 `persist()`（已授权还去调会在 Firefox 白弹一次窗）；**请求时机必须挂在「真的写下了一条」之后**，绝不在页面加载时请求。

## 踩过的坑（通用）

- **CF Workers 无 `process`**：判空后再动态 `import('undici')`，specifier 必须用变量 + `@vite-ignore`
- **服务端的 module 级缓存在 CF Pages 上只活在当前 isolate 里**，换个 isolate 就是空的——**本地 Node 单进程反而一直命中，
  所以这类 bug 只在线上偶发**。凡是「服务端记着、客户端不带」的都踩得到：ncat22 的反爬令牌就是这样，按需取址那一发
  `?step=extract&only=1` 读不到缓存 → **409**，而这条路径走不到 `step=challenge`、没有算 PoW 的出路 →
  **「从 parse 进 player 报错，刷新又好了」**。修法是**让浏览器持有令牌、每一发都自己带上**（`usePowCookie.ts`），
  服务端那份只当便车，**任何逻辑都不许依赖它命中**
- **`/api/proxy` 遇到上游非 2xx 必须原样透传状态码，绝不能进 m3u8 改写**：403 那页 HTML 会被逐行当相对 URI 拼成
  **200 + m3u8 MIME** → 探测假阳性 + 解析出 0 个分片 → **分片轴整轮 `skip`**。第二道防线：**解析不出任何分片就判 `fail`**
- **被下线的源会 302 到「诱饵图」**（**200 + 一张真 JPEG**，比上一条更毒）：代理通道会判 `ok` → hls.js 每片拿到同一张图 →
  fatal → `recoverMediaError()` → **无限闪屏**。防线是 `DEAD_SOURCE_LANDINGS` 回 **451**，让 `diagnoseProbe` 直说
  「已被 CF 下线」——**这句比「四条通道全部不可达」有用得多**。这张表**只放含义明确、全球一致的落地页**
- **`/api/proxy` 改写 m3u8 时，基准必须取 `response.url`（重定向后）不是 `targetUrl`**：实测清单 302 到同 IP 的另一个端口，
  而原端口是**健康检查口**，对 `.ts` 一律回 200 + 视频 MIME + 3 字节 → 假阳性 → 「可达性全绿但播不了、原网页却能播」。
  **端口错了比 host 错了更难看出来**
- **`recoverMediaError()` 必须有次数上限**：数据本身不是视频时会变成「恢复 → 立刻再失败」的死循环，屏幕**一直在闪**
- **判断「是不是 m3u8」绝不能用 `url.includes('.m3u8')`**（有的站点把它当**目录名**），一律走 `isM3u8Url()` 看最后一段的扩展名
- **改连接策略必须重载视频**，否则 hls.js 还在用上次解析出的分片 URL
- **CF Workers 会静默吞掉非标端口**：`wrangler.json` 的 `compatibility_date` 必须 ≥ `2024-09-02`（本地 Node 一切正常），
  但**千万别加 `compatibility_flags: ["allow_custom_ports"]`**——已是默认值，显式声明会让 Pages 部署在**最后一步**失败。
  `nuxt.config.ts` 那个 compatibilityDate 是 Nitro 特性门控，**跟运行时行为无关**
