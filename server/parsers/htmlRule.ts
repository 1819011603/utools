/**
 * 数据驱动的通用策略：地址明文写在页面里，全靠几条正则抠。
 *
 * 覆盖 videoParseRules.ts 的内置规则表和用户自定义规则——加这类站点不用写代码，
 * 加一条规则即可。真正需要写代码的站点走 server/parsers/sites/ 下的独立策略。
 */
import type { ParseRule, ParsedEpisode, ParsedLine, ParseResult } from '../../composables/videoParseRules'
import type { ParserContext, SiteParser } from './types'
import { absolutize, decodeEntities, parseTitle, pool } from './utils'
import { cdndefendChallenge } from './challenges/cdndefend'

// 单次请求最多解析多少集。CF 免费版单请求 50 subrequest 硬顶，留出主页面那一发和余量，取 40。
// 超出的不丢弃也不截断：用 offset 分批，前端拿到 remaining>0 就继续拉下一批，
// 每批各自是一次独立请求，各自的 subrequest 预算互不叠加，所以多少集都能解析完。
const MAX_EPISODES = 40
// 解析各集的并发。太高会被源站限流，也更容易撞 CF 的并发子请求限制。
const EPISODE_CONCURRENCY = 4

/** 解析线路 × 选集表。适用于「所有线路的选集都渲染在同一页」的站点。 */
function parseLines(html: string, rule: ParseRule, pageUrl: string): { lines: ParsedLine[]; activeIndex: number } {
  if (!rule.lineRe || !rule.episodeGroupRe || !rule.episodeRe) return { lines: [], activeIndex: -1 }

  const lineMatches = [...html.matchAll(new RegExp(rule.lineRe, 'gi'))]
  const groupMatches = [...html.matchAll(new RegExp(rule.episodeGroupRe, 'gi'))]

  const lines: ParsedLine[] = []
  let activeIndex = -1

  // 线路标签与选集容器按出现顺序一一对应（三个不同页面实测恒等：16/16、18/18、17/17）。
  // 数量不等说明页面改版了，此时宁可只输出能对上的前 N 组，也不要错位。
  const n = Math.min(lineMatches.length, groupMatches.length)
  for (let i = 0; i < n; i++) {
    const lm = lineMatches[i]
    const active = /active/i.test(lm[1] ?? '')
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
  return html.match(new RegExp(rule.sourceRe, 'i'))?.[1]
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

      // 要解析哪条线路：显式指定 > 页面标记的 active > 第一条
      const targetIndex = Number.isFinite(ctx.line as number) && (ctx.line as number) >= 0 && (ctx.line as number) < lines.length
        ? (ctx.line as number)
        : (activeIndex >= 0 ? activeIndex : 0)

      const target = lines[targetIndex]
      const offset = ctx.offset
      let batchTo = offset
      let remaining = 0
      let lineUnsupported = false

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
        ruleId: rule.id,
        ruleName: rule.name,
        title: parseTitle(html),
        pageUrl: ctx.pageUrl,
        currentVideoUrl,
        lines,
        activeLineIndex: targetIndex,
        batchFrom: offset,
        batchTo,
        remaining,
        lineUnsupported: lineUnsupported || undefined,
        referer: rule.referer,
      }
    },
  }
}
