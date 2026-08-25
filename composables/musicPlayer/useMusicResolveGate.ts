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
    return rateLimited.value
      ? `连续几首都取不到地址，多半是被站点限流了 —— 等几分钟再试。`
      : `${who}暂时取不到播放地址（可能这个音源没有资源，也可能是站点限流）。`
  }

  /** 用户主动重试时清掉退避，否则他点了也得干等好几秒，看着像没反应 */
  const resetBackoff = () => { failStreak.value = 0 }

  return { resolveTrack, rateLimited, failStreak, resolveInterval: interval, failureMessage, resetBackoff }
}
