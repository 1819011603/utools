# pitfalls

> 从 CLAUDE.md 下沉的细节（原样保留）。需要时再读。

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
