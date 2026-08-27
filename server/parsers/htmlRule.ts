/**
 * 数据驱动的通用策略：地址明文写在页面里，全靠几条正则抠。
 *
 * 覆盖 videoParseRules.ts 的内置规则表和用户自定义规则——加这类站点不用写代码，
 * 加一条规则即可。真正需要写代码的站点走 server/parsers/sites/ 下的独立策略。
 */
import type { HtmlSourceTask, ParseRule, ParsedEpisode, ParsedLine, ParseResult } from '../../composables/videoParseRules'
import type { ParserContext, SiteParser } from './types'
import { absolutize, decodeEntities, decodeMaccmsUrl, decodeScannedBase64, findDetailUrl, hostOf, parseCategory, parseCover, parseTitle, pool } from './utils'
import { cdndefendChallenge } from './challenges/cdndefend'
import { isM3u8Url } from '../../utils/mediaUrl'

// 单次请求最多解析多少集。CF 免费版单请求 50 subrequest 硬顶，留出主页面那一发和余量，取 40。
// 超出的不丢弃也不截断：用 offset 分批，前端拿到 remaining>0 就继续拉下一批，
// 每批各自是一次独立请求，各自的 subrequest 预算互不叠加，所以多少集都能解析完。
const MAX_EPISODES = 40
// 解析各集的并发。太高会被源站限流，也更容易撞 CF 的并发子请求限制。
const EPISODE_CONCURRENCY = 4

// 播放器地址缓存。这个值全站通用、极少变，而**每一集取址都要用**——
// 按需取址的站点不缓存的话，每播一集都要多抓一次配置文件。TTL 与 resolve.ts 的 cookieCache 对齐。
const playerCache = new Map<string, { player: PlayerInfo; at: number }>()
const PLAYER_TTL = 30 * 60 * 1000

/**
 * 站点自带的「解析播放器」地址（见 ParseRule.playerOrigin）。同一个值有两用：
 *   · `origin` → 防盗链候选值（这类站点的防盗链认的是播放器域名，不是播放页域名）
 *   · `prefix` → 拼 embedUrl 用的前缀（它本身就是 `https://…/?url=` 这种形态）
 */
interface PlayerInfo {
  origin: string
  prefix: string
}

const NO_PLAYER: PlayerInfo = { origin: '', prefix: '' }

/**
 * 抠出来的播放器地址 → { origin, prefix }。抠不到、或不是个合法地址一律空：
 * 这只是个候选值，为它中断整个解析不值得。（配置是 JSON，`/` 都是 `\/` 转义过的）
 */
function playerOf(raw?: string): PlayerInfo {
  const prefix = decodeMaccmsUrl(raw ?? '')
  try { return { origin: new URL(prefix).origin, prefix } } catch { return NO_PLAYER }
}

/**
 * 取播放器地址。两种来源：
 *   · 给了 `url` → 去站点自己的播放器配置文件里找，按 host 缓存
 *   · 没给 `url` → 地址就写在播放页上，直接对本页 HTML 跑正则
 */
async function resolvePlayer(rule: ParseRule, ctx: ParserContext, html: string): Promise<PlayerInfo> {
  const cfg = rule.playerOrigin
  if (!cfg?.re) return NO_PLAYER

  // 写在播放页上的那种（实测 kpkuang 的 data-pars）：不发请求，也**绝不能按 host 缓存**——
  // 每条线路的解析播放器不同，缓存会把上一条线路的地址喂给下一条，表现是切线路后开始 403
  if (!cfg.url) return playerOf(html.match(new RegExp(cfg.re, 'i'))?.[1])

  const key = ctx.host + cfg.url
  const hit = playerCache.get(key)
  if (hit && Date.now() - hit.at < PLAYER_TTL) return hit.player

  try {
    const res = await ctx.fetchPage(absolutize(cfg.url, ctx.pageUrl), ctx.cookie)
    // 每条线路可以配不同的播放器，按当前线路的标识精确取；
    // 标识抠不到（页面改版）就退回配置里第一条，总比什么都没有强
    const from = cfg.fromRe ? html.match(new RegExp(cfg.fromRe, 'i'))?.[1] : ''
    const scoped = from ? res.body.match(new RegExp(cfg.re.replace('%FROM%', from), 'i')) : null
    const m = scoped ?? res.body.match(new RegExp(cfg.re.replace('"%FROM%"', '"[^"]+"'), 'i'))
    const player = playerOf(m?.[1])
    playerCache.set(key, { player, at: Date.now() })
    return player
  } catch {
    return NO_PLAYER
  }
}

/**
 * 按规则抠封面（`ParseRule.coverRe` + 可选的 `coverBase`）。**只该拿详情页的 HTML 喂进来**
 * ——播放页上那些 `/vod1/vod/cover/…` 全是「猜你喜欢」里别人家的封面（见 coverRe 的注释）。
 *
 * `coverBase` 那一跳（去站点自己的 js 里现抠可用图床域名）按 host 缓存：那个值全站通用、
 * 极少变，而每部剧都要用一次，不缓存等于每次解析都多抓一个 js。
 * 与搜索侧 `SearchRule.picBase` 是同一套做法，只是那边的缓存在 `server/api/search.ts` 里。
 */
const coverBaseCache = new Map<string, { base: string; at: number }>()
const COVER_BASE_TTL = 30 * 60 * 1000

export async function coverFromRule(
  html: string,
  pageUrl: string,
  rule: ParseRule,
  fetchPage: (url: string) => Promise<{ status: number; body: string }>,
): Promise<string | undefined> {
  if (!rule.coverRe) return undefined
  const raw = html.match(new RegExp(rule.coverRe, 'i'))?.[1]
  if (!raw) return undefined
  const path = decodeEntities(raw)
  if (/^https?:\/\//i.test(path)) return path

  const cfg = rule.coverBase
  if (!cfg) return absolutize(path, pageUrl)

  const host = hostOf(pageUrl)
  const hit = coverBaseCache.get(host)
  let base = hit && Date.now() - hit.at < COVER_BASE_TTL ? hit.base : ''
  if (!base) {
    try {
      const jsUrl = html.match(new RegExp(cfg.fromRe, 'i'))?.[1]
      if (jsUrl) {
        const js = await fetchPage(absolutize(decodeEntities(jsUrl), pageUrl))
        if (js.status === 200) base = js.body.match(new RegExp(cfg.re, 'i'))?.[1] ?? ''
      }
    } catch { /* 抠不到图床就退回站点域名，大不了那张图 403，退成占位块 */ }
    if (base) coverBaseCache.set(host, { base, at: Date.now() })
  }
  return absolutize(path, base || pageUrl)
}

/** 解析线路 × 选集表。适用于「所有线路的选集都渲染在同一页」的站点。 */
function parseLines(html: string, rule: ParseRule, pageUrl: string): { lines: ParsedLine[]; activeIndex: number } {
  if (!rule.lineRe || !rule.episodeGroupRe || !rule.episodeRe) return { lines: [], activeIndex: -1 }

  const lineMatches = [...html.matchAll(new RegExp(rule.lineRe, 'gi'))]
  const groupMatches = [...html.matchAll(new RegExp(rule.episodeGroupRe, 'gi'))]

  const lines: ParsedLine[] = []
  let activeIndex = -1

  // 各站标记当前线路的 class 名不同（active / on / …），认错的表现不是报错，
  // 而是默认落到第一条线路上——用户点开的那条被悄悄换掉，很难看出来
  const activeRe = new RegExp(rule.activeFlagRe || 'active', 'i')

  // 线路标签与选集容器按出现顺序一一对应（三个不同页面实测恒等：16/16、18/18、17/17）。
  // 数量不等说明页面改版了，此时宁可只输出能对上的前 N 组，也不要错位。
  const n = Math.min(lineMatches.length, groupMatches.length)
  for (let i = 0; i < n; i++) {
    const lm = lineMatches[i]
    const active = activeRe.test(lm[1] ?? '')
    if (active) activeIndex = i

    const inner = groupMatches[i][1] ?? ''
    const episodes: ParsedEpisode[] = [...inner.matchAll(new RegExp(rule.episodeRe, 'gi'))].map(em => ({
      // 电影页这里是「TC高清」这类版本标签而非「第N集」，不要假设是数字
      title: decodeEntities(em[2] ?? ''),
      pageUrl: absolutize(decodeEntities(em[1] ?? ''), pageUrl),
    }))

    lines.push({
      name: decodeEntities(lm[2] ?? `线路${i + 1}`),
      sublabel: decodeEntities(lm[3] ?? '') || undefined,
      active,
      episodes,
    })
  }

  return { lines, activeIndex }
}

/** 「像不像能直接送进播放器的媒体地址」。isM3u8Url 只答 HLS，直链 mp4 之类也得放过 */
const DIRECT_MEDIA_EXT = /\.(mp4|m4v|mkv|mov|webm|flv|ts|mp3|m4a|aac|flac)(?:$|[?#])/i
const isPlayableUrl = (url: string) => isM3u8Url(url) || DIRECT_MEDIA_EXT.test(url)

/**
 * 把「第三方站点的播放页地址」拼成能内嵌的播放器地址。
 *
 * 拼法照抄站点自己的（kpkuang 的 `template/vfed/asset/js/global_dec.js` 里 `fed.player.iframe`：
 * `src = data-pars + (data-stat!=0 && 含'&' ? encodeURIComponent(d) : d)`）：
 *
 * - **前缀为空 = 抠出来的地址本身就是个能内嵌的播放器页**，原样用。实测 kpkuang 的
 *   超清 AB/BY/EV 三条线就是这样：`data-pars=""`、`data-play` 直接是 `abyssplayer.com/…`
 *   这类播放器地址。站点自己也是原样塞进 iframe 的，这时**不能编码**。
 * - 有前缀时**只在地址含 `&` 时才整串 percent 编码**：不含 `&` 的地址编码之后解析站认不出来。
 *
 * 站点真正的判据是 `data-stat`（我们抓不到语义、也不该为一个站点加字段），
 * 但实测这一页 28 条线路里「前缀空 ⟺ data-stat=0」恒成立，两种拼法结果逐条相同。
 */
function buildEmbedUrl(prefix: string, url: string): string {
  if (!prefix) return url
  return prefix + (url.includes('&') ? encodeURIComponent(url) : url)
}

/**
 * 抠这一集的播放地址。取不到时连**为什么**一起带出来——
 * 「页面把地址留空」和「抠到了但那是第三方站点的播放页」是两回事，
 * 界面上都说成前者的话，用户会一直以为是我们的正则写坏了（实测被问过）。
 */
interface SourceProbe {
  url?: string
  /** 抠到的是第三方播放页，而站点自己是内嵌播放的 → 照它的拼法拼出的内嵌地址 */
  embedUrl?: string
  reason?: string
}

function probeSource(html: string, rule: ParseRule, playerPrefix = ''): SourceProbe {
  if (!rule.sourceRe) return {}
  const raw = html.match(new RegExp(rule.sourceRe, 'i'))?.[1]
  if (!raw) return {}
  const url = rule.sourceDecode === 'maccms'
    ? decodeMaccmsUrl(raw)
    : rule.sourceDecode === 'base64-scan'
      ? decodeScannedBase64(raw)
      : raw
  // 解码没解到位就当没取到：把 base64 残串当地址喂给播放器，
  // 表现是「解析成功但一集都播不了」，比明确报错难查得多
  if (!/^(https?:|\/\/)/i.test(url)) return {}
  // 有些线路给的是第三方站点的**播放页**而不是直链（见 ParseRule.sourceMediaOnly）。
  // 它是个合法 http 地址，不在这筛掉就会一路喂到播放器里黑屏
  if (rule.sourceMediaOnly && !isPlayableUrl(url)) {
    // 站点自己就是把这个地址塞进 iframe 播的（前缀写在播放页的 data-pars 上，可能为空）。
    // 我们照它的拼法拼出同一个地址交给浏览器内嵌——真实地址由解析服务在浏览器里现算，
    // 服务端拿不到，但那一步本来也不需要我们做。
    // 判据是「规则配了 playerOrigin」而不是「拼出了前缀」：前缀为空恰恰是
    // 「地址本身就是播放器页」那一档（实测 kpkuang 超清 AB/BY/EV 三条线），一样能内嵌
    if (rule.playerOrigin) return { embedUrl: buildEmbedUrl(playerPrefix, url) }
    const host = hostOf(url) || url
    return { reason: `这条线路给的不是视频地址，而是第三方站点的播放页（${host}），要靠站点自带的解析服务在浏览器里现算才变得出真实地址，我们拿不到。换一条给直链的线路即可。` }
  }
  return { url }
}

export function createHtmlParser(rule: ParseRule): SiteParser {
  return {
    id: rule.id,
    name: rule.name,
    pattern: rule.pattern,
    challenge: rule.challenge === 'cdndefend' ? cdndefendChallenge : undefined,

    // 详情页 → 第 1 集播放页（见 ParseRule.detailRe）。抠不到就返回 null 让上层照常解析：
    // 详情页的 URL 判据命中、页面里却一条播放链接都没有，多半是站点改版或那部片没有资源，
    // 这时拿详情页去跑选集正则会得到空结果，报出来的「页面结构不匹配」比这里硬报错更准
    detailPlayUrl: (rule.detailRe && rule.detailPlayRe)
      ? (ctx, html) => {
          if (!new RegExp(rule.detailRe!, 'i').test(ctx.pageUrl)) return null
          const href = html.match(new RegExp(rule.detailPlayRe!, 'i'))?.[1]
          return href ? absolutize(decodeEntities(href), ctx.pageUrl) : null
        }
      : undefined,

    async parse(ctx: ParserContext, html: string): Promise<ParseResult> {
      const { lines, activeIndex } = parseLines(html, rule, ctx.pageUrl)

      // 播放器地址要在抠源之前拿到：抠出来的是第三方播放页时，得靠它的 prefix 拼 embedUrl。
      // 防盗链域名同样优先从站点自己的配置里现取，规则里写死的只当兜底。
      // 按需取址的单集请求（only=1）也走这里，所以每集都能拿到最新的值。
      const player = await resolvePlayer(rule, ctx, html)
      const source = probeSource(html, rule, player.prefix)
      const currentVideoUrl = source.url

      // ── 单片站点：一个播放页就是一部片，页面上压根没有线路表也没有选集表 ──
      // 这类规则那三条正则都不填，parseLines 于是给出空表。但下游全是按「线路 → 选集」
      // 组织的（前端的 playableCount / playAll / 可达性检测都从 currentLine 取），
      // 空表的表现是「解析成功、地址也抠到了，播放按钮却是灰的」。所以在这补一条只有
      // 一集的线路，让单片站点走与影视站完全相同的那条路，前端一行都不用改。
      //
      // 判据用 `!rule.lineRe` 而不是 `!lines.length`：影视站的选集正则写歪了同样会得到
      // 空表，那是必须报出来的「页面结构不匹配」，绝不能悄悄降级成「一集的单片」——
      // 那样用户看到的是「整季只解析出 1 集」，比明确报错难查得多。
      if (!rule.lineRe && (currentVideoUrl || source.embedUrl)) {
        lines.push({
          name: '默认',
          active: true,
          episodes: [{
            title: '正片',
            pageUrl: ctx.pageUrl,
            videoUrl: currentVideoUrl,
            embedUrl: source.embedUrl,
          }],
        })
      }

      if (!currentVideoUrl && !source.embedUrl && !lines.length) {
        throw createError({ statusCode: 502, statusMessage: '页面结构不匹配，规则需要更新' })
      }

      /**
       * 封面与分类：只给「播放历史 / 收藏」那两份清单用（缩略图 + 筛选）。
       *
       * **播放页抠不到就跟一跳去详情页**（实测 ncat22 的封面只挂在 `/detail/5789.html` 上，
       * 播放页一个 `og:image` 都没有）。只在整表解析时跟：`only=1` 是按需取址的单集请求，
       * 一集一发，为一张图给每集都多打一次源站站不住脚，何况那时封面早就有了。
       * 全程静默——封面是锦上添花，为它让整次解析失败或变慢都不划算。
       */
      let cover = parseCover(html, ctx.pageUrl)
      let cat = parseCategory(html)
      if (!cover && !ctx.only) {
        const detailUrl = findDetailUrl(html, ctx.pageUrl)
        if (detailUrl) {
          try {
            const d = await ctx.fetchPage(detailUrl, ctx.cookie)
            if (d.status === 200) {
              // 详情页上：先试通用的 og:image，再试规则里那条（连 og:image 都不写的站点）
              cover = parseCover(d.body, detailUrl)
                || await coverFromRule(d.body, detailUrl, rule, u => ctx.fetchPage(u, ctx.cookie))
              cat = cat || parseCategory(d.body)
            }
          } catch { /* 详情页抓不到就没有封面，不影响解析本身 */ }
        }
      }

      const base = {
        ruleId: rule.id,
        ruleName: rule.name,
        title: (rule.titleRe && decodeEntities(html.match(new RegExp(rule.titleRe, 'i'))?.[1] ?? '')) || parseTitle(html),
        cover,
        cat,
        pageUrl: ctx.pageUrl,
        currentVideoUrl,
        embedUrl: source.embedUrl,
        referer: player.origin ? player.origin + '/' : rule.referer,
        origin: player.origin || rule.origin,
      }

      // 按需取址的单集请求（only=1）：只要这一集的地址。
      // 选集表播放器早就有了，再解析一遍纯属浪费，更别提去抓子页面。
      if (ctx.only) {
        return { ...base, lines: [], activeLineIndex: -1, batchFrom: 0, batchTo: 0, remaining: 0 }
      }

      // 要解析哪条线路：显式指定 > 页面标记的 active > 第一条
      const targetIndex = Number.isFinite(ctx.line as number) && (ctx.line as number) >= 0 && (ctx.line as number) < lines.length
        ? (ctx.line as number)
        : (activeIndex >= 0 ? activeIndex : 0)

      const target = lines[targetIndex]
      const offset = ctx.offset
      let batchTo = offset
      let remaining = 0
      let lineUnsupported = false
      // 不给直链的**具体原因**，界面上要区分「页面把地址留空」和「给的是第三方播放页」
      let unsupportedReason: string | undefined
      // 这条线路给的是第三方播放页、只能内嵌播（见 base.embedUrl）。
      // 它不算「线路坏了」，但也**不能交作业单**——我们的播放器放不了这种地址
      let embedLine = !currentVideoUrl && !!source.embedUrl

      // ── 按需取址：解析阶段一集都不抓，只交一张作业单出去 ──
      // 逐集抓页是一集一个子请求，长剧要分多批、上百个请求，慢且容易被源站限流，
      // 而用户通常只看几集。改成播放器切到哪集才去抓哪集（见 useHtmlSourceResolver）。
      if (rule.lazy && target?.episodes.length) {
        // 传入的这一集属于目标线路的话，它的地址已经在手上了，顺手填上：
        // 界面上要有个能复制的真实地址，前端也就不必再为它多发一次请求
        const cur = target.episodes.find(ep => ep.pageUrl === ctx.pageUrl)
        if (cur && currentVideoUrl) cur.videoUrl = currentVideoUrl
        if (cur && source.embedUrl) cur.embedUrl = source.embedUrl

        // 「这条线路给不给直链」还是要探一下——否则用户要播到某一集才发现整条线路是坏的。
        // 手上已有本线路的地址时白探一次没意义，只有切到别的线路时才花这一个请求。
        if (!cur) {
          const probe = target.episodes[0]
          // base 里那份 embedUrl 是从 ctx.pageUrl 抠的，属于**另一条**线路，
          // 先作废；探测失败（下面的 catch）时也不能把它带出去
          base.embedUrl = undefined
          embedLine = false
          try {
            const sub = await ctx.fetchPage(probe.pageUrl, ctx.cookie)
            // 播放器地址可能是**每条线路一份**（实测 kpkuang：睿映线认 soul.flixfiend.top、
            // 电影天堂线认 vip.dyttzyplay.com），同样属于另一条线路——
            // 不按探测页重算一遍就会把别人的域名带出去，第一集直接 403
            const linePlayer = await resolvePlayer(rule, ctx, sub.body)
            if (linePlayer.origin) {
              base.origin = linePlayer.origin
              base.referer = linePlayer.origin + '/'
            }
            const s = probeSource(sub.body, rule, linePlayer.prefix)
            if (s.url) probe.videoUrl = s.url
            else if (s.embedUrl) { probe.embedUrl = base.embedUrl = s.embedUrl; embedLine = true }
            else { lineUnsupported = true; unsupportedReason = s.reason }
          } catch {
            // 探测失败不等于线路不可用（可能只是这一发超时），放行让播放时再试
          }
        } else if (!currentVideoUrl && !source.embedUrl) {
          lineUnsupported = true
          unsupportedReason = source.reason
        }

        const clientTask: HtmlSourceTask = {
          kind: 'html-source',
          pageUrls: target.episodes.map(ep => ep.pageUrl),
          lazy: true,
        }
        return {
          ...base,
          lines,
          activeLineIndex: targetIndex,
          batchFrom: 0,
          batchTo: target.episodes.length,
          remaining: 0,
          lineUnsupported: lineUnsupported || undefined,
          lineUnsupportedReason: unsupportedReason,
          // 内嵌线路不交作业单：作业单是给我们自己的播放器逐集取直链用的，
          // 而这条线路压根没有直链，交出去只会让每一集都报「未给出直链」
          clientTask: lineUnsupported || embedLine ? undefined : clientTask,
        }
      }

      if (target?.episodes.length) {
        const resolveOne = async (ep: ParsedEpisode) => {
          // 传入的那一集已经解析过了，不重复请求
          if (ep.pageUrl === ctx.pageUrl && (currentVideoUrl || source.embedUrl)) {
            ep.videoUrl = currentVideoUrl
            ep.embedUrl = source.embedUrl
            return
          }
          try {
            const sub = await ctx.fetchPage(ep.pageUrl, ctx.cookie)
            if (this.challenge?.detect(sub.body)) { ep.error = '需要重新校验'; return }
            // 内嵌线路的播放器前缀是每条线路一份、写在各自的播放页上，只能逐集现取
            // （写在页面上的那种只跑正则不发请求；配置文件那种按 host 缓存）
            const linePlayer = rule.sourceMediaOnly ? await resolvePlayer(rule, ctx, sub.body) : NO_PLAYER
            const s = probeSource(sub.body, rule, linePlayer.prefix)
            if (s.url) ep.videoUrl = s.url
            else if (s.embedUrl) ep.embedUrl = s.embedUrl
            else { ep.error = '该线路未给出直链'; unsupportedReason = unsupportedReason ?? s.reason }
          } catch (e) {
            // 单集失败不影响整体：标记后继续
            ep.error = (e as Error).message || '请求失败'
          }
        }

        const todo = target.episodes.slice(offset, offset + MAX_EPISODES)
        batchTo = offset + todo.length
        remaining = target.episodes.length - batchTo
        if (remaining > 0) {
          console.log(`[resolve] ${ctx.host} 线路「${target.name}」共 ${target.episodes.length} 集，本批 ${offset}~${batchTo}，还剩 ${remaining} 集`)
        }

        // 有些线路（如「4K」）的页面把播放地址渲染成空串，地址由前端运行时另取，
        // 服务端拿不到。这类线路整条都取不到，先探第一集，不行就立刻收工——
        // 否则要白白等完剩下几十集的请求才知道结果是空的。
        // 只在第一批探：后续批次已经知道这条线路是好的，不必再多花一个来回。
        if (offset === 0 && todo.length) {
          await resolveOne(todo[0])
          if (!todo[0].videoUrl && !todo[0].embedUrl) {
            lineUnsupported = true
            remaining = 0   // 整条线路都取不到，别让前端再去拉后续批次
            for (let i = 1; i < todo.length; i++) todo[i].error = '该线路未给出直链'
            console.log(`[resolve] ${ctx.host} 线路「${target.name}」不提供直链，跳过其余 ${target.episodes.length - 1} 集`)
          } else {
            await pool(todo.slice(1), EPISODE_CONCURRENCY, resolveOne)
          }
        } else {
          await pool(todo, EPISODE_CONCURRENCY, resolveOne)
        }

        // 目标线路不一定是传入地址那条，base.embedUrl 属于后者，按目标线路的实测结果订正
        base.embedUrl = target.episodes.find(ep => ep.embedUrl)?.embedUrl
      }

      return {
        ...base,
        lines,
        activeLineIndex: targetIndex,
        batchFrom: offset,
        batchTo,
        remaining,
        lineUnsupported: lineUnsupported || undefined,
        lineUnsupportedReason: unsupportedReason,
      }
    },
  }
}
