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

export async function resolvePlaylist(opts: ResolveOptions): Promise<ResolveOutcome> {
  const { pageUrl, line, rules, onStage, onPow } = opts
  let cookie = opts.cookie ?? ''

  onStage?.('正在获取页面…')
  let res = await callApi(pageUrl, cookie ? 'extract' : 'challenge', cookie, line, 0, rules)

  // 站点要求先过工作量证明 → 本地算 nonce 再重试
  if (res?.needPow) {
    onStage?.('正在计算站点校验…')
    const pow = await solvePow(res.c, res.n1, res.target, { onProgress: n => onPow?.(n) })
    cookie = pow.cookie
    onStage?.(`校验通过（${pow.tried} 次 / ${pow.ms}ms），正在解析选集…`)
    res = await callApi(pageUrl, 'extract', cookie, line, 0, rules)
  } else {
    onStage?.('正在解析选集…')
  }

  const first = res as ParseResult
  const episodes = first.lines[first.activeLineIndex]?.episodes ?? []
  const total = episodes.length

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

/** 从解析结果里取出可播的地址与集名（下标一一对应） */
export function toPlaylist(result: ParseResult): { urls: string[]; names: string[] } {
  const eps = (result.lines[result.activeLineIndex]?.episodes ?? []).filter(e => e.videoUrl)
  return {
    urls: eps.map(e => e.videoUrl!),
    names: eps.map((e, i) => e.title || `第 ${i + 1} 集`),
  }
}
