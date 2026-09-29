/**
 * 解析规则表（纯数据）：内置正则规则表 + 代码型站点登记表。
 *
 * 从 videoParseRules.ts 拆出来：那边是「类型 + 匹配逻辑」，这里是两张纯数据表，分开后两边都在
 * 500 行以内。本文件在 `composables/` 顶层，会被 Nuxt 自动导入（服务端/页面都直接 import 它）。
 */
import type { ParseRule, CodedParseSite } from './videoParseRules'

// 内置规则表——地址明文写在页面里、能用正则描述的站点都加在这，复制一条改 pattern 与几个正则即可。
// 需要写代码才能解析的站点（接口另取、签名、加密…）不进这张表，
// 去 server/parsers/sites/ 加一个 .ts 并在 server/parsers/index.ts 注册。
export const BUILTIN_PARSE_RULES: ParseRule[] = [
  {
    id: 'ncat',
    name: '网飞猫 (ncat)',
    // 站点会换域名（ncat22 / ncat23 …），用正则兜住数字后缀
    pattern: '/ncat\\d*\\.(com|app|net)/',
    homepage: 'https://www.ncat22.com/',
    challenge: 'cdndefend',
    // 地址明文写在内联脚本的 xgplayer 播放源里，没有二次解析接口
    sourceRe: 'playSource\\s*=\\s*\\{[^}]*?src:\\s*"([^"]+)"',
    lineRe: '<a[^>]*class="source-item\\s*([^"]*)"[^>]*>\\s*<span class="source-item-label">([^<]*)</span>\\s*(?:<span class="source-item-sublabel">([^<]*)</span>)?',
    // 该站把「全部线路」的选集都渲染在同一页里（非当前线路 display:none），
    // 所以一次请求就能拿到整张线路 × 集数表，不用逐线路翻页
    episodeGroupRe: '<div class="episode-list"[^>]*>([\\s\\S]*?)</div>',
    episodeRe: '<a[^>]*href="([^"]+)"[^>]*class="[^"]*episode-item[^"]*"[^>]*>\\s*<span>([^<]*)</span>',
    // 搜索结果只给详情页（该站的搜索卡片里没有播放链接），必须靠这一跳
    detailRe: '/detail/\\d+\\.html',
    detailPlayRe: 'href="(/play/[^"]+)"',
    // 这个站**一个 og:image 都没有**（播放页和详情页都没有），封面只在详情页的懒加载属性里，
    // 而且路径 `/vod1/…` 在站点自己域名下恒 403 —— 与搜索规则那边是同一个坑，配法也一样
    coverRe: 'data-original="(/vod1/vod/cover/[^"]+)"',
    coverBase: {
      fromRe: 'src="([^"]*rdul[^"]*\\.js[^"]*)"',
      re: '"(https?://[^"]+)"',
    },
    // 「整张线路×集数表一次拿到」省的只是列表，**地址仍要逐集抓页**——实测这部片 19 条线路
    // 每条 73-79 集，非 lazy 时首批 40 个子请求就要 7.8s，剩下 38 集还得再续一批，
    // 点一下线路卡好几秒（用户原话「点击线路巨卡无比」）。而用户通常只看几集。
    lazy: true,
  },
  // ── 以下两条是苹果 CMS（MacCMS）站点，页面结构不同但地址都在 player_aaaa 里 ──
  // 这类站点占了国内影视站的大多数，接新站基本就是把下面这条复制一份改四个正则。
  {
    id: 'ylsp',
    name: '永乐视频 (ylsp)',
    pattern: '/ylsp\\d*\\.[a-z]{2,4}\\//',
    homepage: 'https://www.ylsp.lv/',
    // encrypt=0，地址是明文，只是 JSON 里的 `\/` 要还原
    sourceRe: 'player_aaaa\\s*=\\s*\\{[\\s\\S]*?"url"\\s*:\\s*"([^"]+)"',
    sourceDecode: 'maccms',
    // 当前线路渲染成 <div>、其余是 <a>，所以标签名不能写死
    lineRe: '<(?:a|div)[^>]*class="module-tab-item tab-item([^"]*)"[^>]*>\\s*<span>([^<]*)</span>',
    // 组不能用 `</div>` 收尾：当前集的 <a> 里嵌了 <div class="playon">，
    // 非贪婪匹配会断在那，整条线路只剩 1 集（踩过）
    episodeGroupRe: '<div class="module-play-list-content[^"]*">([\\s\\S]*?)</div></div></div>',
    episodeRe: '<a class="module-play-list-link[^"]*" href="([^"]+)"[^>]*>\\s*<span>([^<]*)</span>',
    // title 是「剧名-免费在线观看-集号」，兜底只削得掉最后一段
    titleRe: '<title>([^<-]+)',
    detailRe: '/voddetail/\\d+',
    detailPlayRe: 'href="(/play/[^"]+)"',
    // 实测 186 集，一次抓完要 186 个子请求
    lazy: true,
  },
  {
    id: 'netflixgc',
    name: '奈飞工厂 (netflixgc)',
    pattern: '/netflixgc\\d*\\.(net|com|tv|cc)/',
    homepage: 'https://netflixgc.net/',
    // encrypt=2：base64 套 percent，两层都由 sourceDecode 剥
    sourceRe: 'player_aaaa\\s*=\\s*\\{[\\s\\S]*?"url"\\s*:\\s*"([^"]+)"',
    sourceDecode: 'maccms',
    lineRe: '<a data-form="[^"]*" class="vod-playerUrl swiper-slide([^"]*)"[^>]*>(?:<i[^>]*>[^<]*</i>)?(?:&nbsp;)?([^<]*)<',
    // 当前线路的标记是 `on` 不是 `active`
    activeFlagRe: '\\bon\\b',
    episodeGroupRe: '<ul class="anthology-list-play[^"]*">([\\s\\S]*?)</ul>',
    episodeRe: '<a[^>]*href="([^"]+)"[^>]*>\\s*<span>([^<]*)</span>',
    // title 是一长串 SEO 文案，剧名只在书名号里
    titleRe: '<title>[^<]*《([^》]+)》',
    detailRe: '/voddetail/\\d+',
    detailPlayRe: 'href="(/vodplay/[^"]+)"',
    // 视频挂在与播放页无关的 CDN 上（v.fengbao10.com 之类），防盗链认的是站点自己的
    // 播放器页。地址从站点的播放器配置里现取，站点换域名时不用改代码
    playerOrigin: {
      url: '/static/js/playerconfig.js',
      re: '"%FROM%"\\s*:\\s*\\{[^}]*?"parse"\\s*:\\s*"(https?:[^"]+)"',
      fromRe: '"from"\\s*:\\s*"([^"]+)"',
    },
    // 配置文件取不到时的兜底（实测值，2026-08）
    referer: 'https://cjbfq.netflixgc.tv',
    origin: 'https://cjbfq.netflixgc.tv',
    lazy: true,
  },
  {
    id: 'kpkuang',
    name: '看片狂人 (kpkuang)',
    pattern: '/kpkuang\\d*\\.(org|com|net|cc|tv)/',
    homepage: 'https://www.kpkuang.org/',
    // 不是 player_aaaa 那一套：地址在播放器 iframe 的 data-play 上，
    // 3 个随机字符 + base64（见 decodeScannedBase64）
    sourceRe: 'data-play="([^"]+)"',
    sourceDecode: 'base64-scan',
    // 26 条线路里有几条给的是第三方站点的播放页而非直链，筛掉当「未给出直链」，见 sourceMediaOnly
    sourceMediaOnly: true,
    // active 标记在外层 <li> 上（uk-active），不在 <a> 上，所以捕获的是 li 的 class
    lineRe: '<li class="(fed-drop-btns[^"]*)"[^>]*>\\s*<a[^>]*class="[^"]*line-select[^"]*"[^>]*data-linename="([^"]*)"',
    activeFlagRe: '\\buk-active\\b',
    // 必须从 fed-play-item 起锚：页面上另有两个空的 `<ul class="fed-part-rows">`
    // （一个在选集区之前、一个在之后），直接匹配这个 ul 会多出两组、整张表错位一位。
    // 另外 class 后面不能收在 `"` 上——超清 AB/BY/EV 三条线带了 style 属性（踩过：漏 3 组）
    episodeGroupRe: '<li class="fed-play-item[^"]*">[\\s\\S]*?<ul class="fed-part-rows"[^>]*>([\\s\\S]*?)</ul>',
    episodeRe: '<a class="fed-btns-info[^"]*"[^>]*href="([^"]+)"[^>]*>\\s*([^<]*?)\\s*</a>',
    // title 是「《剧名》(年份) - 在线播放页面 - 当前播放:N - 线路:X - 站名」
    titleRe: '<title>[^<]*《([^》]+)》',
    // 这个站的搜索被 Cloudflare 挡着（见 videoSearchRules 的 manual），
    // 用户只能在源站搜到之后把详情页地址粘回来——那条路全靠这一跳
    detailRe: '/voddetail/\\d+',
    detailPlayRe: 'href="(/vodplay/[^"]+)"',
    // 防盗链域名**每条线路都不一样**，而且就写在播放页的 data-pars 上（那是这条线路用的
    // 解析播放器前缀）：睿映线认 soul.flixfiend.top、电影天堂线认 vip.dyttzyplay.com、
    // 芒果线认 jx.xmflv.com。所以不给 url —— 现抠当前页，也不按 host 缓存
    playerOrigin: {
      re: 'data-pars="(https?:[^"]*)"',
    },
    // 实测 26 条线路、最多 71 集
    lazy: true,
  },
]

// 代码型站点的登记表：正则描述不了的站点（另调接口 / 签名 / 解密），实现见 server/parsers/sites/。
export const CODED_PARSE_SITES: CodedParseSite[] = [
  {
    id: 'nbmovie',
    name: '4k影视 (4kvm / ziziys)',
    // 站点会换域名后缀，用正则兜住。同一套程序换皮开的站（ziziys）页面结构同构，
    // 归在同一条里即可，**改这里要同步改 server/parsers/sites/nbmovie.ts 的 PATTERN**
    pattern: '/(4kvm\\d*|ziziys)\\.(org|com|net|cc|top)/',
    homepage: 'https://4kvm.org/',
    note: '源站限流，按需取址：解析只取当前一集，其余播到哪集取哪集',
  },
]
