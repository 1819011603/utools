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
  /** 当前流的**可用** lane 数（排除熔断的），用于放宽并发上限 */
  getLaneCount: (sampleUrl?: string) => number
}

export function useLaneControl(getLaneUrls: (url: string) => string[]): LaneControl {
  const laneInflight: number[] = []
  const laneFails: number[] = []    // 各 lane 的连续失败数（成功即清零）
  const laneOks: number[] = []      // 各 lane 的累计成功数
  const laneDead = ref<boolean[]>([])

  const laneAlive = (i: number) => !laneDead.value[i]

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
    laneDead.value = next
    console.warn(`[lane] 第 ${lane} 条通道连续失败 ${laneFails[lane]} 次，已熔断（双通道降为单通道）`)
  }

  const resetLanes = () => {
    laneFails.length = 0
    laneOks.length = 0
    laneInflight.length = 0
    laneDead.value = []
  }

  const acquireLane = (url: string): LaneAllocation => {
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

  return { laneDead, acquireLane, releaseLane, markLaneOk, markLaneFail, resetLanes, getLaneCount }
}
