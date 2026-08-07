---
name: video-parse-site
description: 给 /video-parse 接一个新的视频站点（把播放页地址解析成整季 m3u8）。从抓页、认结构、写规则到实测验证的完整 SOP，含 MacCMS 系站点的模板和踩过的坑。触发词：加新站点、新增解析域名、支持这个网站、解析不了、规则不匹配、video-parse 加站、接新站、播放页解析。
---

# 给 /video-parse 接新站点

## 0. 先决定走哪条路

抓一次页面，搜播放地址：**地址明文（或可解码）在 HTML 里 → 写规则，不写代码**。

```bash
# 站点常被 DNS 污染，curl 直连会超时，一律走本地代理
curl -s --max-time 25 -x http://127.0.0.1:7897 \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' \
  -o /tmp/site.html 'https://<播放页地址>'

grep -o 'player_aaaa[^<]\{0,300\}' /tmp/site.html   # 苹果 CMS？
grep -c 'm3u8' /tmp/site.html                        # 明文地址？
```

| 页面里有 | 走 |
| --- | --- |
| `player_aaaa={...}` | **MacCMS 模板**（见下，国内影视站的绝大多数） |
| 别的形式的明文地址 | `BUILTIN_PARSE_RULES` 加一条规则 |
| 地址要另调接口 / 签名 / 解密 | `server/parsers/sites/<id>.ts` 写策略，见 CLAUDE.md「接新站两条路」第 2 条 |

只有第三种才需要写代码。前两种都是往 `composables/videoParseRules.ts` 的
`BUILTIN_PARSE_RULES` 加一条数据。

## 1. MacCMS 模板

`player_aaaa` 是苹果 CMS 的播放数据，`url` 字段就是地址，`encrypt` 决定编码：

```bash
python3 -c "
import re,json
h=open('/tmp/site.html',encoding='utf-8',errors='ignore').read()
d=json.loads(re.search(r'player_aaaa\s*=\s*(\{.*?\})\s*</script>',h,re.S).group(1))
for k in ['encrypt','url','from','sid','nid']: print(k,'=',repr(d.get(k))[:120])
"
```

`encrypt` 0=明文 1=percent 2=base64 套 percent —— 但**规则里不要按 encrypt 分支**，
填 `sourceDecode: 'maccms'` 就行，解码器自适应剥到 http 开头为止。
（同一站点不同线路的 encrypt 可以不同：实测 ylsp=0、netflixgc=2。）

```ts
{
  id: '<短名>',
  name: '<站名> (<短名>)',              // 站名去 <meta property="og:site_name"> 拿
  pattern: '/<短名>\\d*\\.(com|net|tv)/',  // 站点会换域名/后缀，用正则兜住
  homepage: 'https://…/',
  sourceRe: 'player_aaaa\\s*=\\s*\\{[\\s\\S]*?"url"\\s*:\\s*"([^"]+)"',
  sourceDecode: 'maccms',
  lineRe: '…',            // 组1=class修饰串 组2=线路名 组3=副标题(可选)
  activeFlagRe: '…',      // 当前线路的标记，默认 active
  episodeGroupRe: '…',    // 组1=该线路选集容器的内层 HTML
  episodeRe: '…',         // 组1=链接 组2=集名
  lazy: true,             // 默认就该开，见第 3 节
}
```

抠这四条正则时**逐条在 Python 里验证再写进代码**，别攒到最后一起试：

```bash
python3 -c "
import re
h=open('/tmp/site.html',encoding='utf-8',errors='ignore').read()
L=re.findall(r'<线路正则>',h);          print('lines',len(L),L)
G=re.findall(r'<选集容器正则>',h);       print('groups',len(G))
for i,g in enumerate(G):
    print(i, len(re.findall(r'<单集正则>',g)))
"
```

**线路数必须等于选集容器数**，且顺序一一对应（htmlRule 按下标配对）。不等就是正则写歪了。

## 2. 四个反复踩的坑

- **`activeFlagRe`**：当前线路的 class 各站不同（ylsp `active`、netflixgc `on`）。
  认错不会报错，只会默认落到第一条线路——用户点开的那条被悄悄换掉。
- **选集容器不能用 `</div>` 收尾**：当前集的 `<a>` 里常嵌 `<div class="playon">`
  这类小标记，非贪婪匹配断在那里，整条线路只剩 1 集。用 `</div></div></div>`
  或换个不嵌套的标签（`<ul>…</ul>`）当边界。验证时看每组的集数对不对得上页面。
- **标题**：有的站 `<title>` 是一长串 SEO 文案，兜底削站名削不干净，而这个值会顶掉
  播放器标题栏。这时加 `titleRe`（如 `'<title>[^<]*《([^》]+)》'`）。
- **防盗链域名**：视频常挂在与播放页毫不相干的 CDN 上。默认拿播放页 origin 当候选值，
  多数站点够用；**只有当播放页域名和主域都 403 时**才写死 `referer` + `origin`
  （实测 netflixgc.net 的视频只认 `cjbfq.netflixgc.tv`）。两者仍只是候选值，
  播放器的可达性探测照样从直连开始逐级降级。

## 3. `lazy: true` 默认就开

htmlRule 的地址是**逐集抓页**抠出来的，一集一个子请求。不开 lazy 时：40 集一批，
186 集要 5 批上百个请求，慢且容易被源站限流，而用户通常只看几集。

开了之后解析阶段只花 1 个请求（当前集地址直接从本页拿），其余集由播放器切到哪集抓哪集
（`clientTask: {kind:'html-source'}` → `useHtmlSourceResolver` → `/api/resolve?only=1`）。

只有「集数很少 + 确实要一次拿到全部地址（比如给『复制全部』用）」才关掉。

## 4. 验证

dev server 若已在跑就直接打接口；要自己起，**必须带代理**（Node 不走系统代理，
不带的表现是「浏览器能打开、接口报 fetch failed」）：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 MEDIA_NO_PROXY=1 npm run dev
```

```bash
# 整季解析：看线路数/集数/当前集地址/clientTask
curl -s 'http://localhost:3000/api/resolve?step=extract&url=<urlencoded 播放页>' | python3 -m json.tool | head -40

# 按需取址的单集：应当 lines=[] 且有 currentVideoUrl
curl -s 'http://localhost:3000/api/resolve?step=extract&only=1&url=<urlencoded 某一集>'
```

逐项对：`ruleId` 命中的是新规则、`title` 是干净剧名、`lines` 的条数与集数和页面一致、
`activeLineIndex` 指向传入地址所属线路、`currentVideoUrl` 能直接播、
`clientTask.pageUrls.length` 等于该线路集数。

再换**另一条线路的另一集**测一遍（`?line=N`）——线路配对错位只有换线路才看得出来。

## 5. 落地点

- `composables/videoParseRules.ts` → `BUILTIN_PARSE_RULES` 加规则（**唯一必改处**）
- 界面上的「支持的站点」清单、`matchParseSite` 的徽标都从这张表自动出，不用登记第二遍
- 只有写代码型策略时才要动 `server/parsers/sites/` + `server/parsers/index.ts` 的
  `CODED_PARSERS` + `CODED_PARSE_SITES`（三处，漏第三处的表现是「能解析但输入框不显示徽标」）
- 站点验证通过后在 CLAUDE.md 的站点清单里补一行
