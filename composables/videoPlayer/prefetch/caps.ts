/**
 * 并发策略的「界」：九级模型里除基值（`desiredConn`）与沉降/爬升之外的各级帽子和地板。
 *
 * 从 `strategy.ts` 拆出来（那边超了 500 行）：这些函数全是「读实测 + 读档位 → 给一个上限/下限」，
 * 唯一的持久状态是存货阶梯的迟滞档位 `wallStep`。调度顺序（谁先 min、地板何时 max、沉降期）
 * 仍在 `strategy.ts` 的 `getAdaptivePrefetchCount` 一处，这里不关心先后。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type { TierParams } from '../../videoSiteRules'
import type { BandwidthModel } from './bandwidth'
import type { PrefetchRuntime } from './strategy'
import {
  WALL_CONN_STEPS, WALL_STEP_HYST, FAST_SOLO_KBPS, FAST_SOLO_CONN_STEPS, DILUTION_RETAIN_STEPS, STALL_WINDOW_MS,
} from './tuning'

export interface ConcurrencyCapsDeps {
  bw: BandwidthModel
  runtime: PrefetchRuntime
  tier: () => TierParams
  getPlaybackRate: () => number
  getSafeWallSecs: () => number
  getColdStartConn: () => number
  getLastStallAt: () => number
}

export function useConcurrencyCaps(deps: ConcurrencyCapsDeps) {
  const { bw, runtime, tier, getPlaybackRate, getSafeWallSecs, getColdStartConn, getLastStallAt } = deps

  let wallStep = WALL_CONN_STEPS.length   // 存货阶梯当前所在档（= length 表示放开）：迟滞用
  /**
   * 地板的天花板：**任何地板都不能超过饱和并发**（见 bandwidth 的 saturationConn）。
   *
   * 地板说的是「要这么多条才喂得动」，可超过饱和点的那些连接**根本喂不动更多东西**，
   * 只是把同一份带宽切得更碎。地板是 min 链里唯一往上顶的一级，不封它就等于
   * 前面八级全部作废——实测日志里「1 线程 → 12 线程」的跳变就是这么来的：
   * 存货 0 + 3x + 刚卡过 → `requiredConn × 2` 顶到 hostCap，②~⑦ 一起被顶穿。
   */
  const saturationLimit = (): number => {
    const sat = bw.saturationConn()
    return sat > 0 ? Math.min(runtime.hostConcurrencyCap, sat) : runtime.hostConcurrencyCap
  }

  /**
   * 阶梯的**地板**：慢源上「少开线程」的前提不成立，这里兜住。
   *
   * 阶梯的立论是「带宽不是瓶颈，摊薄才是」——快源确实如此。但源站真慢时（每连接喂不动码率、
   * 靠并行才凑得出吞吐），2 条连接连维持播放都不够，**存货永远涨不到 2 倍保险线，阶梯就永远不放开**
   * ——自锁。表现最狠的是切集/拖进度：缓存归零，正好落在阶梯最低那一档。
   *
   * 所以地板取「维持当前倍速播放所需的连接数 × 2」：×1 只够不掉队、存货原地不动，
   * ×2 才是「一边播一边以约 1 秒/秒的速度攒存货」。快源上 requiredConn=1 → 地板 2，
   * 等于阶梯原样生效（防摊薄的目的不受影响）；慢源上 requiredConn=6 → 地板顶到 hostCap，等于拉满。
   *
   * **切集/换流会清空实测样本**（`resetStrategy`，换 CDN 用旧数据必跑偏），那一刻没有 requiredConn 可算，
   * 于是退回按 host 学到的 `bestConcurrency`（自愈环连续流畅 20s+ 时每 30s 写一份）——
   * 它本身就是当时的目标并发，不再翻倍。学过的慢站第二次进来即刻高并发，不用先卡一片。
   * 都没有（生面孔第一片）就交给阶梯：先按 2 条把第一片让过去，一有样本立刻按实测放开，代价是一片。
   */
  const catchUpFloor = (force = false): number => {
    if (!bw.hasSamples()) return Math.min(runtime.hostConcurrencyCap, Math.max(0, getColdStartConn()))
    const rate = getPlaybackRate()
    const safety = tier().safety
    // **聚合已经喂得动 → 地板一律不抬。** 地板的立论是「这个源真慢，少开线程连播放都维持不住」；
    // 聚合是码率的好几倍时那个前提根本不成立，此时抬地板只会把摊薄推得更狠。
    // 不加这道闸就是正反馈：线程多 → 单条被摊薄 → requiredConn 变大 → 地板变高 → 线程更多。
    // 实测截图（单条 369KB/s、被摊到 222KB/s、聚合 20.8Mbps vs 码率 5.2Mbps）就是它顶到 12 的。
    // `force=true`（「缓冲卡住」时用）跳过这道闸：卡住恰恰说明「聚合够喂」与「存货原地不涨」同时成立，
    // 闸的立论（够喂 = 不需要更多）不成立——这时才需要地板把线程顶上去攒存货。
    if (!force && bw.aggregateFeeds(rate, safety)) return 0
    // 分母用**单条基线**（solo=true），不用被摊薄的混合均值——同一个正反馈的另一半
    return Math.min(saturationLimit(), Math.max(0, bw.requiredConn(rate, safety, true) * 2))
  }

  /**
   * 「单条连接够喂当前倍速吗」：够 = 加线程没意义，反而摊薄。
   *
   * 门槛按倍速放大（同 FAST_SOLO_CONN_STEPS 那条立论）：3x 播放要三倍吞吐才算「够」。
   * `solo === 0`（还没测到低并发样本，如冷启动第一集）一律算「不够」——没数据就不敢省。
   */
  const soloFeedsRate = (): boolean => {
    const solo = bw.soloConnKBps()
    return solo > 0 && solo >= FAST_SOLO_KBPS * Math.max(1, getPlaybackRate())
  }

  /**
   * 存货阶梯（表见 WALL_CONN_STEPS）：wall = 还够播几秒。保险线填 0/负数 = 关掉整条阶梯。
   *
   * 带**放开方向的迟滞**（见 WALL_STEP_HYST）：降档立刻生效，升档要多攒 25%。
   * 下标越大 = 存货越多 = 上限越高；`WALL_CONN_STEPS.length` 表示彻底放开。
   */
  const wallConnCap = (wall: number, safe: number, stuck = false): number => {
    if (safe <= 0) { wallStep = WALL_CONN_STEPS.length; return runtime.hostConcurrencyCap }
    let step = WALL_CONN_STEPS.length
    for (let i = 0; i < WALL_CONN_STEPS.length; i++) {
      if (wall < safe * WALL_CONN_STEPS[i]![0]) { step = i; break }
    }
    // 想往上放开（step > wallStep）时，得越过「当前所在档那条线 × (1 + 迟滞)」才算数
    if (step > wallStep && wallStep < WALL_CONN_STEPS.length) {
      if (wall < safe * WALL_CONN_STEPS[wallStep]![0] * (1 + WALL_STEP_HYST)) step = wallStep
    }
    wallStep = step
    if (step >= WALL_CONN_STEPS.length) return runtime.hostConcurrencyCap
    /*
     * **饿区（step 0，存货不足保险线的 40%）且单条够快 → 只留 1 条预取。**
     *
     * `soloFastCap` 那条「单条够快就别加线程」怕跟存货阶梯抢方向盘，在放开线以下整条关掉
     * （见它自己那段），可「刚起播 / 刚拖完进度 / 刚切集」正好落在这一档——于是快源上也固定
     * 开 2 条预取，跟 hls.js 正在等的那一片抢同源连接槽和带宽（实测：拖完进度有时加载很慢、
     * 单线程反而快）。这里只补这一格：够快就 1 条，把槽让给眼前那一片。
     *
     * 单条慢或还没测到（`solo === 0`）→ 维持原来的 2；真慢源仍由 `catchUpFloor` 顶上去。
     */
    if (step === 0 && soloFeedsRate()) return 1
    // **缓冲卡住**（见 BUFFER_STUCK_MS）：往上放开一档（已是最高档就放开到 hostCap）+ 让地板跳过
    // 「聚合喂得动就不抬」那道闸生效，打破「少开线程换不来存货」的自锁。正常在涨的流 stuck=false。
    if (stuck) {
      const nextCap = step + 1 < WALL_CONN_STEPS.length ? WALL_CONN_STEPS[step + 1]![1] : runtime.hostConcurrencyCap
      return Math.max(nextCap, catchUpFloor(true))
    }
    return Math.max(WALL_CONN_STEPS[step]![1], catchUpFloor())   // 地板兜住慢源，见 catchUpFloor
  }

  /**
   * 卡顿守卫：**卡顿是地面真值，比任何估算都可信**，所以它排在缺口/聚合那些「省流量」的判据前面。
   *
   * 但「卡了该加线程还是该减线程」没有唯一答案，取决于卡在哪：
   *   · **聚合速度已经够喂**（≥ 码率 × 倍速 × 安全系数）却还在卡 → 是**摊薄**：
   *     带宽不是瓶颈，是那 N 条连接把槽位和带宽摊给了远处的分片，紧邻播放头那一片反而最晚到。
   *     这时要**减到 2~3 条**，把资源让给眼前那一片。（实测截图：聚合 16.8Mbps、码率 2.1Mbps，
   *     跑着 6 线程却卡到已缓冲 0.3s。）
   *   · **聚合速度喂不动** → 是**真慢**：少开线程只会更慢，这时反过来把地板抬到 hostCap，
   *     能开多少开多少（慢源、拖进度后最常见）。
   * 判据用聚合而不是单连接速度：单连接慢但能并行的源（每连接限速的 CDN）恰恰要多开。
   * 单连接速度的位置在 requiredConn 里——它决定「喂饱需要几条」，是上面那个比较的分母。
   *
   * 返回 `{ cap, floor }`：不卡时两边都不咬人（cap=hostCap、floor=0）。
   */
  const stallGuard = (): { cap: number; floor: number } => {
    const stalledAt = getLastStallAt()
    // **必须用 performance.now()**：`useStallTracker` 的 lastStallAt 记的就是它。
    // 这里曾写 Date.now()，两个基准差三个数量级（1.7e12 vs 1e5）→ 差值恒 > 20s
    // → **整个卡顿守卫从来没生效过**（表现：卡了三次、聚合是码率的 4 倍，线程仍钉在 12）
    const recentlyStalled = stalledAt > 0 && performance.now() - stalledAt < STALL_WINDOW_MS
    if (!recentlyStalled || !bw.hasSamples()) return { cap: runtime.hostConcurrencyCap, floor: 0 }
    /*
     * **没有聚合读数就一个字都不许说。**
     *
     * 「摊薄型 vs 真慢型」全靠拿实测聚合跟需要的吞吐比；`peakAggBps() === 0` 时那个比较
     * 恒为 false，于是一律落进「真慢型 → 地板抬到 hostCap」——把前面所有帽子顶穿。
     *
     * 这个组合在**切集后的头几拍必然出现**（实测日志「1 → 12 线程 ∵ ⑧地板↑12」就是它）：
     * `resetStrategy` 清了带宽样本但**卡顿时间戳是跨集的**，上一集 20s 内卡过就仍算「近期在卡」；
     * 而 `hasSamples()` 只要有一片就为真（它看 perConnBps），聚合分档账本却还空着
     * ——尤其在途并发数被记成 0 的那几片压根不进分档账本。
     * 分不清病因时的正确动作是不动手，交给存货阶梯。
     */
    if (bw.peakAggBps() <= 0) return { cap: runtime.hostConcurrencyCap, floor: 0 }
    // 拿**实测峰值聚合**跟「码率 × 倍速 × 安全系数」比（见 aggregateFeeds）。
    // 原来写的是 `requiredConn <= lastTargetConn`，两头都会被摊薄带着走：
    // 线程越多 → 每连接越慢 → requiredConn 越大，于是越摊薄越容易判成「真慢型」→ 地板抬到 hostCap → 更摊薄。
    const bandwidthEnough = bw.aggregateFeeds(getPlaybackRate(), tier().safety)
    // **单条速度优先于聚合**：单条已经被摊薄掉三成以上时，「聚合喂不动」只是摊薄的结果而不是原因，
    // 这时候按「真慢型」把地板抬到 hostCap 等于往火上浇油——照单条这个信号一律判摊薄型。
    const retain = bw.soloRetainRatio()
    const diluted = retain > 0 && retain < DILUTION_RETAIN_STEPS[1]![0]
    return bandwidthEnough || diluted
      ? { cap: 3, floor: 0 }                       // 摊薄型：收紧，让眼前那一片先到
      // 真慢型：能开多少开多少——但同样封在饱和并发，再多开也换不来吞吐
      : { cap: runtime.hostConcurrencyCap, floor: saturationLimit() }
  }

  /**
   * 聚合拐点帽：**加线程却没换来吞吐，就别再加**（每 IP 限总量的源）。
   *
   * 数据来自 bandwidth 的 `aggByConn`（按并发档记聚合成绩）。拿到拐点后封在 `bestConn + 1`：
   * 留一档继续试探，网络变好时还能爬回去；锁死在最优档的话，一次偶发抖动就把上限永久压住了。
   */
  const aggregateKneeCap = (): number => {
    const knee = bw.bestAggConn()
    return knee > 0 ? Math.min(runtime.hostConcurrencyCap, knee + 1) : runtime.hostConcurrencyCap
  }

  /**
   * 摊薄帽：**加线程只在「单条速度没被摊薄多少」时才允许**。两个判据，取紧的那个：
   *
   *   ① `saturationConn()`（稳态）：峰值聚合 ÷ 单条基线 = 再多开就只是分摊的那个档。
   *   ② `soloRetainRatio()`（快信号，见 DILUTION_RETAIN_STEPS）：单条掉了多少。
   *
   * **为什么必须要 ①**：光有 ② 会形成死循环——收了线程，单条速度就回升，保有率跟着回到 1，
   * 帽子自己解除 → 又加到满 → 又摊薄 → 又收。② 的输入随线程数一起漂移，只能当快信号。
   * ① 的两个输入（峰值聚合、低并发档基线）都不随当前线程数变，所以结论是稳的。
   *
   * 与聚合拐点帽（`aggregateKneeCap`）的分工：那条要等「某个高档确实明显更差」才认拐点，
   * 各档持平时一律放过；这条从「总量除以单条」直接算出饱和点，不需要拐点浮现。
   *
   * 仍然不低于 `catchUpFloor()`（真慢源上它会顶回来），但注意地板现在自带
   * 「聚合喂得动就不抬」那道闸——否则这条帽子会被自己制造的摊薄顶穿。
   */
  const dilutionCap = (): number => {
    let cap = runtime.hostConcurrencyCap
    // ① 稳态判据：饱和并发（峰值聚合 ÷ 单条基线）。两个输入都不随当前线程数漂移，
    //    所以它不会「收完线程就自己解除」——那正是保有率单独用会来回振的原因。
    const sat = bw.saturationConn()
    if (sat > 0) cap = Math.min(cap, sat)
    // ② 快信号：保有率。加线程当场就掉，比 ① 攒够各档样本快，用来在爬坡途中先刹住。
    const retain = bw.soloRetainRatio()
    if (retain > 0) {
      for (const [floor, c] of DILUTION_RETAIN_STEPS) {
        if (retain < floor) { cap = Math.min(cap, c); break }
      }
    }
    return cap >= runtime.hostConcurrencyCap ? runtime.hostConcurrencyCap : Math.max(cap, catchUpFloor())
  }

  /**
   * 单连接够快帽：**一条连接自己就能跑到 `FAST_SOLO_KBPS`，就别加线程**（见该常量的立论）。
   *
   * 与聚合拐点帽（`aggregateKneeCap`）的分工：那条要等「高档确实明显更差」才咬人，
   * 于是「多开白开」（各档聚合基本持平）这种最常见的情况它一律放过。这条从**单连接速度**
   * 这一侧下判断，快源上不必等拐点浮现就先省下来。
   *
   * 省到几条由 `FAST_SOLO_CONN_STEPS` 决定（越快越少，门槛按倍速放大）。三道让路，
   * 都是为了「线程不能太少」：
   *   · **存货没过阶梯放开线就整条不参与**。省线程是「有余量才做的事」：起播、切集、拖进度
   *     那一刻手上够播几秒是唯一要紧的事，这时候还按「单条够快」去收，等于跟 ② 抢方向盘。
   *     判据用墙钟「还够播几秒」而不是视频秒，跟 ② / `desiredConn` 同一把尺子。
   *   · 没测到低并发样本（`solo === 0`）→ 不咬人，交给存货阶梯和冷启动帽；
   *   · 帽子**不低于 `catchUpFloor()`**。它是 min 链的一环，压穿地板会重演慢源自锁
   *     （2 条连维持播放都不够 → 存货永远涨不到阶梯放开线 → 永远不放开）。高倍速下
   *     requiredConn 会把地板顶上去，正好是「单条虽快但喂不动 3x」该多开的那种情形。
   */
  const soloFastCap = (wall: number): number => {
    // 阶梯放开线（保险线 ×2）以下一律不咬人——跟 wallConnCap 放开的那一档对齐
    if (wall < Math.max(0, getSafeWallSecs()) * 2) return runtime.hostConcurrencyCap
    const solo = bw.soloConnKBps()
    const rate = Math.max(1, getPlaybackRate())
    for (const [kbps, cap] of FAST_SOLO_CONN_STEPS) {
      if (solo >= kbps * rate) return Math.max(cap, catchUpFloor())
    }
    return runtime.hostConcurrencyCap   // 单条慢（含 solo=0 还没测到）：不咬人，该多开就多开
  }

  /** 换视频/CDN 时重置（只有阶梯迟滞档位一份状态） */
  const reset = () => { wallStep = WALL_CONN_STEPS.length }

  return { catchUpFloor, wallConnCap, stallGuard, dilutionCap, soloFastCap, aggregateKneeCap, reset }
}

export type ConcurrencyCaps = ReturnType<typeof useConcurrencyCaps>
