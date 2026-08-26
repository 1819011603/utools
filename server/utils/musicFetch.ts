/**
 * 音乐站抓取：**先走代理，撞墙再退直连**。
 *
 * ## 这里的顺序是实测出来的，而且我一开始搞反了
 *
 * 最初写成「刻意不走代理」，依据是一次观察：直连 200、经代理 403 `Just a moment`。
 * 后来发现那次多半是代理软件轮换节点时正好撞上 Cloudflare，**不是稳定结论**。
 * 真实情况反过来更常见：
 *
 *   · 直连出口容易先把**每日匿名配额**耗光（站点按 IP 限量，见 isQuotaExhausted），
 *     耗光后照常回 200，只是页面里不再有曲目数据 —— 极难归因
 *   · 走代理换个出口，同一个请求就能正常拿到数据（实测 200 / 9518 字节 / 有 itemMusic）
 *
 * 所以两条路都得留，且**代理在前**：它是本地开发的常规出口（同 fetchSitePage），
 * 撞上 CF 挑战页时再退回直连试一次。任何一条能拿到数据就算成功。
 *
 * CF Pages 上没有 `HTTPS_PROXY`，`getSiteDispatcher()` 返回空，等于直接走直连那条，
 * 所以线上行为不变；这套双通道真正服务的是**本地开发**。
 *
 * 约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { getSiteDispatcher } from './siteFetch'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

export interface MusicFetchResult {
  status: number
  body: string
}

/**
 * 抓一次。**返回状态码而不是抛错**，让调用方自己决定 403/404 该怎么说
 * —— 这个站的 403 和 404 含义完全不同（前者是被 CF 拦，后者是没这首歌）。
 */
export async function musicFetch(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string>; cookie?: string },
): Promise<MusicFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...init?.headers,
  }

  /*
   * 用户自己的登录态（可选）。站点对匿名访问按天限量，登录后额度另算 ——
   * 这是站点自己给的出路（配额页上就写着「如果您已注册过，可登录后访问」）。
   *
   * **只做透传，不落盘、不记日志**：这是用户的账号凭证，服务端拿到它唯一该做的事
   * 就是原样转给 24bit.net。任何形式的留存都会让一次「填个 cookie」变成长期的凭证托管。
   */
  if (init?.cookie) headers['Cookie'] = init.cookie

  const base = {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
    redirect: 'follow' as const,
  }

  /** 发一次。`useProxy=false` 时明确不带 dispatcher，走 Node 默认直连出口 */
  const once = async (dispatcher: any): Promise<MusicFetchResult> => {
    const opts: RequestInit & { dispatcher?: any } = { ...base }
    if (dispatcher) opts.dispatcher = dispatcher
    const res = await fetch(url, opts as RequestInit)
    return { status: res.status, body: await res.text() }
  }

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * 撞上 CF 挑战页时**原地重试几次**，而不是第一下没成就认命。
   *
   * 依据是 `resolve.ts` 那条注释里已经记过的观察：「同一请求前一次 200、后一次
   * ConnectTimeout」——Cloudflare 的边缘节点分布广，同一个 Worker 调用打到的
   * 边缘 PoP 不是固定的，这次判你可疑的那个 PoP，下一次很可能换了一个。
   * 用在**没有下一条路可退**的场景（线上没代理可退、或代理已经撞完退到直连这最后一步）。
   *
   * 只在 CF 墙上重试——配额耗尽（`isQuotaExhausted`）不归这个函数管，
   * 那是「今天这个 IP 用完了」，重试只会白烧额度，交给调用方按配额的说法去处理。
   *
   * **重试次数必须压低**：24bit 一次搜索是两条泳道并发（`useMusicSearch` 的 one/two），
   * 每条泳道自己在这儿重试几次，两条一乘就是好几发请求在几百毫秒内一起砸向 24bit.net——
   * 越砸越像 bot，等于在帮 Cloudflare 找理由继续拦。**只重试一次**，把「这次 PoP 不巧撞上」
   * 这类偶发情况捞回来就够了，别指望靠堆次数把真正的风控刷过去。
   */
  const withRetry = async (dispatcher: any, attempts: number): Promise<MusicFetchResult> => {
    let last: MusicFetchResult | undefined
    for (let i = 0; i < attempts; i++) {
      const res = await once(dispatcher)
      if (!isCloudflareWall(res.status, res.body)) return res
      last = res
      if (i < attempts - 1) await sleep(500)
    }
    return last!
  }

  const dispatcher = await getSiteDispatcher()

  try {
    // 没有代理（线上 CF Pages / 本地没设 HTTPS_PROXY）就只有直连这一条路——没有别的路可退，
    // 撞墙就地重试一次，比第一下没成就直接认输更对得起这类边缘节点级别的偶发拦截
    if (!dispatcher) return await withRetry(null, 2)

    const viaProxy = await once(dispatcher)

    /*
     * 只有撞上 CF 挑战页才退直连 —— **配额页不退**。
     * 配额是按出口 IP 算的，代理这条撞了配额说明这个出口今天用满了，
     * 退到直连多半也是满的（直连那条通常先被用光），白发一次请求还多烧一份额度。
     * 而 CF 挑战是「这个出口这一刻被判可疑」，换条路真有可能成。
     */
    if (!isCloudflareWall(viaProxy.status, viaProxy.body)) return viaProxy

    try {
      // 直连是这条链路的最后一步，同样值得重试几次再认输
      return await withRetry(null, 2)
    } catch {
      // 直连本身连不上（DNS 污染之类）就还是把代理那份还回去，让调用方按 CF 墙来报
      return viaProxy
    }
  } catch (e) {
    // 裸 Error 会被 h3 归成 500 +「internal server error」，statusMessage 到不了前端。
    // 这个域名实测会间歇性连不上（同一请求前一次 200、后一次 ConnectTimeout 到 CF 的 IP），
    // 说清是「连不上」而不是「搜索坏了」，用户才知道该重试而不是来报 bug
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const detail = err.cause?.code || err.cause?.message || err.message
    throw createError({
      statusCode: 502,
      statusMessage: `连不上音乐站（${detail}）。这个域名偶发不可达，稍后重试`,
    })
  }
}

/**
 * 认出 Cloudflare 的人机校验页。
 *
 * 判据同 searchRule.ts 的 `isCloudflareChallenge`，但这里**不能只看状态码**：
 * 403 也可能是别的原因。带上这一层是为了把「代理出口被 CF 拦」这个本地开发专有的坑
 * 直接说成人话，否则排查时只能看到一句 `源站返回 403`。
 */
export function isCloudflareWall(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false
  return body.includes('Just a moment') || body.includes('challenges.cloudflare.com')
}

/**
 * 撞上 CF 墙时统一的说法。**本地和线上必须说不同的话，因为根因完全不同**：
 *
 *   · 本地：几乎总是 dev server 带了 HTTPS_PROXY，代理出口被拦，去掉就好 —— 是个能修的事
 *   · 线上：拦的是 **Cloudflare 自己的出口**（源站也在 CF 后面，WAF 拦数据中心 ASN 或触发了
 *     行为风控），Workers 改不了出口 IP，请求头早就照浏览器发了，**没有能修的东西**
 *
 * 这个区别不做出来的话，线上会对着用户念「你的 dev server 带了代理」——
 * 一句在 pages.dev 上毫无意义的话，而它偏偏听起来很像个具体线索，
 * 足以让人往「配置写错了」的方向查半天（**已经发生过一次**）。
 * 判据用 `import.meta.dev`（Nitro 构建时替换成常量），不用任何运行时探测。
 *
 * **必须传入当前是哪个音源**、而且线上那句**绝不能点名推荐某个具体音源**——
 * 之前写死过「换用 24bit（24bit 线上正常）」，那是把 fangpi 单独在线上不可用
 * （`localOnly`，结构性的，见 `types.ts`）的结论套用到了所有调用方身上。
 * 24bit 自己也会撞同一堵墙（WAF 是按风控打分，不是按「是不是机房」这种一刀切规则，
 * 命中率比 fangpi 低但不是零）——那种情况下这条消息也会从 `server/api/music/*.ts` 里抛出来，
 * 念着「换用 24bit」而用户盯着的正是 24bit 报的错，整句话变得前后矛盾。
 */
export function cfWallMessage(siteName: string): string {
  if (import.meta.dev) {
    return '音乐站返回了人机校验页。本地开发时最常见的原因是 dev server 带了 HTTPS_PROXY —— '
      + '这个站必须直连，代理的出口 IP 会被 Cloudflare 拦。'
  }
  return `${siteName}现在被 Cloudflare 的人机校验拦住了（源站的校验拦的是 Cloudflare 的出口 IP，`
    + 'Workers 改不了出口）。多数情况过一会再试就好，也可以换搜索页上的另一个音源。'
}

/**
 * 认出「今日访问已达限额」。
 *
 * ## 这一条把一个本来无解的问题解决了
 *
 * 站点对匿名访问有**每日配额**，用完之后：**照常回 200**、页面照常渲染，
 * 只是不再有 `itemMusic` —— 和「这个音源没有这首歌」在状态码上一模一样。
 * 排查时极易误判成「规则失效」或「这首没资源」，我就连着判断错了两次
 * （先猜限流、又猜服务端被区别对待，都不对）。
 *
 * 好在页面本身把话说清楚了：正文里有「今日访问已达限额，可明日再来。」外加一个
 * `/login?from=…` 的入口。**认这句话，不认状态码**，就能把两件事彻底分开：
 *   · 配额用完 → 告诉用户明天再来（或去站点登录），别再发任何请求
 *   · 单纯没有 itemMusic → 这个音源确实没有这首歌，可以换另一个音源试
 *
 * 判据用中文原文而不是 `/login` 路径：登录入口在正常页面上也可能出现，
 * 而这句话只在配额耗尽时才有。
 */
export function isQuotaExhausted(body: string): boolean {
  return body.includes('今日访问已达限额')
}

/**
 * 配额耗尽时的统一说法。**必须点明「不是坏了」**——
 * 用户看到「取不到播放地址」只会以为功能有 bug，看到这句才知道该等明天。
 */
export const QUOTA_MESSAGE
  = '音乐站今日访问配额已用完（该站对匿名访问按天限量），明天再来，或到 24bit.net 登录后使用。'
