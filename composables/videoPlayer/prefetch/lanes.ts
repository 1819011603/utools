/**
 * 连接 lane：负载均衡 + 熔断。
 *
 * 「lane」= 同一个分片的多种取法（直连 CDN / 经 `/api/proxy`）。浏览器对**每个 origin**
 * 只给 6 条并发连接，所以把请求分摊到两个 origin 就能把聚合并发提到 ~12（见 CLAUDE.md 的双通道）。
 *
 * 从 `useHlsPrefetch` 里拆出来的两件事：
 *   · 每条新连接分给「在途最少」的 lane，各 origin 都不超过 6 条；
 *   · 某条 lane 连续失败而别的 lane 还在成功 → 熔断它，双通道自动退回单通道。
 *
 * 熔断是必须的：起播前的可达性探测未必覆盖得到分片轴（清单通了但没解析出分片时它整轮跳过），
 * 探测本身也可能因为源站返回怪东西而假阳性。真实请求就是最后一道探测。
 * 不熔断的表现是「视频能播，但一半请求 403」——白扔一半连接，控制台刷屏
 *（实测 maowushi 源：分片要 Referer，直连 lane 每发必 403，代理 lane 正常 200）。
 *
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`——
 * 它不该出现在全局自动导入的命名空间里。
 */
import type { Ref } from 'vue'

const LANE_TRIP_FAILS = 3   // 连续失败到这个数就熔断（首片偶发失败不算数）
/**
 * 熔断的**观察期**（ms）：过了这么久就把 lane 放回来试一次（失败再连续 3 次会重新熔断）。
 *
 * **熔断必须能自愈**（踩过：切 Wi-Fi / 网络卡一下之后「完全不能加载」）：熔断是永久的时候，
 * 网络抖动那几秒里两条 lane 都在失败，先攒够 3 次的那条被判死——而它可能正是换网之后
 * 唯一走得通的那条（出口 IP 一变，直连能不能通、代理会不会被 403 全都变了）。
 * 之后它再也不会被取用，也就永远没有机会证明自己好了，`laneDead` 一路留到换视频。
 * 观察期取 30s：比一次网络切换长，短到用户不会觉得「一直只用一条」。
 */
const LANE_PROBATION_MS = 30_000

export interface LaneAllocation {
  lane: number
  laneUrl: string
  laneCount: number
}

export interface LaneControl {
  /** 已熔断的 lane（响应式，供 UI 显示「已降为单通道」） */
  laneDead: Ref<boolean[]>
  acquireLane: (url: string) => LaneAllocation
  releaseLane: (lane: number) => void
  markLaneOk: (lane: number) => void
  markLaneFail: (lane: number, laneCount: number) => void
  /** 换视频/换策略时清空：新源的可达性与上一个源无关 */
  resetLanes: () => void
  /**
   * 把熔断记录整份作废（不动在途计数）。用在「网络环境变了」这一刻——
   * 换 Wi-Fi / 切蜂窝之后出口 IP 全换，之前那些 403/超时的结论一条都不再成立。
   */
  reviveLanes: () => void
  /** 当前流的**可用** lane 数（排除熔断的），用于放宽并发上限 */
  getLaneCount: (sampleUrl?: string) => number
}

export function useLaneControl(getLaneUrls: (url: string) => string[]): LaneControl {
  const laneInflight: number[] = []
  const laneFails: number[] = []    // 各 lane 的连续失败数（成功即清零）
  const laneOks: number[] = []      // 各 lane 的累计成功数
  const laneTrippedAt: number[] = [] // 各 lane 的熔断时刻（观察期到了就放回来试，见 LANE_PROBATION_MS）
  const laneDead = ref<boolean[]>([])

  const laneAlive = (i: number) => !laneDead.value[i]

  /** 观察期已过的熔断 lane 就地复活（返回是否动过）。取用 lane 前先跑一遍，好让它有机会证明自己 */
  const releaseProbation = (): boolean => {
    if (!laneDead.value.some(Boolean)) return false
    const now = Date.now()
    const next = laneDead.value.slice()
    let changed = false
    next.forEach((dead, i) => {
      if (!dead || now - (laneTrippedAt[i] ?? 0) < LANE_PROBATION_MS) return
      next[i] = false
      laneFails[i] = 0          // 归零，否则一进来就又满 3 次立刻二次熔断
      changed = true
      console.info(`[lane] 第 ${i} 条通道观察期已过，放回来再试`)
    })
    if (changed) laneDead.value = next
    return changed
  }

  const markLaneOk = (lane: number) => {
    laneFails[lane] = 0
    laneOks[lane] = (laneOks[lane] ?? 0) + 1
  }

  const markLaneFail = (lane: number, laneCount: number) => {
    laneFails[lane] = (laneFails[lane] ?? 0) + 1
    if (laneFails[lane] < LANE_TRIP_FAILS || laneDead.value[lane]) return
    // 只剩一条活 lane 时绝不熔断——那不是「换一条路」，是把下载彻底掐死
    const aliveCount = Array.from({ length: laneCount }, (_, i) => i).filter(laneAlive).length
    if (aliveCount <= 1) return
    const next = laneDead.value.slice()
    next[lane] = true
    laneTrippedAt[lane] = Date.now()
    laneDead.value = next
    console.warn(`[lane] 第 ${lane} 条通道连续失败 ${laneFails[lane]} 次，已熔断（双通道降为单通道，${LANE_PROBATION_MS / 1000}s 后再试）`)
  }

  const resetLanes = () => {
    laneFails.length = 0
    laneOks.length = 0
    laneInflight.length = 0
    laneTrippedAt.length = 0
    laneDead.value = []
  }

  const reviveLanes = () => {
    laneFails.length = 0
    laneTrippedAt.length = 0
    if (laneDead.value.some(Boolean)) console.info('[lane] 网络环境已变，熔断记录整份作废')
    laneDead.value = []
  }

  const acquireLane = (url: string): LaneAllocation => {
    releaseProbation()
    const urls = getLaneUrls(url)
    // 熔断过的 lane 直接排除；万一全被熔断（不该发生，markLaneFail 保底留一条）就退回全体
    let pool = urls.map((_, i) => i).filter(laneAlive)
    if (!pool.length) pool = urls.map((_, i) => i)
    let lane = pool[0]
    for (const i of pool) {
      if ((laneInflight[i] ?? 0) < (laneInflight[lane] ?? 0)) lane = i
    }
    laneInflight[lane] = (laneInflight[lane] ?? 0) + 1
    return { lane, laneUrl: urls[lane], laneCount: urls.length }
  }

  const releaseLane = (lane: number) => {
    if ((laneInflight[lane] ?? 0) > 0) laneInflight[lane]--
  }

  // 必须排除熔断掉的 lane：否则直连 lane 已经每发必 403，并发上限还按两个 origin 放到 12，
  // 等于让 6 条连接去挤同一个 origin，浏览器排队反而更慢。
  const getLaneCount = (sampleUrl?: string): number =>
    sampleUrl ? Math.max(1, getLaneUrls(sampleUrl).filter((_, i) => laneAlive(i)).length) : 1

  return { laneDead, acquireLane, releaseLane, markLaneOk, markLaneFail, resetLanes, reviveLanes, getLaneCount }
}
