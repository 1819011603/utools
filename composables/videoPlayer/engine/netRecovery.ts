/**
 * 网络变化的恢复动作：断网恢复 / 换 Wi-Fi / 切蜂窝 / 回前台。
 *
 * 从 `useVideoEngine` 拆出来：这套「补枪」状态机跟 hls.js 生命周期无关，
 * 只依赖几个 getter 与两个外部动作（作废网络相关结论、重开预取）。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type HlsType from 'hls.js'
import type { Ref } from 'vue'
import { isRecovering } from './netWatch'

export interface NetRecoveryDeps {
  getVideoEl: () => HTMLVideoElement | undefined
  getHls: () => HlsType | null
  getAheadBuffered: (v: HTMLVideoElement) => number
  errorMessage: Ref<string>
  /**
   * 网络变了要作废的那些结论：lane 熔断记录 + 可达性结论 + 「直连是黑洞」缓存。
   * 它们都是**上一个网络**测出来的，换网之后不但过期，还会把本可直连的源按在代理上。
   */
  invalidateNetworkState: () => void
  /** 重开预取：预取失败不重排队，只靠心跳补——这里立刻满上，不等下一拍 */
  primePrefetch: () => void
}

/**
 * ── 网络变了（断网恢复 / 换 Wi-Fi / 切蜂窝 / 回前台发现换过网，见 engine/netWatch）──
 *
 * 这一刻要做四件事，少一件就是「网络明明好了，画面还一直转圈」：
 *   ① **lane 熔断记录整份作废**：出口 IP 一变，之前那些 403/超时的结论一条都不再成立
 *      （熔断本身还有 30s 观察期自愈，但这里能立刻恢复双通道，不用干等）；
 *   ② **可达性结论也一起作废**：`warmProbes` 和「直连是黑洞」都是**上一个网络**测出来的，
 *      换网之后它们不但过期，还会把本可直连的源按在代理上（或反过来）。这两份都只影响
 *      「等多久 / 用哪条」，清掉最多是多探一轮，留着却可能整轮判错；
 *   ③ **让 hls.js 从播放头重新开始加载**：断网期间它多半已经报过 fatal NETWORK_ERROR
 *      停在那儿了，`startLoad()` 是唯一能把它叫起来的动作。**必须带位置**——
 *      不带的话它按断网前的 `nextLoadPosition` 挑片，那个位置早就不是播放头了；
 *   ④ **重开预取**：预取失败不重排队，只靠心跳补——`primePrefetch()` 立刻满上，不等下一拍。
 *
 * 只在真的没在播时才 `startLoad()`：正常播着的流被 startLoad 打断会白丢一次缓冲
 * （回前台那条信号尤其要靠这个判断兜住，切走 30s 回来时缓冲往往是满的）。
 *
 * **一枪打不中就补枪**（`recoverShots`）：刚重连那一两秒请求常常还发不出去，
 * 老代码在这里只 `startLoad()` 一次，打空之后就再没人管，最终仍旧落回
 * 「重新取址 → 重探通道 → 销毁」那条慢路径。所以在恢复窗口里由心跳复查。
 *
 * 但**补枪必须以「一点进展都没有」为条件**：`startLoad(pos)` 会把在途的分片请求全丢掉重排，
 * 慢源上每秒补一枪等于永远下不完第一片——那是把「恢复慢」换成「恢复不了」。
 * 所以三道闩：至少隔 `RECOVER_SHOT_GAP_MS`、缓冲和播放头都没动过、总共不超过 4 枪。
 */
export function useNetRecovery(deps: NetRecoveryDeps) {
  const { getVideoEl, getHls, getAheadBuffered, errorMessage, invalidateNetworkState, primePrefetch } = deps

  let recoverShots = 0
  let lastShotAt = 0
  let lastShotAhead = -1
  let lastShotTime = -1
  /** 补枪次数上限：同一招重复十次无效就该换招（同 stallRecovery 的阶梯那条教训） */
  const MAX_RECOVER_SHOTS = 4
  /** 两枪之间至少隔这么久：给上一枪的请求留出真正跑完一片的时间 */
  const RECOVER_SHOT_GAP_MS = 2000
  const shootStartLoad = () => {
    const v = getVideoEl()
    const hls = getHls()
    if (!v || !hls) return
    // 已经播起来了 → 别打断（正常播着的流被 startLoad 打断会白丢一次缓冲）
    if (!v.paused && v.readyState >= 3 && getAheadBuffered(v) > 0.5) return
    recoverShots++
    lastShotAt = Date.now()
    lastShotAhead = getAheadBuffered(v)
    lastShotTime = v.currentTime
    try { hls.startLoad(v.currentTime) } catch {}
  }
  const onNetChanged = () => {
    invalidateNetworkState()
    if (errorMessage.value.startsWith('网络已断开')) errorMessage.value = ''
    recoverShots = 0
    shootStartLoad()
    primePrefetch()
  }
  /** 心跳里的补枪：恢复窗口内**毫无进展**才再叫一次，见上面 recoverShots 那段 */
  const recoverTick = () => {
    if (!isRecovering() || recoverShots >= MAX_RECOVER_SHOTS) return
    if (Date.now() - lastShotAt < RECOVER_SHOT_GAP_MS) return
    const v = getVideoEl()
    if (!v) return
    // 缓冲涨了、或播放头动了 = 上一枪正在见效，别打断它
    if (getAheadBuffered(v) > lastShotAhead + 0.05 || Math.abs(v.currentTime - lastShotTime) > 0.05) return
    shootStartLoad()
  }
  /** 断网时说一句话就够：重试逻辑那边一律等 netWatch，不在没网的时候烧额度（见 hlsErrors） */
  const onNetworkOffline = () => {
    if (!errorMessage.value) errorMessage.value = '网络已断开，恢复后会自动继续'
  }

  return { onNetChanged, recoverTick, onNetworkOffline }
}

export type NetRecovery = ReturnType<typeof useNetRecovery>
