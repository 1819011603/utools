/**
 * 反爬工作量证明令牌的**前端**缓存（按 host）+ 统一的「409 就重算一轮」入口。
 *
 * 服务端 `server/parsers/cookieStore.ts` 那份在 Cloudflare Pages 上**靠不住**：
 * 它是 module 级 Map，只活在当前 isolate 里，下一个请求换个 isolate 就是空的
 * （本地 Node 单进程反而一直命中，所以这类问题只在线上偶发）。
 * 于是「解析页刚算过 PoW、播放器按需取址那一发却 409」是常态——
 * 表现正是「从 /video-parse 进 /video-player 报错，刷新又好了」。
 *
 * 唯一兜得住的办法是：**令牌归浏览器持有，每一发 extract 都自己带上**，不指望服务端记得；
 * 真没过（令牌过期 / 站点换常量）就当场重算一轮再试一次。
 *
 * 与 useVideoSearch 里那份 `powTokens` 是两份缓存（搜索走 /api/search），各自算一次的代价可接受。
 */

const TTL = 30 * 60 * 1000
const tokens = new Map<string, { token: string; at: number }>()

/**
 * 同一 host 只算一轮 PoW：按需取址有 3 条并发，令牌一过期就是三发同时 409，
 * 不去重等于把 6.5 万次 SHA1 算三遍，还会各自去抓一次挑战页。
 */
const solving = new Map<string, Promise<string>>()

const hostOf = (url: string) => {
  try { return new URL(url).host } catch { return url }
}

export function readPowToken(url: string): string {
  const host = hostOf(url)
  const hit = tokens.get(host)
  if (!hit) return ''
  if (Date.now() - hit.at > TTL) {
    tokens.delete(host)
    return ''
  }
  return hit.token
}

export function savePowToken(url: string, token: string) {
  if (token) tokens.set(hostOf(url), { token, at: Date.now() })
}

export function dropPowToken(url: string) {
  tokens.delete(hostOf(url))
}

/** 服务端说「你这令牌没过」。$fetch 的错误形状随环境不同，三处都认一下 */
export const isPowRejected = (e: any) =>
  (e?.statusCode || e?.response?.status || e?.status) === 409

/**
 * 现算一份新令牌（同 host 并发只算一轮）。站点压根没有反爬挑战时返回 ''。
 *
 * 探挑战用 `only=1`：这一步只为拿常量，别顺手把整季选集解析一遍。
 */
export async function solvePowToken(pageUrl: string, onPow?: (tried: number) => void): Promise<string> {
  const host = hostOf(pageUrl)
  const cur = solving.get(host)
  if (cur) return cur

  const p = (async () => {
    // 用户自定义规则服务端没有（Nitro 里没 localStorage），不带上去会匹配不到规则直接 400
    const rules = loadUserParseRules()
    const res: any = await $fetch('/api/resolve', {
      query: {
        step: 'challenge',
        url: pageUrl,
        only: '1',
        ...(rules.length ? { rules: JSON.stringify(rules) } : {}),
      },
    })
    if (!res?.needPow) return ''
    const pow = await solvePow(res.c, res.n1, res.target, { onProgress: n => onPow?.(n) })
    savePowToken(pageUrl, pow.cookie)
    return pow.cookie
  })()

  solving.set(host, p)
  p.then(
    () => { if (solving.get(host) === p) solving.delete(host) },
    () => { if (solving.get(host) === p) solving.delete(host) },
  )
  return p
}

/**
 * 带着令牌跑一发请求；只在服务端回 409 时重算一轮再试**一次**（别死循环）。
 * 其余错误原样抛出——把网络错/源站 502 也吞进重试只会把限流坐实。
 */
export async function withPowRetry<T>(pageUrl: string, run: (token: string) => Promise<T>): Promise<T> {
  try {
    return await run(readPowToken(pageUrl))
  } catch (e) {
    if (!isPowRejected(e)) throw e
    dropPowToken(pageUrl)
    return await run(await solvePowToken(pageUrl))
  }
}
