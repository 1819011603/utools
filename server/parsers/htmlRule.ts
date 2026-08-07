/**
 * 数据驱动的通用策略：地址明文写在页面里，全靠几条正则抠。
 *
 * 覆盖 videoParseRules.ts 的内置规则表和用户自定义规则——加这类站点不用写代码，
 * 加一条规则即可。真正需要写代码的站点走 server/parsers/sites/ 下的独立策略。
 */
import type { HtmlSourceTask, ParseRule, ParsedEpisode, ParsedLine, ParseResult } from '../../composables/videoParseRules'
import type { ParserContext, SiteParser } from './types'
import { absolutize, decodeEntities, decodeMaccmsUrl, parseTitle, pool } from './utils'
import { cdndefendChallenge } from './challenges/cdndefend'

// 单次请求最多解析多少集。CF 免费版单请求 50 subrequest 硬顶，留出主页面那一发和余量，取 40。
// 超出的不丢弃也不截断：用 offset 分批，前端拿到 remaining>0 就继续拉下一批，
// 每批各自是一次独立请求，各自的 subrequest 预算互不叠加，所以多少集都能解析完。
const MAX_EPISODES = 40
// 解析各集的并发。太高会被源站限流，也更容易撞 CF 的并发子请求限制。
const EPISODE_CONCURRENCY = 4

// 播放器域名缓存。这个值全站通用、极少变，而**每一集取址都要用**——
// 按需取址的站点不缓存的话，每播一集都要多抓一次配置文件。TTL 与 resolve.ts 的 cookieCache 对齐。
const playerOriginCache = new Map<string, { origin: string; at: number }>()
const PLAYER_ORIGIN_TTL = 30 * 60 * 1000

/**
 * 从站点自己的播放器配置里取防盗链域名（见 ParseRule.playerOrigin）。
 * 取不到一律返回空串让上层退回写死的值——这只是个候选值，为它中断整个解析不值得。
 */
async function resolvePlayerOrigin(rule: ParseRule, ctx: ParserContext, html: string): Promise<string> {
  const cfg = rule.playerOrigin
  if (!cfg?.url || !cfg.re) return ''

  const key = ctx.host + cfg.url
  const hit = playerOriginCache.get(key)
  if (hit && Date.now() - hit.at < PLAYER_ORIGIN_TTL) return hit.origin

  try {
    const res = await ctx.fetchPage(absolutize(cfg.url, ctx.pageUrl), ctx.cookie)
    // 每条线路可以配不同的播放器，按当前线路的标识精确取；
    // 标识抠不到（页面改版）就退回配置里第一条，总比什么都没有强
    const from = cfg.fromRe ? html.match(new RegExp(cfg.fromRe, 'i'))?.[1] : ''
    const scoped = from ? res.body.match(new RegExp(cfg.re.replace('%FROM%', from), 'i')) : null
    const m = scoped ?? res.body.match(new RegExp(cfg.re.replace('"%FROM%"', '"[^"]+"'), 'i'))
    // 配置是 JSON，地址里的 `/` 都是 `\/` 转义过的
    const origin = new URL(decodeMaccmsUrl(m?.[1] ?? '')).origin
    playerOriginCache.set(key, { origin, at: Date.now() })
    return origin
  } catch {
    return ''
  }
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

function parseSource(html: string, rule: ParseRule): string | undefined {
  if (!rule.sourceRe) return undefined
  const raw = html.match(new RegExp(rule.sourceRe, 'i'))?.[1]
  if (!raw) return undefined
  const url = rule.sourceDecode === 'maccms' ? decodeMaccmsUrl(raw) : raw
  // 解码没解到位就当没取到：把 base64 残串当地址喂给播放器，
  // 表现是「解析成功但一集都播不了」，比明确报错难查得多
  return /^(https?:|\/\/)/i.test(url) ? url : undefined
}

export function createHtmlParser(rule: ParseRule): SiteParser {
  return {
    id: rule.id,
    name: rule.name,
    pattern: rule.pattern,
    challenge: rule.challenge === 'cdndefend' ? cdndefendChallenge : undefined,

    async parse(ctx: ParserContext, html: string): Promise<ParseResult> {
      const { lines, activeIndex } = parseLines(html, rule, ctx.pageUrl)
      const currentVideoUrl = parseSource(html, rule)

      if (!currentVideoUrl && !lines.length) {
        throw createError({ statusCode: 502, statusMessage: '页面结构不匹配，规则需要更新' })
      }

      // 防盗链域名优先从站点自己的播放器配置里现取，规则里写死的只当兜底。
      // 按需取址的单集请求（only=1）也走这里，所以每集都能拿到最新的域名。
      const playerOrigin = await resolvePlayerOrigin(rule, ctx, html)

      const base = {
        ruleId: rule.id,
        ruleName: rule.name,
        title: (rule.titleRe && decodeEntities(html.match(new RegExp(rule.titleRe, 'i'))?.[1] ?? '')) || parseTitle(html),
        pageUrl: ctx.pageUrl,
        currentVideoUrl,
        referer: playerOrigin ? playerOrigin + '/' : rule.referer,
        origin: playerOrigin || rule.origin,
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

      // ── 按需取址：解析阶段一集都不抓，只交一张作业单出去 ──
      // 逐集抓页是一集一个子请求，长剧要分多批、上百个请求，慢且容易被源站限流，
      // 而用户通常只看几集。改成播放器切到哪集才去抓哪集（见 useHtmlSourceResolver）。
      if (rule.lazy && target?.episodes.length) {
        // 传入的这一集属于目标线路的话，它的地址已经在手上了，顺手填上：
        // 界面上要有个能复制的真实地址，前端也就不必再为它多发一次请求
        const cur = target.episodes.find(ep => ep.pageUrl === ctx.pageUrl)
        if (cur && currentVideoUrl) cur.videoUrl = currentVideoUrl

        // 「这条线路给不给直链」还是要探一下——否则用户要播到某一集才发现整条线路是坏的。
        // 手上已有本线路的地址时白探一次没意义，只有切到别的线路时才花这一个请求。
        if (!cur) {
          const probe = target.episodes[0]
          try {
            const sub = await ctx.fetchPage(probe.pageUrl, ctx.cookie)
            const src = parseSource(sub.body, rule)
            if (src) probe.videoUrl = src
            else lineUnsupported = true
          } catch {
            // 探测失败不等于线路不可用（可能只是这一发超时），放行让播放时再试
          }
        } else if (!currentVideoUrl) {
          lineUnsupported = true
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
          clientTask: lineUnsupported ? undefined : clientTask,
        }
      }

      if (target?.episodes.length) {
        const resolveOne = async (ep: ParsedEpisode) => {
          // 传入的那一集已经解析过了，不重复请求
          if (ep.pageUrl === ctx.pageUrl && currentVideoUrl) {
            ep.videoUrl = currentVideoUrl
            return
          }
          try {
            const sub = await ctx.fetchPage(ep.pageUrl, ctx.cookie)
            if (this.challenge?.detect(sub.body)) { ep.error = '需要重新校验'; return }
            const src = parseSource(sub.body, rule)
            if (src) ep.videoUrl = src
            else ep.error = '该线路未给出直链'
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
          if (!todo[0].videoUrl) {
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
      }

      return {
        ...base,
        lines,
        activeLineIndex: targetIndex,
        batchFrom: offset,
        batchTo,
        remaining,
        lineUnsupported: lineUnsupported || undefined,
      }
    },
  }
}
