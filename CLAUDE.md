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
- **加线程只有一个正当理由：单条被限速了**（`soloFastCap`）。判据是 `bw.soloConnKBps()`
  ——**只取低并发（≤2）档的采样，绝不能用混了各并发档的 `perConnBps`**：每 IP 限总量的源上 6 条各自都慢，
  用均值会把「单连接被限速」判反（越多开越显得该多开）。单条够快就封在 2~3 条（越快越少），三道让路：
  **门槛必须 × 倍速**（表里的数是 1x 的尺子，3x 下单条 1MB/s 只相当于 340KB/s，照 1x 量会在最吃紧时收线程）、
  **存货没过阶梯放开线整条不参与**（起播/切集/拖进度那一刻只有「够播几秒」要紧，别跟 ② 抢方向盘）、
  **不低于 `catchUpFloor()`**（它是 min 链的一环，压穿地板就重演慢源自锁）。
  敢压到 2 条是因为**关键路径不受它管**：hls.js 正在等的那一片走 `fragLoader`，有自己的 `maxRacers` 可越过预取上限
- **「加线程 → 单条被摊薄 → 算出需要更多条 → 再加线程」是个自我强化的正反馈，必须两头都掐**
  （实测截图：单条 369KB/s 被摊到 222KB/s、聚合 20.8Mbps 是 5.2Mbps 码率的 4 倍、卡了 3 次，线程仍钉在 12）：
  ① **问「这个源要几条才喂得动」的地方（地板）分母必须用单条基线**（`requiredConn(..., solo=true)`，
  取低并发档的 `perConnLow`），用被摊薄的混合均值就是把自己的病因当药吃；
  ② **`catchUpFloor` 要有「聚合已经喂得动就不抬」这道闸**（`aggregateFeeds`）——地板的立论是「源真慢」，
  聚合是码率几倍时那前提不成立，抬地板只会推得更狠。地板是 `max`，不掐它等于所有帽子全废；
  ③ **判「摊薄型 vs 真慢型」不能用 `requiredConn <= 当前线程数`**（两头都随摊薄漂移，越摊薄越判成真慢
  → 地板抬到 hostCap → 更摊薄），要用**实测峰值聚合**跟需要的吞吐比；
  ④ 稳态帽用**饱和并发 = 峰值聚合 ÷ 单条基线**（`saturationConn`，截图里 ≈7，即 12 条里 5 条纯属摊薄）。
  **但它必须严格低于「试过的最高并发档」才可信**（同 `bestAggConn` 那句 `best.conn >= maxTried`）：
  只在 2 条上测过时峰值聚合就是 2×单条 → 算出饱和 2 → 把地板也封在 2 → 再没机会往上试 = 自锁。
  慢源上表现为**线程数永远上不去、一条 [conn] 日志都不再打**（5x 下存货墙钟长期停在濒卡档，
  保险线 5s 墙钟 = 25 视频秒，唯一能救的 `catchUpFloor` 又被这个假饱和值封死）。
  **保有率只能当快信号不能当稳态判据**：收完线程它自己就回升 → 帽子自解除 → 又加满 → 又摊薄，来回振；
  ⑤ **任何地板都封在饱和并发以内**（`saturationLimit`）——地板是唯一往上顶的一级，不封它前面八级全废。
  实测「1 线程 → 12 线程」的跳变就是它：抗卡主动 pause → 暂停顶格，而存货 0 + 3x + 刚卡过让
  `requiredConn × 2` 也顶到 hostCap，②~⑦ 一起被顶穿
- **存货阶梯的放开方向必须有迟滞**（`WALL_STEP_HYST` 25%，收紧不加——收紧是救命方向）：
  没迟滞时存货在某条线附近来回就每拍换档，倍速越高越明显（5x 下四条线换算成存货是 10/25/37.5/50s，
  而存货本来就在几十秒区间锯齿）→ 实测连着二十几行 `2 → 3 → 4 → 3 → 2`。
  **危害不是抖而是毁采样**：每次目标变化都 `markConcChange()` 作废一次分档账本，而一片要下一两秒
  → 没有样本活到记账 → `饱和` 永远没数据、单条基线剧烈跳动 → ④⑤⑥ 三级集体失能。
  所以这道迟滞是那几级能不能工作的**前提**
- **卡顿守卫在「没有聚合读数」时必须闭嘴**（`peakAggBps() <= 0` → 不收也不抬）：
  「摊薄型 vs 真慢型」全靠拿聚合跟需要的吞吐比，peakAgg=0 时那个比较恒 false → 一律落进真慢型 → 地板顶穿一切。
  这个组合**切集后头几拍必然出现**：`resetStrategy` 清了带宽样本，但**卡顿时间戳是跨集的**，
  而 `hasSamples()` 只看 perConnBps、有一片就为真，聚合分档账本却还空着
- **`headroomConnCap` 的「已到目标」判据要留一片死区**（`gap <= 分片时长`，不是 `gap <= 0`）：
  贴着预加载目标时会每拍在 0↔1 条之间抖，而每次变化都会 `markConcChange()` 作废一次分档账本，把采样搅乱
- **排查并发决策时临时加日志，要把九级的值全打出来并点名咬人的那一级**（只在目标变化时打一行）：
  只打结果等于没打——「12 线程」可能是九级里任何一级的结果，尤其分不清是不是地板（唯一的 `max`）
  把前八级顶穿了。**每一次「以为是某一级的错」的判断，最后都是别的一级**
- **`stallGuard` 的时间基准是 `performance.now()`**（`useStallTracker.lastStallAt` 记的就是它）。
  曾误写 `Date.now()`，两个基准差三个数量级 → 差值恒 > 窗口 → **整个卡顿守卫从来没生效过**，
  而它是「摊薄型收到 3 条」唯一的入口
- **加线程的闭环是不对称的，必须按这个不对称来写**：加线程后单条速度**当场就掉**，
  而减线程后速度**不会立刻回来**（在途下载不能回收，实际并发要等它们各自跑完）。三个后果各有对策：
  ① **单条速度优先于聚合速度**（`soloRetainRatio` = 当前每连接 ÷ 低并发档基线）——加线程只在保有率没掉多少时才允许，
  <70% 收到 3 条、<45% 收到 2 条（`dilutionCap`）。聚合拐点要等各档攒够样本，慢一大截，只能当后备。
  连 `stallGuard` 也要让路：**单条被摊薄时一律判摊薄型**，别按「聚合喂不动」抬地板到 hostCap（那是往火上浇油）。
  ⓪ **升一律一档一档来（`CONN_RAMP_MS`，每 700ms 最多 +1），地板顶格也必须走这条路**：
  真慢型的 `guard.floor` 是 `hostCap`，而地板是 `max`、不受任何帽子约束 → 实测「3 → 12 一步到位」。
  逐档爬还有个副作用收益：**分档账本每一档都留下样本**，而饱和并发要「饱和点严格低于试过的最高档」
  才可信——跳级上去只有起点和终点两档有数，那个判据永远等不到数据。
  ② **沉降期只锁「升」不锁「降」**（`CONN_SETTLE_*`，长度取实测 `avgSegLoadMs`，夹 1~5s）：
  刚减完那一两拍读数还是高并发时的低值，照它决策就会立刻加回去 → 又摊薄 → 再减，谁也不让谁。
  降始终放行（存货阶梯濒卡那档必须随时生效），且各条帽子都是绝对值算式、不累加，连续降不会踩过头。
  ③ **跨越并发变更点的采样绝不进分档账本**（`markConcChange` + `sampleSpeed` 的 `startedAt`）：
  「在 6 条里挤着下、在 2 条时交货」那几片会把**低并发档污染成低速**，而低并发档正是 `soloConnKBps` 的唯一依据
  → 「刚减完 → 看着单条变慢 → 判定被限速 → 又加回去」，加减各一次就自锁
- **并发决策优先级**（取 `min`，然后 `max` 地板，最后沉降期）：① 冷启动帽 ≤3 ② 存货墙钟阶梯 ③ 卡顿守卫
  ④ 摊薄帽 ⑤ 单连接够快 ⑥ 聚合拐点 ⑦ 缺口速率 ⑧ 地板 ⑨ 沉降期。
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
- **右键菜单**（`useVideoContextMenu` + `ContextMenu.vue`）：倍速 / 媒体信息 / 复制地址 / 画中画 / 全屏。
  单独一层不并进手势层（那边判的是「一次左键交互算什么」，右键按下即成立，没有共享状态）。
  **必须挂在 `playerContainer` 内、坐标用容器相对值**——容器就是全屏元素，挂 body 上全屏时一个像素都看不见。
  「点外面就关」的 `pointerdown` 走**捕获阶段**且要**放过 `button === 2`**：Chrome/Windows 上 `contextmenu`
  在 `pointerdown` **之后**才派发，不放过就会「关掉再开」闪一下。
  **媒体信息面板报的是「当前这一帧」的真实像素**，跟清单声明的档对不上是常态（见上面贴片那条），
  所以面板里要**把这句解释写出来**，否则两个数字对不上只会被当成 bug
- **进度条悬浮缩略图**（`useVideoThumbnails`）：这些站点既没有 `EXT-X-IMAGE-STREAM-INF` 也没有雪碧图，
  帧只能自己解，而**随手去下分片抢的正是「决定能不能播下去」那几条连接**。所以**先白捡再花钱**：
  ① 正播着的画面每跨一个 10s 桶就顺手截一帧（挂心跳，零网络零解码器，往回拖时全是现成的）；
  ② 悬浮到没截过的位置才起隐藏解码器，且**先吃 `getSegBuf`（主播放已经下过的分片）**，
  真 miss 才下，**`healthZone` 吃紧/濒卡或离线时一票否决**。
  五个必须照做的点：**自定义 `fLoader` 命中缓存也要 `setTimeout(0)` 再交货**（同主播放那个坑）；
  **解码队列深度 1 + latest-wins**（扫过进度条会点名几十个桶，全排队等于把连接占死）；
  **命中缓存的那些不走防抖**（等 220ms 会一格一格地卡）；**抓帧要等 `requestVideoFrameCallback`
  不能在 `seeked` 里抓**（`seeked` 早于新帧落地，抓回上一帧——跟解析页那个 1080p 是同一个坑）；
  **图位恒占高**（有图无图不能改卡片高度，否则沿进度条扫过去整块上下跳）。
  **整片 MP4 不做**：它的 `<video>` 直连 CDN（加 `crossorigin` 就整个播不了），
  画到 canvas 上必然污染、`toDataURL` 直接抛 SecurityError；HLS 走 MSE（`blob:` 同源）没这问题
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

### 媒体库与换源（左侧悬浮抽屉 `components/LibraryDock.vue`）

左边缘一竖条悬浮按钮：**收藏**（常驻一颗，一下就完的动作不该先点开面板）→ **媒体库**
（`LibraryPanel` = 播放历史 + 收藏影片，行长得一样，共用 `LibraryRow`）→ **换源**
（`LinePicker`，线路表来自最近一次解析）。**不放进页面下方那串折叠卡**：
「想换部剧、想换条线路」都是看着画面当下冒出来的念头，而折叠卡在滑三屏之外。

**窄屏（手机竖屏）默认收成一根 10px 的把手**，点一下才滑出那几颗，点完自动收回：
手机上页面是通栏的，这一竖条必然压在正文上（实测安卓上红心正好盖住剧名、下面两颗盖住信息行
和「换线路」）。位置也从垂直居中挪到 62%——那里对着页面下半段的折叠卡区，展开也压不到标题。
宽屏两侧本来就有留白，保持常驻。

**同一个组件挂在三个页面上**（放映厅 / `/video-search` / `/video-parse`）——追剧这件事在这三处是连着的。
所以它**只能用 `useVideoPlayerCtxOptional()`**：后两个页面根本没有播放器，用抛错那版会让页面白屏。
没有 ctx 时「换源」和「收藏当前」都不出（都要有正在播的那部剧才谈得上），点一条一律整页跳转。

- **抽屉必须 `Teleport to="body"`**：播放器容器上有 transform（全屏动画、手势），`fixed` 一旦落进
  带 transform 的祖先就以那个祖先为参照，位置直接跑偏。**全屏时整块 `v-if` 掉**（fixed 元素在全屏元素外，
  留着只会在退出全屏那一瞬间闪一下）
- **点一条要落到「同一集 + 同一进度」**，两条路：同一部剧同一条线路 → 直接 `playByIndex`，不重解析；
  换一部剧 → **整页重进** `?parseUrl=…&t=秒`（本页只在 mount 时读一次地址栏，同路由换 query 不重新装配，
  用 router 跳等于点了没反应）。**query 手工拼，不用 `URLSearchParams`**——它把空格编码成 `+`，
  而入向刻意「不把 `+` 当空格」，剧名/集名带空格时会串成字面的 `+`
- **`t` 只入不出**：写回地址栏的话刷新一次就又被拽回那个位置。它也**不直接 seek**，而是写进 `savedProgress`
  让原有起播路径落位（HLS 那条是 hls.js 的 `startPosition`，手动 seek 会打断刚起播的加载），
  且**只在比本机已有记录更靠后时才写**（本机那份多半更新，拿旧的盖掉 = 「点续看反而倒退」）
- **看到片尾区时 `WatchRecord.time` 记 0**（同 `savedProgress` 那边删记录的理由）：记下来的话从侧边栏点进去
  恢复到片尾，一恢复就落进「跳过片尾」的判据里当场被弹走，**这集永远看不成**
- **换源走 `loadFromParseSource` 同一条路**（不是另起一套）：按需取址的作业单、防盗链候选、集名表都在那里面装好。
  集数按**集名**认、序号兜底（各线路集数常常不一样）；进度当 `startTime` 带过去。
  切换中那一条**只换转圈图标，绝不 `:disabled`**（同「上/下一集」那条）
- **封面只存地址不存图**（`WatchRecord.cover` / `FavoriteRecord.cover`）：这两份清单要整份上云，
  塞 base64 缩略图会让一条从几百字节涨到几十 KB。服务端一律抓 `og:image` 这类通用元信息（`parseCover`），
  **不为每个站写选择器**——站点改版时正文里的 `<img>` 类名说变就变，而分享卡片的 meta 是站点自己要维护的。
  显示走 `PosterImg.vue`：`no-referrer` → 失败退 `/api/thumb` → 再失败画占位块
- **`recordWatch` 的封面「只补不删」**：换条线路解析时那一页未必有 `og:image`，整条覆盖会把上次抠到的图冲掉
  （表现是「列表里的图看着看着自己没了」），老记录也靠这一句慢慢补齐
- **抽屉里只摆前 4 条，其余进「查看更多」**（`LibraryBrowser.vue`：搜索 / 分类 / 按天分组 / 多选删除 / 清空）。
  **「查看更多」有没有超出都给**——只按「条数 > 4」才给的话，只有 3 条的人永远找不到清空按钮。
  清空走 `recordClear`（一个 `clearedAt` 时间戳）而不是逐条删（200 条 = 200 个墓碑要上云），
  且**要二次确认**：它跨设备生效。**管理模式下点整行是「选中」不是「播放」**（点一条就跳走的话根本选不完）
- **分类（`cat`）是抠出来的，不是配的**（`parseCategory`）：优先 JSON-LD 面包屑
  （`"name":"国产动漫","item":".../vodtype/31/"` —— 它是**这一部片**的分类），再退回正文里的分类链接、
  `description`/`keywords`。**绝不能取导航栏里第一个分类链接**：那排「电影/电视剧/综艺/动漫」每页都全，
  取到的永远是排第一的那个。筛选按钮**按实际出现过的值动态生成**，不写死一张分类表
  （抠不到分类的站点很多，写死只会摆出一排点进去空空如也的按钮）
- **老记录的封面靠后台慢慢补**（`useCoverBackfill` + `GET /api/cover`）：三条纪律——**串行 + 1.2s 间隔**
  （并发抓等于给源站来一轮压测，还跟正在播的那一集抢带宽）、**只在媒体库开着时跑**（关掉即停手）、
  **抓不到就记进 `video-cover-miss`，24 小时内不再试**（有的站压根没有 og:image、有的片已下架，
  不记的话每次打开都要把这些必然失败的重跑一遍）。`/api/cover` 只抓页 + 两条正则，**不走 `/api/resolve`**
  （那条要抠整季选集表、可能过反爬握手、按需取址的站还会被限流）。补进记录时**绝不动 `at`**
  ——那是「最近看过」，补一张图就把这部剧顶到列表最前面
- **搜索支持拼音**（`usePinyinMatch`，`xianni` / `xn` 都能命中《仙逆》）：字典 40 多 KB，
  **敲了纯字母才动态 import**，加载完 `ready` 变真让 computed 自己重算一遍。
  匹配**按单个字段问**，不拼成一整条 haystack——拼起来「仙逆」+「动漫」会连成 `xiannidongman`，
  搜 `nid` 这种跨字段的乱码反而能命中

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
  **播放器开新标签**（`window.open` 只能在用户手势调用栈里同步调）。
  **清晰度探测不能只看第一帧**：不少源站在正片前面拼了一段贴片（`#EXT-X-DISCONTINUITY` 隔开，
  且贴片那几片常常**不加密**、正片才带 `EXT-X-KEY`），两段编码压根不是一个 ——
  实测 ylsp 某剧前 8.1s 是 1920×1080@30 的贴片、正片是 1920×808@25，于是
  **「解析页写 1080p、点进去变 808p」**（播放器靠 `resize` 播过分界点自己修正，只有这里会把贴片的数字一直挂着）。
  办法是**往里跳一段再取**（时长的 10%，夹 15~120s），**不解 `#EXT-X-DISCONTINUITY`**
  ——有的站压根不打这个标记、只是把两段拼起来，那时分界点无从可查，而跳一段不在乎有没有标记，代价一样是多下一片。
  **收工信号要听 `loadedmetadata`/`resize`/`seeked` 三个**（取样点跟片头分辨率相同时 `resize` 不会来，
  只听前两个会每次白等到超时）。没跳到位（密钥取不到之类）时**日志必须说清**，否则等于拿贴片的数字冒充正片
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
`video-show-prefs`（**倍速与片头片尾**，按剧名存）· `video-favorites`（**收藏影片**，按剧名存）·
`video-cover-miss`（封面补不到的剧，24 小时内不再试）· 各页 `*-settings` · `utools-history-<page>`。

同步账号那侧：`cloud-sync-token` / `cloud-sync-user`（令牌与用户名）· `cloud-sync-meta`（见下）。

**「永久保存」= `navigator.storage.persist()`，不是「localStorage 没有 TTL」**：没授权时 Chrome/Edge 会按 LRU
**整个 origin 一起驱逐**，Safari（ITP）**7 天不访问就删**且不支持 `persist()`（只能如实标出来）。先 `persisted()`
再 `persist()`（已授权还去调会在 Firefox 白弹一次窗）；**请求时机必须挂在「真的写下了一条」之后**，绝不在页面加载时请求。

## 账号与云同步（Cloudflare D1）

登录后把 **4 份清单**同步到 D1，换设备接着看：`video-watch-history`（追剧进度，含封面地址/分类/秒数）·
`video-favorites`（收藏影片）· `utools-history-video-search`（片名搜索历史）·
`video-show-prefs`（每部剧的倍速与片头片尾）。**新增一份要改三处**：`cloudSyncSpec.ts` 的清单表、
服务端白名单 `server/utils/syncColls.ts`、以及那份数据自己的 `markDirty`/`recordDelete` 调用点
（漏最后一处的表现是「那一类数据永远同步不上去」）。
**一律只同步「清单信息」**：播放地址带时效签名（存下来必是死链且失败静默），不上传；
视频解析历史（2000 条）也不收 —— 它比其余几份加起来还大，而它的价值本来就依赖那个站还活着。

`server/api/user/{register,login,salt,quota,sync}` · 存储层 `server/utils/userStore.ts` ·
令牌 `server/utils/authToken.ts` · 前端 `useUserAuth` / `useCloudSync` / `cloudSyncSpec`（清单表）/
`cloudSyncMerge`（纯合并规则）/ `cloudSyncLocal`（本机账本）· UI `components/user/Auth{Button,Modal}.vue`
（挂在 `layouts/default.vue`，**弹窗挂布局根上**——`/video-search` 不出 header，嵌在按钮里会一起没）。

- **口令拉伸必须放前端**（`PBKDF2` 12 万次，服务端只做一次 SHA-256）：**CF 免费版每请求只有 10ms CPU**，
  服务端跑不动 —— 同 PoW 那条。代价是登录要等一秒多，**按钮必须有 loading**，否则会被连点。
  `crypto.subtle` 只在安全上下文有，**局域网 IP 的 http 打开时它是 undefined**，要说清而不是抛
  「Cannot read properties of undefined」
- **`/api/user/salt` 对不存在的用户名要回一个假盐**（`HMAC(secret, 用户名)`，**必须确定性**，随机的话
  连问两次就露馅），否则它就是个免费的用户名枚举器。同理「用户名不存在」与「口令不对」回同一句话
- **名额上限 5 个（`MAX_USERS`），判断必须和 INSERT 同一条语句**
  （`WHERE (SELECT COUNT(*) FROM users) < ?` + `OR IGNORE`）：先查再插的话两个人同时注册会双双通过
- **payload 一律走 `.bind()`，绝不拼进 SQL**：D1 单条语句上限 100KB，而字符串/行上限是 2MB
  ——拼进去几十 KB 的收藏夹就顶到语句上限，绑定参数不计入语句长度。另外**一个清单一行**
  （不是一个用户一个大 blob）：单行小、只推脏的那几份、两台设备改不同清单时不会互相撞 rev
- **删除必须有墓碑**（`tomb` / `clearedAt` 跟着 payload 一起上传）：只做并集的话删除永远传不出去，
  「A 取消收藏 → B 下次同步又推回来」，而且**只在多设备时发作**，本机怎么试都是对的。
  判据是「删除时间 ≥ 条目时间」而不是「存不存在」——删掉之后又重新收藏的那条要留下
- **合并输出必须是确定性的**（map 按键排序、list 排序有稳定第二关键字）：
  「跟云端那份一样吗」是靠 `JSON.stringify` 比的，不确定就每 5 分钟白推一次
- **每一份都按时间合并，`video-watch` 也不例外**（`show-prefs` 按 `mt`，其余按 `at`）。
  **踩过：曾给 `video-watch` 开过「同一部剧一律取本机」（`SyncSpec.preferLocal`，现已删除）**，
  说法是「本机那条记的是眼前正在发生的观看」——但那个保险本来就是多余的：
  正在播的那部剧 `recordWatchProgress` 每保存一次进度就把 `at` 刷成现在，按时间比照样赢。
  代价却是**两台设备都看过的剧永远合不进来**（本机反过来把云端顶掉，还推上去覆盖对方），
  症状是「换台设备接着看，进度根本不同步」，且**只在同一部剧上发作**——拿一部新剧试永远是好的
- **「有变更才同步」那道闸曾经把「拉取」也一起挡住了**：本机没有待上传的改动时一个请求都不发，
  于是另一台设备的更新永远拉不回来，表现是**「两台机器状态不一致、看着像本地缓存优先」**。
  现在**打开页面**（豁免节流）和**回到前台**（受节流）各问一句云端变了没（`checkRemote`）——
  代价只有一发 `?meta=1`。拉回来之后**界面要跟着重算**：媒体库走 `onSyncApplied`，
  播放器和解析页的「上次看到第 N 集」也各订阅一份（同步是异步的，多半比起播/解析晚回来）
- **拉取分两发，别每轮都拖全文**（`GET /api/user/sync?meta=1` → 只有变了的那几份才 `?colls=a,b`）：
  payload 是几十~几百 KB 的 JSON，而同步的**常态是云端一份都没变**（多数人只有一台设备），
  原来每轮把四份全文拉一遍，「拉取慢」就是这个。**rev 一样时不需要云端正文也能算合并结果**：
  上一轮已经把云端并进本地了，之后云端没动 → 本地当前值就是并集，只需按脏标记决定推不推。
  这条推断在两种情况下不成立，必须走全量：**首次同步**（本机没有 rev 可比，自然会拉）
  和**撞 rev 之后的重来**（别的设备刚写过，本机记的 rev 已不可信 → `cycle(true)`）
- **两道闸**：① **有变更才同步**（`dirty` 空就不发**推送**），例外是几个「该问问云端」的时机
  （见下条）和**这台设备从没同步过**（`rev` 空）—— 否则「换设备接着看」等于没做；
  ② **两次之间至少 5 分钟**，落在窗口里的改动只留 `dirty` 标记不发请求。
  **节流时钟用「上次尝试」不是「上次成功」**：用成功当时钟的话一旦没网，每次改动都会立刻再撞一次。
  用户手点「立即同步」两道闸都豁免（那是明确意图，而他点它往往正是想拉对方的改动）
- **拉取有三个时机，都走 `checkRemote`（只豁免闸①，不豁免节流）**：打开页面（这一发连节流也豁免）、
  回到前台、以及**前台开着时每 5 分钟一次**。最后这条补的是「两台设备都开着页面、谁都不切标签页」
  —— 没有它，除了开页面和回前台**一辈子不会再问一次云端**，一台上追的进度另一台永远等不到。
  **定时器每分钟醒一次、节奏交给那道 5 分钟节流**（时钟是「上次尝试」）：自己掐 5 分钟会跟节流窗口
  错开一点点、隔一轮被挡掉一次 → 实际变成 10 分钟。`hidden` 时直接跳过（回前台那一发已经覆盖）。
  代价只有一发 `?meta=1`：云端 rev 没动就到此为止，一个正文都不取、一个 POST 都不发
- **三种「用户自己动了看到哪儿」的动作豁免节流跑一轮**（`requestSyncFlush` →
  `syncNow({ skipThrottle: true })`）：**按下暂停 / 手动拖进度 / 切换集数**。
  那一刻进度刚落库、人多半要走开或换设备，正该把它推上去；跑完 `lastSyncAt` 更新，
  5 分钟窗口从那一刻重新开始算。**只豁免节流，不豁免「有变更才同步」**。
  **必须挂在用户动作上，绝不能挂 `<video>` 的 `pause`/`seeked`**——抗卡会主动 pause 去攒秒数、
  卡死自救会微跳播放头、播完会自动切下一集，那些每分钟能发生好几次，一发就同步是往火上浇油
  （所以切集那处的判据是 `!opts.auto`）。去重（30 秒）收在 `requestSyncFlush` 里，
  三处调用方不各写一份
- **`dirty` 必须落 localStorage**：改一下就关标签页是最常见的操作，放内存等于那次改动没记
- **清单表里删掉一份时，老用户账本里那条标记没人清**（`pruneUnknown`）：同步一轮只遍历
  `SYNC_COLLECTIONS`，于是「有变更才同步」那道闸恒为真 → **黄点永久亮着 + 每 5 分钟白跑一整轮**，
  一直到用户自己清浏览器数据。**已经踩到**：音乐那两份（`music-fav` / `music-search`）
  上线过一版，随后整个音乐功能被移除。所以 `readMeta()` 之后要按清单表把
  `dirty`/`rev`/`tomb`/`clearedAt` 里认不出的 id 全剪掉 —— 清单表本来就会增减，账本得跟着收敛
- **`video-show-prefs` 的合并只能按 `mt` 不能按 `at`**：`at` 在 `applyShowPrefs` 里也会被刷
  （那是 LRU 的「最近看过」）→「A 改了倍速、B 只是打开看了一眼这部剧，结果 B 的旧值赢」。
  配套 `save(s, false)`：只刷 LRU 时间戳那一笔不标脏，否则「打开播放器就同步」
- **合并结果是直接写 localStorage 的**，持在 ref 里的那些要重读：收藏夹走 `reloadFavorites()`，
  两处搜索历史走 `onSyncApplied` 事件（它们是 `ref(getHistory())` 的快照，不重读就得刷新页面才看得到）
- **没有 D1 绑定时线上必须报 503 说清「绑定没配」**，绝不能掉进本地文件兜底那条路
  ——那会报 `Dynamic require of "node:fs/promises" is not supported`，一句跟真实原因毫无关系的话。
  同理 `USER_TOKEN_SECRET` 缺失一律 503，**绝不退回硬编码默认值**（那等于令牌可任意伪造，且毫无症状）
- **本地 `nuxt dev` 没有 D1 绑定** → `userStore` 有一份 `.data/*.json` 的开发兜底（判据是 `process` 存在），
  没有它账号功能在本地一步都跑不动

**部署四步**（做完之前账号功能就是线上 503，但**其余功能一切正常** —— `wrangler.json` 里
默认压根没有 `d1_databases` 这一段，就是为了不拖累部署）：

1. `npx wrangler d1 create utools-users` → 记下 `database_id`
2. 把下面这段加进 `wrangler.json`（**顶层 = production，`env.preview` 再来一份**，Pages 两个环境各自绑）：
   ```json
   "d1_databases": [{ "binding": "USER_DB", "database_name": "utools-users", "database_id": "真的 UUID" }],
   "env": { "preview": { "d1_databases": [{ "binding": "USER_DB", "database_name": "utools-users", "database_id": "真的 UUID" }] } }
   ```
3. `npx wrangler d1 execute utools-users --remote --file=./server/db/schema.sql`（`userStore` 也有懒建表兜底）
4. `npx wrangler pages secret put USER_TOKEN_SECRET`（32 字节随机 hex）

**`database_id` 绝不能留占位串**：Cloudflare 在 publish 阶段就校验它，
`Error 8000022: Invalid database UUID` 会让**整个 Function 发布失败**（资源已经上传完了才报，
日志上半段全是 `Success`，很容易误读成别的问题）—— 也就是说一个假 UUID 会连带把
放映厅、解析那些跟账号毫无关系的接口一起弄挂。宁可先不写这一段。
另外 **JSON 里不要塞 `"//"` 当注释键**：wrangler 每次都会警告
`Unexpected fields found in top-level field: "//"`，构建日志里多一条噪音。

## 踩过的坑（通用）

- **CF Workers 上没有 Node 的那套 API**（`undici`、`node:fs`…）：判空后再动态 `import()`，
  specifier 必须用变量 + `@vite-ignore`。
  ⚠️ **但别拿 `process` 来判「是不是在 Node 里」**：workerd 上 `globalThis.process.env` **是存在的**
  （一个空对象），`globalThis.process?.env` 这个判据在线上恒为真。
  `siteFetch` 用它读 `HTTPS_PROXY` 没事（读出来是 undefined，正好等于「不走代理」），
  但**凡是「Node 才有的能力要不要走」这类分支，一律用 `import.meta.dev`**（Nitro/Nuxt 构建时替换成常量，
  客户端和服务端都有，还能顺带把另一条分支摇掉）。
  **踩过**：`userStore` 曾用 `process?.env` 判断该不该退回本地文件存储，
  于是线上把整条本地兜底路走通了——`/api/user/quota` 一本正经地回 `0/5`（其实是 `node:fs` 导入失败
  被当成了「文件不存在」），注册 500，日志里一句「绑定没配」都没有
- **服务端的 module 级缓存在 CF Pages 上只活在当前 isolate 里**，换个 isolate 就是空的——**本地 Node 单进程反而一直命中，
  所以这类 bug 只在线上偶发**。凡是「服务端记着、客户端不带」的都踩得到：ncat22 的反爬令牌就是这样，按需取址那一发
  `?step=extract&only=1` 读不到缓存 → **409**，而这条路径走不到 `step=challenge`、没有算 PoW 的出路 →
  **「从 parse 进 player 报错，刷新又好了」**。修法是**让浏览器持有令牌、每一发都自己带上**（`usePowCookie.ts`），
  服务端那份只当便车，**任何逻辑都不许依赖它命中**
- **目标站自己在 CF 后面时，从 Workers 打它最难，而这只有线上才发作**：出口 ASN 是 Cloudflare 自己、
  `cf-worker` 头运行时自动加且删不掉、TLS 指纹是 workerd 固定那一个 —— **四个信号里只有请求头在你手里**，
  所以「本地 curl 通」只能排除「压根连不上」，排除不了「拦机房出口」（本地出口是家宽，风控眼里是另一种访客）。
  判据：先 `curl -sI https://<host> | grep -i '^server:'` 看是不是 CF 客户；是的话**挨条路径探、别只探首页**
  —— 只打某几条路径就找别的入口（kpkuang 的 `/vodsearch/` 挂人机校验，绕去首页那个 JSONP 接口就通了），
  全站都打则**没有能改的东西，别接**。接之前一律用**线上** `/api/proxy?url=&referer=` 实测，不用本地 curl
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
