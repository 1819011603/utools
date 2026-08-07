/**
 * nbmovie 系（4kvm.org、ziziys.org …）。
 *
 * 同一套程序换皮开的站，页面结构逐字节同构（`<link id="wasm-cfg">` + `userlink` +
 * `handleEpisodeClick` + `<meta id="nb-plt">`），所以**一条 pattern 兜住全部**，
 * 解析逻辑一行不用改——parser 里所有地址都从 `ctx.pageUrl` 的 origin 现拼，没有写死的域名。
 * 再遇到同族站点只需往 PATTERN 和 CODED_PARSE_SITES 里各加一个域名。
 *
 * 这个站点的页面里根本没有播放地址，只有「集 → dataid」的映射：
 * 真实地址要拿 dataid 去调 /video/play，而那个接口的整串 query
 * （签名 s + 时间戳 t + 令牌 k）由站点自带的 wasm 现算。
 *
 * 服务端只抠静态料，签名与取址交给浏览器，原因见 videoParseRules.ts 的
 * ClientResolveTask 注释（CF Workers 禁止运行时实例化 wasm、签名带时效、
 * 顺带绕开单请求 subrequest 上限）。
 */
import type { ParseResult, WasmSignerTask } from '../../../composables/videoParseRules'
import type { ParserContext, SiteParser } from '../types'
import { absolutize, decodeEntities, innerTexts, parseTitle } from '../utils'

const SITE_ID = 'nbmovie'
const SITE_NAME = '4k影视 (4kvm / ziziys)'
// 站点会换域名后缀，用正则兜住。**必须与 CODED_PARSE_SITES 里那条保持一致**：
// 前端靠那份判断「这个地址支不支持」，只改一边的表现是能解析但输入框不显示规则徽标
const PATTERN = '/(4kvm\\d*|ziziys)\\.(org|com|net|cc|top)/'

/** 选集锚点：href / dataid / 线路号 / 集号 都写在 handleEpisodeClick 的实参里 */
const EPISODE_RE =
  /<a\s+href="(\/play\/[^"]+)"[^>]*handleEpisodeClick\([^"]*?'(\d+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*\)[\s\S]*?<\/a>/g

/** 站点目前只有 1080p 一档非会员清晰度；这个值只是入参，接口总会把可选档位整表返回 */
const QUALITY = '1080'

export const nbmovieParser: SiteParser = {
  id: SITE_ID,
  name: SITE_NAME,
  pattern: PATTERN,

  async parse(ctx: ParserContext, html: string): Promise<ParseResult> {
    const origin = new URL(ctx.pageUrl).origin

    // 令牌是服务端按次渲染进页面的，匿名访问也有；缺了 /video/play 直接回 401「请提供访问令牌」
    const userlink = html.match(/userlink\s*:\s*'([^']*)'/)?.[1]
    // wasm 文件名带内容 hash，站点一更新就变，所以只能从页面的 <link id="wasm-cfg"> 现读
    const cfg = html.match(/id="wasm-cfg"[^>]*/)?.[0] ?? ''
    const wasmJs = cfg.match(/data-js="([^"]+)"/)?.[1]
    const wasmBg = cfg.match(/data-bg="([^"]+)"/)?.[1]
    if (!userlink || !wasmJs || !wasmBg) {
      throw createError({ statusCode: 502, statusMessage: '页面结构不匹配：未取到访问令牌或签名模块地址' })
    }

    // 站点把全部选集渲染在同一页（分页只是前端 x-show），一次请求就拿全
    const anchors = [...html.matchAll(EPISODE_RE)]
    if (!anchors.length) {
      throw createError({ statusCode: 502, statusMessage: '页面结构不匹配：未取到选集列表' })
    }

    // 按锚点自带的 data-line 分组。实测该站目前只有一条线路，
    // 分组写法顺带兜住站点以后加线路的情况，不必再改一次
    const byLine = new Map<string, { title: string; pageUrl: string; args: string[] }[]>()
    for (const [block, href, dataid, lineNo, epNo] of anchors) {
      const slug = href.slice(href.lastIndexOf('/') + 1)
      if (!byLine.has(lineNo)) byLine.set(lineNo, [])
      // 集名就是锚点里最后一个 <span> 的文本（当前集那个前面还多套了播放动画的 div）。
      // 不能直接剥整个锚点的标签：开标签的 x-effect 属性里有 `=>`，会把剥标签的正则带偏
      const spans = innerTexts(block, 'span')
      byLine.get(lineNo)!.push({
        title: spans[spans.length - 1] || `第 ${epNo} 集`,
        pageUrl: absolutize(href, ctx.pageUrl),
        args: [dataid, slug, QUALITY, userlink],
      })
    }

    const lineNos = [...byLine.keys()]
    const lineNames = [...html.matchAll(/lineName\s*:\s*'([^']*)'/g)].map(m => decodeEntities(m[1]))

    // 传入的是某一集的地址，哪条线路含这一集就是当前线路
    let activeIndex = lineNos.findIndex(no => byLine.get(no)!.some(x => x.pageUrl === ctx.pageUrl))
    if (activeIndex < 0) activeIndex = 0

    const targetIndex = Number.isFinite(ctx.line as number) && (ctx.line as number) >= 0 && (ctx.line as number) < lineNos.length
      ? (ctx.line as number)
      : activeIndex

    const lines = lineNos.map((no, i) => ({
      // 单线路时站点自报的名字是内部标识（如 alists），没有展示价值，直接给个中性标签
      name: lineNos.length > 1 ? (lineNames[i] || `线路${no}`) : '默认线路',
      active: i === activeIndex,
      episodes: byLine.get(no)!.map(x => ({ title: x.title, pageUrl: x.pageUrl })),
    }))

    const clientTask: WasmSignerTask = {
      kind: 'wasm-url-signer',
      moduleUrl: absolutize(wasmJs, origin),
      wasmUrl: absolutize(wasmBg, origin),
      fn: 'build_play_url',
      base: origin,
      argsList: byLine.get(lineNos[targetIndex])!.map(x => x.args),
      // 站点自己就是「点一集取一集」的。实测一次性把 185 集全取完，
      // 打到 186 发时接口开始回「请求过于频繁，请稍后再试」——必须按需取
      lazy: true,
      // wasm 会读这个 <meta> 的 content 当时间戳（站点原页面由内联脚本写入 Date.now()）
      timestampMetaId: 'nb-plt',
      pick: {
        listPath: 'data.quality_urls',
        urlKey: 'url',
        // 4K 档给会员，url 会渲染成 "1" 这种占位值
        skipFlags: ['locked'],
        rankKey: 'bitrate',
        messagePath: 'message',
      },
    }

    return {
      ruleId: SITE_ID,
      ruleName: SITE_NAME,
      // 标题形如「片名 - 第185集 -4k影视」，站名后缀由 parseTitle 削，这里再削集号
      title: parseTitle(html, [/\s*[-—]\s*第\s*\d+\s*集\s*$/]),
      pageUrl: ctx.pageUrl,
      lines,
      activeLineIndex: targetIndex,
      // 一发请求就拿全了整季，没有子请求预算问题，所以不分批
      batchFrom: 0,
      batchTo: lines[targetIndex]?.episodes.length ?? 0,
      remaining: 0,
      clientTask,
    }
  },
}
