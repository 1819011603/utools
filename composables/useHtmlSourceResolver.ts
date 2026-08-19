/**
 * 取址执行器之一：逐集抓源站播放页，用规则的 sourceRe 抠出播放地址。
 *
 * 抠地址那步仍在服务端（`/api/resolve?only=1`）——浏览器受 CORS 限制取不到第三方页面，
 * 正则和解码也没必要在两边各写一份。这里做的只是「什么时候抓」：
 * 解析阶段一集不抓，播放器切到哪集才发哪一集的请求。
 *
 * 于是长剧从「上百个子请求、分多批」变成「一集一个请求」，
 * 顺带绕开 CF「单请求 50 subrequest」的硬顶——每一集都是独立的 Worker 调用。
 */
import type { HtmlSourceTask, ParsedEpisode } from './videoParseRules'
import type { ClientResolveOptions } from './useClientResolve'

// 并发抓页。源站对这类站点普遍有限流，按需取址时通常也只有一集，
// 给到 3 只是为了「解析页一次性取多集」这种少见场景不至于串行等太久。
const CONCURRENCY = 3

export async function runHtmlSourceResolve(
  task: HtmlSourceTask,
  episodes: ParsedEpisode[],
  opts: ClientResolveOptions = {},
) {
  const total = Math.min(task.pageUrls.length, episodes.length)
  let done = 0

  // 用户自定义规则服务端没有（Nitro 里没 localStorage），得随请求带上去，
  // 否则自定义规则的站点解析阶段能通、按需取址却匹配不到规则
  const rules = loadUserParseRules()

  const one = async (i: number) => {
    const pageUrl = task.pageUrls[i]
    const ep = episodes[i]
    if (!pageUrl || !ep) return
    try {
      // 反爬令牌必须**自己带上**：服务端那份按 host 的缓存是 module 级 Map，
      // 在 Cloudflare Pages 上换个 isolate 就是空的，而这条 only=1 的路径自身走不到
      // step=challenge，服务端只能回 409。表现就是「解析页好好的，播放器切集报校验未通过，
      // 刷新又好了」（踩过）。withPowRetry 负责 409 时现算一轮再重试一次。
      const res = await withPowRetry(pageUrl, token => $fetch<any>('/api/resolve', {
        query: {
          step: 'extract',
          url: pageUrl,
          only: '1',
          ...(token ? { cookie: token } : {}),
          ...(rules.length ? { rules: JSON.stringify(rules) } : {}),
        },
      }))
      // 拿到地址就算这一集成功；只有它彻底要不到地址时才落到 error
      if (res?.currentVideoUrl) ep.videoUrl = res.currentVideoUrl
      else ep.error = '该集未给出直链'
      // 防盗链域名是服务端从站点播放器配置里现取的，会变——每集取址都把最新值带回去，
      // 否则站点换了播放器域名后，播到某一集就开始 403，而候选值还停在进页面时那份
      if (res?.origin || res?.referer) opts.onHints?.(res.origin, res.referer)
    } catch (e: any) {
      ep.error = e?.statusMessage || e?.message || '取址失败'
    } finally {
      opts.onProgress?.(++done, total)
    }
  }

  const indices = Array.from({ length: total }, (_, i) => i)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (cursor < indices.length) await one(indices[cursor++])
    }),
  )
}
