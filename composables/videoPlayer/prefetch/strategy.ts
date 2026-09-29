/**
 * 并发策略：把「这一拍该开几条预取线程」算出来（`getAdaptivePrefetchCount` 的九级模型），
 * 以及对外展示用的策略快照（`strategy`）。
 *
 * 从 `useHlsPrefetch` 拆出来：它只读实测（`BandwidthModel`）与档位参数，不碰网络、不碰缓存，
 * 与「预取哪一片」的调度完全解耦。两者共享的可变状态（hostConcurrencyCap / segDurSecs）
 * 收在一个 `runtime` 对象里，由装配层创建后同时交给策略与调度。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type { TierParams } from '../../videoSiteRules'
import type { BandwidthModel } from './bandwidth'
import {
  WALL_CONN_STEPS, WALL_STEP_HYST, FALLBACK_SEG_SECS,
  FILL_HORIZON_SECS, COAST_WALL_SECS, COAST_GAP_WALL_SECS, HEADROOM_RESUME_FRAC,
  COLD_START_CONN_CAP, FAST_SOLO_KBPS, FAST_SOLO_CONN_STEPS, DILUTION_RETAIN_STEPS,
  CONN_SETTLE_MIN_MS, CONN_SETTLE_MAX_MS, CONN_RAMP_MS_SLOW, CONN_RAMP_MS_FAST, STALL_WINDOW_MS,
} from './tuning'

export type HealthZone = 'panic' | 'low' | 'healthy'

export interface StrategySnapshot {
  perConnKBps: number     // 实测每连接速度（混了各并发档的采样）
  soloKBps: number        // 单条连接自己能跑多快（只取低并发档，0=没测到）：加不加线程的判据
  soloRetain: number      // 单条速度保有率（当前每连接 ÷ 单条基线），<0.7 = 被摊薄，停止加线程
  satConn: number         // 饱和并发（峰值聚合 ÷ 单条基线）：再多开只是分摊。0=数据不够
  segMbps: number         // 实测视频码率
  targetConn: number      // 当前目标并发
  maxFluentRate: number   // 当前带宽最高可流畅倍速
  aggregateScales: boolean // 聚合是否随线程增长（true=每连接限速可并行；false=每IP硬顶不可并行）
  healthZone: HealthZone  // 缓冲健康区（按「有效可播」分档，panic 触发抗卡降速）
  playableSecs: number    // 有效可播秒数（MSE + 预取缓存），倍速决策的经验依据
  avgSegLoadMs: number    // 一片平均下载耗时（ms）：判「每连接够不够快」比看瞬时速度直观
  aggKneeConn: number     // 实测到的聚合拐点并发（0=还没见到拐点）
}

/** 策略与调度共享的少量可变状态（装配层创建，两边读写同一份）。 */
export interface PrefetchRuntime {
  /** 并发上限：默认单 host 6；多 CDN / 双通道时放宽（见 triggerAdaptivePrefetch） */
  hostConcurrencyCap: number
  /** 实测分片时长（秒，0=还没量到）：一条线程下一片就补这么多缓存 */
  segDurSecs: number
}

export interface ConcurrencyStrategyDeps {
  bw: BandwidthModel
  runtime: PrefetchRuntime
  /** 当前服务器档位参数（好/中/差预设 + 页面覆盖） */
  tier: () => TierParams
  getPlaybackRate: () => number
  /** 预取深度上限（秒）：真实前向缓冲达到此值即停止预取，默认 Infinity（不限） */
  getPrefetchTargetSecs: () => number
  /** 「存货保险线」（秒，墙钟）：缓存够播的秒数低于它就按阶梯收敛并发 */
  getSafeWallSecs: () => number
  /** 冷启动并发先验：按 host 学到的 bestConcurrency（0/不设 = 没学过） */
  getColdStartConn: () => number
  /** 上一次真实卡顿的时间戳（`performance.now()`，0=没卡过） */
  getLastStallAt: () => number
}

export function useConcurrencyStrategy(deps: ConcurrencyStrategyDeps) {
  const { bw, runtime, tier, getPlaybackRate, getPrefetchTargetSecs, getSafeWallSecs, getColdStartConn, getLastStallAt } = deps

  /**
   * 有效预取深度（**视频秒**）。
   *
   * 用户填的「预加载时长」是**够播几秒**（墙钟），不是「缓存几秒视频」——两者差一个倍速：
   * 3x 下缓存 90 秒视频才等于「够播 30 秒」。而这里所有比较对象（`cachedAhead`、
   * `desiredConn` 的缺口）都是**视频秒**，所以在这一处、且只在这一处乘回去。
   *
   * 跟「存货保险线」用的是同一把尺子（见下面 `cachedAhead / Math.max(1, rate)`）：
   * 两个输入框都以「够播几秒」计量，用户不用在脑子里做倍速换算——
   * 而在此之前，同一个 600 在 1x 和 3x 下代表的实际余量差三倍，光看数字完全看不出来。
   *
   * 档位不收窄它——否则快源缓存一到档位深度就停、预取线程掉 0。想省内存请调小这个值。
   */
  const effectivePrefetchTarget = (): number => {
    const wall = getPrefetchTargetSecs()
    if (!Number.isFinite(wall)) return Infinity   // 0/负数视为不限，别被倍速乘成 NaN
    return wall * Math.max(1, getPlaybackRate())
  }

  // 初值与 reset() 里那份保持一致（漏字段 tsc 会直接报，别只补一处）
  const strategy = ref<StrategySnapshot>({
    perConnKBps: 0, soloKBps: 0, soloRetain: 0, satConn: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0,
    aggregateScales: true, healthZone: 'healthy', playableSecs: 0,
    avgSegLoadMs: 0, aggKneeConn: 0,
  })

  // 并发控制的持久状态。**没有「受控并发」这个积分器了**：目标值每拍由 desiredConn 的
  // 吞吐模型现算（见 getAdaptivePrefetchCount），这里只留爬坡/沉降/迟滞需要的几个时间戳与档位。
  let lastTargetConn = 0                  // 上一拍算出的目标并发（卡顿守卫拿它判「带宽够不够」）
  let connDownAt = 0                      // 上次**下调**并发的时刻：沉降期内只许再降不许升
  let connUpAt = 0                        // 上次**上调**并发的时刻：爬升按 CONN_RAMP_MS_SLOW/FAST 一档一档来
  let wallStep = WALL_CONN_STEPS.length   // 存货阶梯当前所在档（= length 表示放开）：迟滞用
  let headroomIdle = false                // 缺口已到目标、停取中：恢复要等缺口张开到 5%（迟滞）
  let lastHealthZone: HealthZone = 'healthy'  // 健康区（驱动 UI 与降速守卫）
  let lastPlayable = 0                    // 上次量到的有效可播秒数（MSE + 预取缓存）

  // 刷新对外策略快照（供 UI 展示与倍速可行性判断）
  const refreshStrategy = (targetConn: number) => {
    const sustainable = bw.maxFluentRate(runtime.hostConcurrencyCap, tier().safety, getPlaybackRate())
    strategy.value = {
      perConnKBps: bw.perConnKBps(),
      soloKBps: bw.soloConnKBps(),
      soloRetain: Math.round(bw.soloRetainRatio() * 100) / 100,
      satConn: bw.saturationConn(),
      segMbps: bw.segMbps(),
      targetConn,
      maxFluentRate: sustainable,
      aggregateScales: bw.getAggregateScales(),
      healthZone: lastHealthZone,
      playableSecs: Math.round(lastPlayable),
      avgSegLoadMs: bw.avgSegLoadMs(),
      aggKneeConn: bw.bestAggConn(),
    }
  }

  /**
   * 健康区（濒卡/吃紧/健康）：**只驱动抗卡动作**（降速守卫、双通道自动开、预热放行、面板徽标），
   * **不参与并发**——并发的值统一由 desiredConn 的吞吐模型给（见 getAdaptivePrefetchCount）。
   *
   * 按「有效可播」（cachedAhead = MSE + 预取缓存）分档，**不是 MSE 前向**：预取缓存里的分片由
   * fLoader 同步返回、hls.js 拿到即 append，不需要任何网络等待；而 MSE 前向本身有天花板
   * （maxBufferLength / 浏览器 MSE 配额），深缓存时会长期停在几十秒的平台上——那是正常稳态，
   * 不是吃紧。按它分档的后果踩过：有效可播 651s、真实卡顿 0 次仍判「吃紧」，降速守卫永远等不到
   * healthy，「自动最佳倍速」被死锁在 1x。真正只看 MSE 的是跳片，它自己量（见 skipSegment）。
   */
  const updateHealthZone = (mseAhead: number, cachedAhead: number) => {
    const t = tier()
    // mseAhead 参与取大只为兜底：无分片列表时 getCachedAhead 会退化成 MSE 读数
    const playable = Math.max(mseAhead, cachedAhead)
    lastPlayable = playable
    lastHealthZone = playable < t.panicSecs ? 'panic' : (playable < t.lowSecs ? 'low' : 'healthy')
  }

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
  const catchUpFloor = (): number => {
    if (!bw.hasSamples()) return Math.min(runtime.hostConcurrencyCap, Math.max(0, getColdStartConn()))
    const rate = getPlaybackRate()
    const safety = tier().safety
    // **聚合已经喂得动 → 地板一律不抬。** 地板的立论是「这个源真慢，少开线程连播放都维持不住」；
    // 聚合是码率的好几倍时那个前提根本不成立，此时抬地板只会把摊薄推得更狠。
    // 不加这道闸就是正反馈：线程多 → 单条被摊薄 → requiredConn 变大 → 地板变高 → 线程更多。
    // 实测截图（单条 369KB/s、被摊到 222KB/s、聚合 20.8Mbps vs 码率 5.2Mbps）就是它顶到 12 的。
    if (bw.aggregateFeeds(rate, safety)) return 0
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
  const wallConnCap = (wall: number, safe: number): number => {
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
    return Math.max(WALL_CONN_STEPS[step]![1], catchUpFloor())   // 地板兜住慢源，见 catchUpFloor
  }

  /**
   * 「还差多少就到预加载时长」换算出的并发上限。判据是**速率**，不是「缺口装得下几片」：
   *
   *     需要的吞吐 = 播放消耗（倍速）+ 缺口 ÷ 补齐期限
   *     线程数     = 需要的吞吐 × 码率 × 安全系数 ÷ 每连接实测速度    ← 就是 bw.requiredConn
   *
   * 按「缺口 ÷ 分片时长」算（本函数第一版）等于要求**下一拍就把缺口填满**，于是缺口一大就必然顶格；
   * 可缓存的意义本来就是「慢慢补上去也行」——只要补的速度快过播放消耗，缺口就在收窄。
   * 摊到 FILL_HORIZON_SECS 秒里补，线程数才跟「实际还差多少速度」挂钩，而不是跟「还差多少存量」。
   *
   * 它顺带自动含住了「一片要下多久」：每连接慢（一片要下好几秒）时 requiredConn 本来就大，
   * 快时就小，不必再单独量下载耗时。
   *
   * 两条性质：
   *  · **绝不会低于维持播放所需**（公式里播放消耗那项是全额的），所以这条上限压不出卡顿；
   *    缺口→0 时它正好收敛到「刚够跟上播放」的线程数（快源 1 条，慢源该几条给几条）。
   *  · 于是缓存稳稳停在预加载时长附近：不冲过头（多下的迟早被停取判定或 LRU 淘汰），
   *    缺口一张开线程也立刻跟着张开。**没有「充足」阈值可调**，目标就是用户填的预加载时长。
   *
   * 全程用「视频秒 / 墙钟秒」这个无量纲比值（倍速、缺口÷期限都是它），跟抗卡那两档
   * （墙钟「够播几秒」）各用各的尺子——两者管的是相反方向。
   *
   * 它是 `getAdaptivePrefetchCount` 的**基值**（「值」），其余各级是对它的钳制（「界」）。
   * 曾是 min 链里的第 ⑦ 级「帽子」；提成基值后，原来那句「必须排在暂停→顶格之后」的顾虑不再成立
   * （暂停不再单独顶格，见 getAdaptivePrefetchCount）。
   */
  const desiredConn = (cachedAhead: number): number => {
    const target = effectivePrefetchTarget()
    // 不限预加载：用户明确要「缓存到顶」，这里返回 hostCap（沿用旧行为）。爬升速度另由 ⑨ 控制，
    // 所以「要满」但「慢慢满」，不会一上来就摊薄眼前那一片。
    if (!Number.isFinite(target)) return runtime.hostConcurrencyCap
    /*
     * 「已到目标」用**两条线**：停取看「缺口不足一片」，恢复要等缺口重新张开到目标的 5%
     * （见 HEADROOM_RESUME_FRAC）。单条线——无论是 `gap <= 0` 还是 `gap <= 一片`——
     * 都会在贴着目标时每拍翻转，因为缓冲本身就在一片的幅度上浮动。
     */
    const gap = target - cachedAhead
    const seg = runtime.segDurSecs || FALLBACK_SEG_SECS
    const stop = headroomIdle
      ? gap < Math.max(2 * seg, target * HEADROOM_RESUME_FRAC)   // 已停取：等缺口张开够大才复工
      : gap <= seg                                              // 在取：缺口不足一片就收工
    if (stop) { headroomIdle = true; return 0 }                  // 已到目标（上层还会再判一次停取）
    headroomIdle = false
    // 还没测出速度：**冷启动帽 与「缺口装得下几片」取小**（旧行为 = base(冷启动估算) 与 ⑦(ceil(gap/seg))
    // 取 min）。只用冷启动帽会在小缺口时多开（评审核到 3 vs 2）。
    if (!bw.hasSamples()) {
      const cold = Math.min(runtime.hostConcurrencyCap, COLD_START_CONN_CAP, Math.max(2, getColdStartConn()))
      return Math.min(cold, Math.max(1, Math.ceil(gap / seg)))
    }

    /*
     * 手上存货厚的时候，「播放消耗」那一项可以**打折**——余量本来就是拿来花的。
     *
     * 由来（实测）：预加载时长 100s、已经缓存 98s，线程却顶到 12。缺口只有 2s，
     * 摊到 60s 里补，那一项贡献 2/60 ≈ 0.03，**12 条全是「维持 3x 播放」算出来的**：
     * 慢源上每连接扛不动 3 倍码率，要不掉队就得这么多条。算式没错，但那一刻它答错了问题——
     * 已经攒下 98s÷3x ≈ 33 秒墙钟的余量，根本没必要为了把数字钉在 100 而拉满连接；
     * 少供一点、让缓存慢慢往下滑才是对的，滑到接近保险线时再全额补。
     *
     * 折扣按**墙钟余量**给（不是按视频秒——3x 下 98 视频秒只值 33 秒墙钟）：
     * 从「存货阶梯放开线」（保险线 ×2）起算，再多出 COAST_WALL_SECS 就给到满折。
     * 封顶 0.9 而不是 1：始终留一点供给，免得存货厚时干脆一条不开、跌下来又猛开的锯齿。
     * 余量掉回放开线以下时折扣归零 → 回到全额供给，所以这条仍然压不出卡顿。
     *
     * **但光看「存货厚不厚」会把平衡点永久钉在目标值下方**（`COAST_GAP_WALL_SECS` 那段注释里的
     * 300→240）：所以再乘一道「缺口快没了」的淡入系数，缺口还有 10 秒墙钟以上时折扣为 0，
     * 缓存于是一路缓慢往上爬，直到贴着目标值才开始躺着花。
     */
    const rate = getPlaybackRate()
    const wall = cachedAhead / Math.max(1, rate)          // 还够播几秒（墙钟）
    const releaseWall = Math.max(0, getSafeWallSecs()) * 2 // 存货阶梯的放开线，低于它一律全额供
    const thick = Math.min(0.9, Math.max(0, (wall - releaseWall) / COAST_WALL_SECS))
    const gapWall = gap / Math.max(1, rate)                          // 缺口还够播几秒（墙钟）
    const nearTarget = Math.max(0, 1 - gapWall / COAST_GAP_WALL_SECS) // 缺口 ≥10s 墙钟 → 不打折
    const credit = thick * nearTarget
    const needRate = rate * (1 - credit) + gap / FILL_HORIZON_SECS
    return Math.max(1, bw.requiredConn(needRate, tier().safety))
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

  // 当前目标并发（只读，供两个预取入口共用）。
  // 永远保持并行预取后续分片，绝不因当前分片慢而停掉后面的（否则退化成串行/卡死）。
  const getAdaptivePrefetchCount = (cachedAhead?: number): number => {
    /*
     * ── 目标 = 「值」夹在「界」之间 ──
     * 值：`desiredConn` —— 唯一一处「要多少吞吐」的模型：
     *     需要吞吐 = 播放消耗（倍速）+ 缺口 ÷ 补齐期限 → 再除每连接实测速度。缺口→0 时正好收敛到
     *     「刚够跟上播放」（快源 1 条、慢源该几条给几条）；到目标时返回 0（停取，带迟滞）。
     *     **暂停不再单独顶格**：旧代码的 `paused ? hostCap` 只是基值，随后照样被 ⑦ 压回来，删掉等价。
     * 界（一律 min，除 ⑧ 地板是 max）——越靠前越「救命」，越靠后越只是「省」：
     *   ① 冷启动帽    没有任何实测 → ≤3，无论双通道（拿第一片去赌是最亏的）
     *   ② 存货墙钟    还够播几秒 → 2/3/4/6（「现在能不能播下去」压倒一切；饿区快源只留 1 条）
     *   ③ 卡顿守卫    真卡过 → 摊薄型收紧到 3 / 真慢型抬地板到 hostCap
     *   ④ 摊薄帽      单条速度掉了三成/一半 → 封在 3/2（比 ⑤ 快，见 dilutionCap）
     *   ⑤ 单连接够快  存货过放开线 + 单条跑到 500KB/s×倍速 → 封在 2~3（见 soloFastCap）
     *   ⑥ 聚合拐点    加线程不涨吞吐 → 封在拐点 +1
     *   ⑧ 地板        慢源兜底：catchUpFloor / 卡顿守卫的 floor（防「越缺越不敢开」自锁）
     *   ⑨ 沉降/爬升   刚减过 → 只许再降不许升（CONN_SETTLE_*）；升一档一档来（慢档 CONN_RAMP_MS_SLOW / 急档 CONN_RAMP_MS_FAST）
     *                 ——**地板顶格也要走这条路**，否则 3 → 12 一步到位
     *
     * （原来这里是「闭环积分器 ctrlConn + ⑦ 缺口速率帽」两套在算同一件事——积分器稳态会被棘轮
     *   顶到 hostCap、真正拍板的是这些帽子。已把 ⑦ 提成基值 `desiredConn`、删掉积分器：
     *   模型现算、响应更快，也少了 `ctrlConn`/`lastAhead` 两处状态与 `computeTargetConcurrency`。）
     */
    let target = cachedAhead === undefined ? runtime.hostConcurrencyCap : desiredConn(cachedAhead)
    if (!bw.hasSamples()) target = Math.min(target, COLD_START_CONN_CAP)     // ①
    if (cachedAhead !== undefined) {
      const wall = cachedAhead / Math.max(1, getPlaybackRate())
      target = Math.min(target, wallConnCap(wall, getSafeWallSecs()))        // ②（内含 catchUpFloor 地板）
      const guard = stallGuard()                                            // ③
      target = Math.min(target, guard.cap)
      target = Math.min(target, dilutionCap())                              // ④
      target = Math.min(target, soloFastCap(wall))                          // ⑤
      target = Math.min(target, aggregateKneeCap())                         // ⑥
      // ⑧ 地板只在「真慢型卡顿」时抬——它要压过上面所有的收紧，否则慢源永远补不回来。
      //    冷启动帽不受它影响：那时没样本，stallGuard 直接返回不咬人的值
      target = Math.max(target, Math.min(runtime.hostConcurrencyCap, guard.floor))
    }
    /*
     * ⑨ 沉降期：刚减过线程就**只许再降不许升**。
     *
     * 减线程没法立即生效——在途的下载不会被回收，实际并发要等它们各自跑完才降下来。
     * 那一两拍里速度读数仍是高并发时的低值（单条保有率、每连接速度全是），照它决策就会
     * 立刻把线程加回去 → 又摊薄 → 再减，谁也不让谁。所以只在「升」这个方向上等一等；
     * 「降」始终放行（存货阶梯濒卡那一档必须随时生效），而各条帽子都是绝对值算式、
     * 不是累加，连续降也不会踩过头。
     *
     * 同一处顺便通知带宽模型「并发变了」：跨越变更点的那些采样不能进分档账本，
     * 否则低并发档会被高并发时的低速度污染（见 bandwidth 的 markConcChange）。
     */
    const now = performance.now()
    const settleMs = Math.min(CONN_SETTLE_MAX_MS, Math.max(CONN_SETTLE_MIN_MS, bw.avgSegLoadMs()))
    if (lastTargetConn > 0 && target > lastTargetConn) {
      // 爬升间隔：**默认慢档**（线程涨太快会把紧邻播放头那一片摊薄——用户反馈）；但
      // 「存货吃紧/濒卡」或「源站真慢（地板被顶起来，`catchUpFloor`>0）」是真需要更多连接的
      // 场合，回快档——那里慢爬会把恢复拖很久。
      const urgent = lastHealthZone !== 'healthy' || catchUpFloor() > 0
      const rampMs = urgent ? CONN_RAMP_MS_FAST : CONN_RAMP_MS_SLOW
      if (now - connDownAt < settleMs) target = lastTargetConn              // 刚减过：等在途排空，读数还不可信
      else if (now - connUpAt < rampMs) target = lastTargetConn             // 上一档还没站稳，这一拍不动
      else target = Math.min(target, lastTargetConn + 1)                    // 一档一档来（地板顶格也走这条路）
    }
    if (target !== lastTargetConn) {
      if (lastTargetConn > 0 && target < lastTargetConn) connDownAt = now
      if (target > lastTargetConn) connUpAt = now
      bw.markConcChange()
    }
    lastTargetConn = target
    refreshStrategy(target)
    return target
  }

  /** 换视频/CDN 时重置本模块的状态（带宽样本与 lane 由装配层一并重置）。 */
  const reset = () => {
    lastTargetConn = 0
    connDownAt = 0
    connUpAt = 0
    wallStep = WALL_CONN_STEPS.length
    headroomIdle = false
    lastHealthZone = 'healthy'
    lastPlayable = 0
    strategy.value = {
      perConnKBps: 0, soloKBps: 0, soloRetain: 0, satConn: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0,
      aggregateScales: true, healthZone: 'healthy', playableSecs: 0, avgSegLoadMs: 0, aggKneeConn: 0,
    }
  }

  /**
   * 只清「并发爬坡 / 沉降」的锁，**不动带宽实测样本**（那是换流才该清的，见 resetStrategy）。
   *
   * 用在 seek：拖进度那一刻存货归零，存货阶梯把目标压到 1~2，同时按「刚减过线程」记下
   * `connDownAt`——于是缓冲补起来之后，升线程还得再等一个沉降期（`avgSegLoadMs`，最长 5s），
   * 正好卡住「拖完进度要好几秒才把并发拉回来」。位置变了不是「判定多开了」，这道锁对 seek 无意义。
   * 清掉之后：升线程立刻走 +1、之后仍受 `CONN_RAMP_MS_*` 一档一档来（不会一步顶格）。
   */
  const resetConcurrencyRamp = () => { connDownAt = 0; connUpAt = 0 }

  return {
    strategy,
    effectivePrefetchTarget,
    updateHealthZone,
    getAdaptivePrefetchCount,
    reset,
    resetConcurrencyRamp,
  }
}

export type ConcurrencyStrategy = ReturnType<typeof useConcurrencyStrategy>
