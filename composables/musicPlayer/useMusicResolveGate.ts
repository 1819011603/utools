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
 *
 * ## 本文件一个站点都不认识
 *
 * `musicPlayer/` 是站点无关层，所以档位顺序、真正发请求那一下、配额措辞
 * 全部由 `pages/music.vue` 注入（同 `deps.resolve` 那个路子）。
 * 闸门只把 `site` 当**路由字符串**看，它的取值恰好是 `Track.resolver`。
 *
 * ## 所有额度都是**按站点**记的
 *
 * 这是接第二个站点时最容易漏的一点：24bit 配额用完不该把 fangpi 也一起判死
 * （后者压根没有配额这回事）。退避链、连续失败数、配额标记，**三样都按站点分开**。
 */
import type { ResolvedTrack, Track } from './types'

/** 相邻两发之间的起步间隔。失败会翻倍（见 interval） */
const BASE_INTERVAL_MS = 800
/** 退避上限。再长用户就该去干别的了，不如直接告诉他等一会儿 */
const MAX_INTERVAL_MS = 8000
/** 单发超时。慢站确实要几秒，但超过这个数多半是没戏了（fangpi 那边是两跳，留足） */
const RESOLVE_TIMEOUT_MS = 15000
/** 连续失败到这个数就停手报「可能被限流」，而不是默默把剩下的全标成失败 */
const RATE_LIMIT_STREAK = 3

/** 从 $fetch / ofetch 抛出的错误里取状态码。两种形状都要认，少认一种就漏判 */
function statusOf(e: unknown): number | undefined {
  const err = e as { statusCode?: number; status?: number; response?: { status?: number } }
  return err?.statusCode ?? err?.status ?? err?.response?.status
}

/**
 * 取服务端写的那句话。**它比我们在前端编的准得多**：
 * 服务端看得到站点原样的 `msg`（「今日访问已达限额」「请完成人机验证后继续」是两回事，
 * 状态码却都是 429），而前端只知道「这个站停了」。
 * ofetch 把 h3 的 `statusMessage` 塞在 `data` 里，几种形状都认一遍，少认一种就退回泛泛的措辞。
 */
function messageOf(e: unknown): string {
  const err = e as {
    statusMessage?: string
    data?: { statusMessage?: string; message?: string }
    response?: { _data?: { statusMessage?: string; message?: string } }
  }
  return (
    err?.data?.statusMessage
    ?? err?.data?.message
    ?? err?.response?._data?.statusMessage
    ?? err?.response?._data?.message
    ?? err?.statusMessage
    ?? ''
  ).trim()
}

export interface ResolveGateOptions {
  /** 这个站点按什么顺序试档位。**第一个是默认档** */
  tiersOf: (site: string) => readonly string[]
  /** 真正发请求的那一下。由页面接到站点注册表上（它才知道该请求哪个接口） */
  fetchOne: (
    site: string,
    id: string,
    tier: string,
    signal: AbortSignal,
  ) => Promise<ResolvedTrack & { src?: string }>
  /**
   * 这个站点配额耗尽时该说什么。
   * **返回 undefined = 这个站点没有「每日配额」这个概念**，闸门就不会为它准备停手那条路。
   */
  quotaHintOf: (site: string) => string | undefined
}

export function useMusicResolveGate(options: ResolveGateOptions) {
  /**
   * 连续失败次数，**按站点**。成功即归零 ——
   * 必须是「连续」而不是累计，否则用久了必然误判为限流。
   */
  const failStreaks = ref<Record<string, number>>({})
  /**
   * 已经判定配额耗尽的站点（服务端认出「今日访问已达限额」后回 429）。
   *
   * 一旦置位就对**这个站点**彻底停手：不试它剩下的档、不排它后面的歌、连请求都不发。
   * 配额是按天按 IP 给的，这时候每多发一发都是纯浪费 —— 而且会把整份队列
   * 拖着一首首失败一遍，用户还以为是功能坏了。
   *
   * 不自动复位：配额要到第二天才回来。用户主动重试（resetBackoff）时才清掉 ——
   * 万一他刚去站点登录了呢。
   */
  const quotaOut = ref<Record<string, boolean>>({})
  /**
   * 停手的**理由原文**（服务端写的那句），按站点存。
   *
   * 只有 `quotaOut` 这个标志位是不够的：429 只表示「别再打了」，
   * 而 24bit 的 429 是「今天的配额用完了，明天见」、fangpi 的 429 是「去过一次人机验证」——
   * 出路完全不同，摆一句「今日配额已用完」在 fangpi 上纯属误导（它压根没有配额这回事）。
   */
  const stopReason = ref<Record<string, string>>({})

  const streakOf = (site: string) => failStreaks.value[site] ?? 0
  const intervalOf = (site: string) =>
    Math.min(BASE_INTERVAL_MS * 2 ** streakOf(site), MAX_INTERVAL_MS)

  /** 这个站点是不是在限流。界面据此换措辞并劝用户等一会儿 */
  const isRateLimited = (site: string) => streakOf(site) >= RATE_LIMIT_STREAK
  const isQuotaOut = (site: string) => !!quotaOut.value[site]

  /** 有任何站点撞上配额/限流 —— 页面用它决定要不要渲染那两条常驻提示 */
  const troubledSites = computed(() =>
    Object.keys({ ...quotaOut.value, ...failStreaks.value })
      .filter(s => isQuotaOut(s) || isRateLimited(s)),
  )

  /**
   * 每个站点一条串行链：保证**同一站点同一时刻只有一发在飞**。
   * 分开是因为一个站点的退避不该让另一个站点干等 —— 它们的耐心是各自的。
   */
  interface SiteLane { chain: Promise<unknown>; lastSentAt: number }
  const lanes = new Map<string, SiteLane>()
  const laneOf = (site: string): SiteLane => {
    let lane = lanes.get(site)
    if (!lane) { lane = { chain: Promise.resolve(), lastSentAt: 0 }; lanes.set(site, lane) }
    return lane
  }

  /**
   * 同一首歌的在途请求。
   * 切歌、下载、预取可能同时想要同一首，复用同一个 promise 比发两遍好
   * —— 既省一发请求，也避开「两发并发互相踩」。
   */
  const inflight = new Map<string, Promise<ResolvedTrack>>()

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** 发一次，带超时。超时**不计入限流判据** —— 那可能只是网络慢，不是站点在拒我们 */
  const sendOnce = async (site: string, id: string, tier: string) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS)
    try {
      return await options.fetchOne(site, id, tier, ctrl.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取址。**一首歌最多把它所在站点的档位各试一遍**：每多试一个档就多一发请求，
   * 而站点会限流 —— 为一首歌把额度烧掉，后面每一首都要跟着受罪。
   */
  const resolveTrack = async (track: Track): Promise<ResolvedTrack> => {
    /** 路由只看 `Track.resolver`。存量收藏里躺着的正是 `'24bit'`，所以老数据天然是对的 */
    const site = track.resolver
    const locator = track.locator as { id?: string; preferred?: string } | undefined
    const id = locator?.id
    if (!site || !id) throw new Error('这条曲目没有取址信息')

    const tiers = options.tiersOf(site)
    if (!tiers.length) throw new Error(`不认识「${site}」这个音乐源，可能是收藏里的旧数据`)

    // 配额没了就别再发请求了。放在最前面，连排队都不排
    const quotaHint = options.quotaHintOf(site)
    if (isQuotaOut(site)) throw new Error(stopReason.value[site] || quotaHint || '这个音乐源今日配额已用完')

    const hit = inflight.get(track.key)
    if (hit) return hit

    // 上次成功过的档排到最前：省掉一发注定失败的请求
    const tries = locator.preferred && tiers.includes(locator.preferred)
      ? [locator.preferred, ...tiers.filter(t => t !== locator.preferred)]
      : [...tiers]

    const job = (async (): Promise<ResolvedTrack> => {
      let lastErr: unknown = null
      for (const tier of tries) {
        const lane = laneOf(site)
        // 排队：等这个站点前一发结束，再等够它自己的退避间隔
        const mine = lane.chain.then(async () => {
          const wait = lane.lastSentAt + intervalOf(site) - Date.now()
          if (wait > 0) await sleep(wait)
        })
        lane.chain = mine.catch(() => {})
        await mine

        try {
          const r = await sendOnce(site, id, tier)
          lane.lastSentAt = Date.now()
          failStreaks.value[site] = 0                // 成功即归零，「连续」才有意义
          locator.preferred = r.src ?? tier          // 记住命中的档，下次先试它
          return r
        } catch (e) {
          lane.lastSentAt = Date.now()
          lastErr = e

          /*
           * 429 = 服务端认出了「今日访问已达限额」。**当场对这个站点收手**：
           * 它剩下的档、以及后面排队的每一首，全都注定失败。
           * 不 break 的话用户会眼看着整份队列一首首红过去，还以为是我们坏了。
           */
          if (statusOf(e) === 429) {
            quotaOut.value[site] = true
            // 服务端那句最准（配额用完 / 要人机验证 / 别的停手理由，429 只说了「停」没说「为什么」）
            stopReason.value[site] = messageOf(e) || quotaHint || '这个音乐源今日配额已用完'
            throw new Error(stopReason.value[site])
          }

          // 超时不算「站点在拒我们」，不推高退避
          if (!(e instanceof Error && e.name === 'AbortError')) {
            failStreaks.value[site] = streakOf(site) + 1
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('取不到播放地址')
    })().finally(() => inflight.delete(track.key))

    inflight.set(track.key, job)
    return job
  }

  /**
   * 失败时该说什么。**不能写死「没有资源」** —— 「这首没资源」和「被限流了」
   * 在响应上完全一样，说死了既冤枉站点也误导用户。
   * 只有连续失败到一定次数时，才有底气偏向「限流」这一侧。
   */
  const failureMessage = (site?: string, name?: string) => {
    const who = name ? `《${name}》` : '这首歌'
    if (!site) return `${who}暂时取不到播放地址`

    if (isQuotaOut(site)) return stopReason.value[site] || options.quotaHintOf(site) || '这个音乐源今日配额已用完'
    if (isRateLimited(site)) return '连续几首都取不到地址，可能是站点在限速 —— 等几分钟再试。'

    /*
     * 只有一个档的站点（fangpi）**不能说「换另一个档试试」** —— 它没有另一个档，
     * 那句话会让用户在界面上白找。这时候唯一的出路是换一个站点那一段。
     */
    return options.tiersOf(site).length > 1
      ? `${who}的这个音质档没有资源，换另一个档试试。`
      : `${who}在这个音乐源上没有资源，换上面另一个音乐源试试。`
  }

  /**
   * 用户主动重试时清掉退避 —— 否则他点了也得干等好几秒，看着像没反应。
   * 顺带清掉配额标记：用户可能刚去站点登录过，值得再给一次机会（错了也只是一发请求）。
   */
  const resetBackoff = () => { failStreaks.value = {}; quotaOut.value = {}; stopReason.value = {} }

  return {
    resolveTrack,
    isRateLimited,
    isQuotaOut,
    stopReason,
    troubledSites,
    failureMessage,
    resetBackoff,
  }
}
