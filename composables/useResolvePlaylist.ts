/**
 * 「播放页地址 → 整条线路的播放地址」完整解析流程（前端侧）。
 *
 * 封装了三件容易写错的事，供 /video-parse 和播放器的「刷新链接」共用：
 *   1. 反爬工作量证明：服务端只返回挑战常量，nonce 由浏览器算（见 usePowSolver）
 *   2. 分批续拉：单请求有子请求上限，长剧要带 offset 拉多批再合并
 *   3. cookie 复用：解出来的 cookie 全站通用，同一会话内不必重算
 *
 * 抽出来的原因：播放器要能就地重新解析（带签名的地址会过期），
 * 两处各写一份必然漂移——尤其是分批合并那段，漏一轮就会静默少几集。
 */
import type { ParseResult, ParseRule } from './videoParseRules'

// 续拉轮数上限：单批 40 集，20 轮足够 800 集，纯粹防死循环
const MAX_BATCHES = 20

export interface ResolveOptions {
  pageUrl: string
  line?: number
  /** 已解出的 cookie，有就跳过工作量证明 */
  cookie?: string
  rules?: ParseRule[]
  /** 阶段文案回调，用于界面提示 */
  onStage?: (text: string) => void
  /** 工作量证明进度（已试次数） */
  onPow?: (tried: number) => void
}

export interface ResolveOutcome {
  result: ParseResult
  /** 本次用到/解出的 cookie，调用方可缓存下来复用 */
  cookie: string
}

const callApi = (
  pageUrl: string,
  step: string,
  cookie: string,
  line?: number,
  offset?: number,
  rules?: ParseRule[],
) =>
  $fetch<any>('/api/resolve', {
    query: {
      step,
      url: pageUrl,
      ...(cookie ? { cookie } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(offset ? { offset } : {}),
      ...(rules?.length ? { rules: JSON.stringify(rules) } : {}),
    },
  })

/**
 * 解析一轮；令牌没过（409）就丢掉重来一轮。
 *
 * 重试那一轮**必须把 cookie 清空**：清空才会从 step=challenge 起手，
 * 也才有机会重算 PoW——带着同一个已被拒的令牌再发一次只会再 409。
 */
export async function resolvePlaylist(opts: ResolveOptions): Promise<ResolveOutcome> {
  try {
    return await resolveOnce(opts)
  } catch (e) {
    if (!isPowRejected(e)) throw e
    dropPowToken(opts.pageUrl)
    return await resolveOnce({ ...opts, cookie: '' })
  }
}

async function resolveOnce(opts: ResolveOptions): Promise<ResolveOutcome> {
  const { pageUrl, line, rules, onStage, onPow } = opts
  // 令牌由浏览器持有（见 usePowCookie）：服务端那份缓存在 CF Pages 上换个 isolate 就没了
  let cookie = opts.cookie ?? readPowToken(pageUrl)

  onStage?.('正在获取页面…')
  let res = await callApi(pageUrl, cookie ? 'extract' : 'challenge', cookie, line, 0, rules)

  // 站点要求先过工作量证明 → 本地算 nonce 再重试
  if (res?.needPow) {
    onStage?.('正在计算站点校验…')
    const pow = await solvePow(res.c, res.n1, res.target, { onProgress: n => onPow?.(n) })
    cookie = pow.cookie
    savePowToken(pageUrl, cookie)  // 同站后续请求（按需取址、刷新链接）直接复用，不再重算
    onStage?.(`校验通过（${pow.tried} 次 / ${pow.ms}ms），正在解析选集…`)
    res = await callApi(pageUrl, 'extract', cookie, line, 0, rules)
  } else {
    onStage?.('正在解析选集…')
  }

  const first = res as ParseResult
  const episodes = first.lines[first.activeLineIndex]?.episodes ?? []
  const total = episodes.length

  // 有些站点页面里根本没有地址，服务端只能给一张「作业单」，最后一步要浏览器来做
  // （见 useClientResolve）。这类站点服务端一次就拿全了整季，不走下面的分批。
  const task = first.clientTask
  if (task) {
    if (task.lazy) {
      // 站点限流，不许一次全取。这里只取传入的那一集：既验证链路能通、
      // 又给界面一个能复制的真实地址；其余集等播到了再由播放器现取。
      const cur = Math.max(0, episodes.findIndex(e => e.pageUrl === first.pageUrl))
      // 服务端顺手带回来了就别再取一遍（htmlRule 的 lazy 分支会填当前集）
      if (episodes[cur] && !episodes[cur].videoUrl) {
        onStage?.('正在获取当前集地址…')
        await runClientResolve(sliceClientTask(task, [cur]), [episodes[cur]])
      }
    } else {
      await runClientResolve(task, episodes, {
        onStage,
        onProgress: (done, n) => onStage?.(`正在解析选集 ${done}/${n}…`),
      })
    }
    return { result: first, cookie }
  }

  // 首批只覆盖前若干集，长剧继续按 offset 把后面的批次拉完
  let next = first
  for (let round = 0; round < MAX_BATCHES && next.remaining > 0; round++) {
    onStage?.(`正在解析选集 ${next.batchTo}/${total}…`)
    const batch: ParseResult = await callApi(pageUrl, 'extract', cookie, line, next.batchTo, rules)

    // 每批返回的都是完整选集结构，但只有本批那几集带 videoUrl，按下标合并进来
    const got = batch.lines[batch.activeLineIndex]?.episodes ?? []
    for (let i = batch.batchFrom; i < batch.batchTo && i < total; i++) {
      if (!got[i]) continue
      episodes[i].videoUrl = got[i].videoUrl
      episodes[i].error = got[i].error
    }

    next = batch
    first.batchTo = batch.batchTo
    first.remaining = batch.remaining
  }

  return { result: first, cookie }
}

/**
 * 从解析结果里取出播放列表（地址与集名下标一一对应）。
 *
 * 按需取址的站点（clientTask.lazy）这里给的是**源站播放页地址占位**，不是真实视频地址：
 * 真实地址带时效签名、且站点限流不许批量取，只能等播到那一集再现取
 * （播放器的 resolveLazyUrl 负责，靠下标对回 clientTask.argsList）。
 * 所以这类结果必须整份带上，不能像下面那样按 videoUrl 过滤，否则下标就对不上了。
 */
export function toPlaylist(result: ParseResult): { urls: string[]; names: string[] } {
  const all = result.lines[result.activeLineIndex]?.episodes ?? []
  const eps = result.clientTask?.lazy ? all : all.filter(e => e.videoUrl)
  return {
    urls: eps.map((e, i) => (result.clientTask?.lazy ? e.pageUrl : e.videoUrl!) || `#${i}`),
    names: eps.map((e, i) => e.title || `第 ${i + 1} 集`),
  }
}
