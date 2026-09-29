# account-sync

> 从 CLAUDE.md 下沉的细节（原样保留）。需要时再读。

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
- **拉是一分钟一次，推仍归那道 5 分钟节流管**。打开页面（豁免两道闸）和回到前台（豁免闸①）
  走 `checkRemote`；**前台开着时每分钟一次走 `peekRemote`** —— 补的是「两台设备都开着页面、
  谁都不切标签页」这个洞（没有它，除了开页面和回前台**一辈子不会再问一次云端**）。
  `peekRemote` **只发一发 `?meta=1`**（几十字节、没有 payload），rev 全对得上就到此为止，
  真变了才叫 `syncNow({ force: true })`。**不能图省事直接每分钟跑一轮 `syncNow`**：
  那会把推送也变成一分钟一次，而正在看的那台每保存一次进度就标一次脏 → 每分钟一个 POST + 一次 D1 写入。
  另外三条纪律：**认不出的 coll id 要滤掉**（本机没有 rev，比出来恒为「变了」→ 每分钟白跑一整轮）、
  **失败一声不吭**（后台探测，弹错只会打断看片的人）、**绝不动 `lastSyncAt`**（那是节流的时钟，
  顶掉它会把推送推迟到下一个窗口）。`hidden` 时跳过，回前台那一发已经覆盖
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
