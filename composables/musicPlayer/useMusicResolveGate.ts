/**
 * 取址闸门：所有「把占位换成真实播放地址」的请求都从这里过。
 *
 * ## 为什么需要它
 *
 * 24bit 的限流是**静默**的 —— 实测密集取址之后，详情页照常回 200、页面照常渲染，
 * 只是不再吐 `itemMusic`。没有错误码、没有 `cf-mitigated`、没有任何「频繁」字样。
 * 一条本来稳定成功的地址在连发几十次之后就再也取不到了。
 *
 * 后果是：**「这首歌没资源」和「你被限流了」在响应上完全无法区分。**
 * 所以我们只能从**发送侧**下手 —— 别把站点惹毛，是唯一可靠的手段。
 *
 * 这也是为什么搜索结果页**不预先探测每首是否可播**：30 首 × 2 音源 = 60 发请求，必被限流。
 */
import type { DetailPrefix } from '../music24bit'
import type { ResolvedTrack, Track } from './types'

/** 相邻两发之间的起步间隔。失败会翻倍（见 backoff） */
const BASE_INTERVAL_MS = 800
/** 退避上限。再长用户就该去干别的了，不如直接告诉他等一会儿 */
const MAX_INTERVAL_MS = 8000
/** 单发超时。慢站确实要几秒，但超过这个数多半是没戏了 */
const RESOLVE_TIMEOUT_MS = 15000
/** 连续失败到这个数就停手报「可能被限流」，而不是默默把剩下的全标成失败 */
const RATE_LIMIT_STREAK = 3

/**
 * 配额耗尽时给用户看的话。**必须点明这不是故障**——
 * 只说「取不到播放地址」，用户只会以为功能坏了，然后反复点、把明天的心情也搭进去。
 */
const QUOTA_HINT = '音乐站今日访问配额已用完（该站对匿名访问按天限量），明天再来，或到 24bit.net 登录后使用。'

/** 从 $fetch / ofetch 抛出的错误里取状态码。两种形状都要认，少认一种就漏判 */
function statusOf(e: unknown): number | undefined {
  const err = e as { statusCode?: number; status?: number; response?: { status?: number } }
  return err?.statusCode ?? err?.status ?? err?.response?.status
}

export interface ResolveGateOptions {
  /** 真正发请求的那一下。由适配层提供（它知道要请求哪个站点的什么地址） */
  fetchOne: (id: string, src: DetailPrefix, signal: AbortSignal) => Promise<ResolvedTrack & { src?: DetailPrefix }>
  /** 音源尝试顺序。默认 b 在前（体积小五倍），取不到再退 c */
  order?: readonly DetailPrefix[]
}

export function useMusicResolveGate(options: ResolveGateOptions) {
  const order = options.order ?? (['b', 'c'] as const)

  /** 连续失败次数。**成功即归零** —— 必须是「连续」而不是累计，否则用久了必然误判为限流 */
  const failStreak = ref(0)
  /** 判定为限流，界面据此换措辞并劝用户等一会儿 */
  const rateLimited = computed(() => failStreak.value >= RATE_LIMIT_STREAK)

  /**
   * 站点今日配额已耗尽（服务端认出「今日访问已达限额」后回 429）。
   *
   * 一旦置位就**彻底停手**：不试第二个音源、不排后面的歌、连请求都不发。
   * 配额是按天按 IP 给的，这时候每多发一发都是纯浪费 —— 而且会把整份队列
   * 拖着一首首失败一遍，用户还以为是功能坏了。
   *
   * 不自动复位：配额要到第二天才回来，本次会话内再试没有意义。
   * 用户主动重试（resetBackoff）时才清掉 —— 万一他去站点登录了呢。
   */
  const quotaExhausted = ref(false)
  /** 当前退避间隔，展示用 */
  const interval = computed(() =>
    Math.min(BASE_INTERVAL_MS * 2 ** failStreak.value, MAX_INTERVAL_MS),
  )

  /** 上一发的完成时刻，用来算「还要等多久才准发下一发」 */
  let lastSentAt = 0
  /** 串行链：每一发都挂在上一发后面，保证**同一时刻只有一发在飞** */
  let chain: Promise<unknown> = Promise.resolve()

  /**
   * 同一首歌的在途请求。
   * 切歌、下载、预取可能同时想要同一首，复用同一个 promise 比发两遍好
   * —— 既省一发请求，也避开「两发并发互相踩」（video-parse 那边 nbmovie 的时间戳就是这么踩的）。
   */
  const inflight = new Map<string, Promise<ResolvedTrack>>()

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** 发一次，带超时。超时**不计入限流判据**——那可能只是网络慢，不是站点在拒我们 */
  const sendOnce = async (id: string, src: DetailPrefix) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS)
    try {
      return await options.fetchOne(id, src, ctrl.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取址。**一首歌最多两发**（两个音源各一次）：每多试一个前缀就多一发请求，
   * 而这个站会限流 —— 为一首歌把额度烧掉，后面每一首都要跟着受罪。
   */
  const resolveTrack = async (track: Track): Promise<ResolvedTrack> => {
    const locator = track.locator as { id?: string; preferred?: DetailPrefix } | undefined
    const id = locator?.id
    if (!id) throw new Error('这条曲目没有取址信息')

    // 配额没了就别再发请求了。放在最前面，连排队都不排
    if (quotaExhausted.value) throw new Error(QUOTA_HINT)

    const hit = inflight.get(track.key)
    if (hit) return hit

    // 上次成功过的音源排到最前：省掉一发注定失败的请求
    const tries = locator.preferred
      ? [locator.preferred, ...order.filter(s => s !== locator.preferred)]
      : [...order]

    const job = (async (): Promise<ResolvedTrack> => {
      let lastErr: unknown = null
      for (const src of tries) {
        // 排队：等前一发结束，再等够退避间隔
        const mine = chain.then(async () => {
          const wait = lastSentAt + interval.value - Date.now()
          if (wait > 0) await sleep(wait)
        })
        chain = mine.catch(() => {})
        await mine

        try {
          const r = await sendOnce(id, src)
          lastSentAt = Date.now()
          failStreak.value = 0                       // 成功即归零，「连续」才有意义
          locator.preferred = r.src ?? src           // 记住命中的音源，下次先试它
          return r
        } catch (e) {
          lastSentAt = Date.now()
          lastErr = e

          /*
           * 429 = 服务端认出了「今日访问已达限额」。**当场收手**：
           * 剩下那个音源、以及后面排队的每一首，全都注定失败。
           * 不 break 的话用户会眼看着整份队列一首首红过去，还以为是我们坏了。
           */
          if (statusOf(e) === 429) {
            quotaExhausted.value = true
            throw new Error(QUOTA_HINT)
          }

          // 超时不算「站点在拒我们」，不推高退避
          if (!(e instanceof Error && e.name === 'AbortError')) failStreak.value++
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('取不到播放地址')
    })().finally(() => inflight.delete(track.key))

    inflight.set(track.key, job)
    return job
  }

  /**
   * 失败时该说什么。**不能写死「没有资源」**——两种情况响应完全一样，
   * 说死了既冤枉站点也误导用户。只有在连续失败到一定次数时，才有底气偏向「限流」这一侧。
   */
  const failureMessage = (name?: string) => {
    const who = name ? `《${name}》` : '这首歌'
    if (quotaExhausted.value) return QUOTA_HINT
    return rateLimited.value
      ? '连续几首都取不到地址，可能是站点在限速 —— 等几分钟再试。'
      : `${who}的这个音质档没有资源，换另一个档试试。`
  }

  /**
   * 用户主动重试时清掉退避 —— 否则他点了也得干等好几秒，看着像没反应。
   * 顺带清掉配额标记：用户可能刚去站点登录过，值得再给一次机会（错了也只是一发请求）。
   */
  const resetBackoff = () => { failStreak.value = 0; quotaExhausted.value = false }

  return {
    resolveTrack, rateLimited, quotaExhausted, failStreak,
    resolveInterval: interval, failureMessage, resetBackoff,
  }
}
