/**
 * 并发策略：把「这一拍该开几条预取线程」算出来（`getAdaptivePrefetchCount` 的九级模型），
 * 以及对外展示用的策略快照（`strategy`）。本文件只放「值」（`desiredConn`）、「缓冲卡住」探测、
 * 各级的**调度顺序**与沉降/爬升；各级「界」（帽子与地板）的算式在 `./caps.ts`。
 *
 * 从 `useHlsPrefetch` 拆出来：它只读实测（`BandwidthModel`）与档位参数，不碰网络、不碰缓存，
 * 与「预取哪一片」的调度完全解耦。两者共享的可变状态（hostConcurrencyCap / segDurSecs）
 * 收在一个 `runtime` 对象里，由装配层创建后同时交给策略与调度。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import { ref } from 'vue'
import type { TierParams } from '../../videoSiteRules'
import { MAX_PLAYBACK_RATE } from '../display'
import type { BandwidthModel } from './bandwidth'
import { useConcurrencyCaps } from './caps'
import {
  FALLBACK_SEG_SECS, FILL_HORIZON_SECS, COAST_WALL_SECS, COAST_GAP_WALL_SECS, HEADROOM_RESUME_FRAC,
  COLD_START_CONN_CAP, CONN_SETTLE_MIN_MS, CONN_SETTLE_MAX_MS, CONN_RAMP_MS_SLOW, CONN_RAMP_MS_FAST,
  BUFFER_STUCK_MS, BUFFER_GROW_MIN,
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
  connTrace: string       // 上一拍九级并发的逐级输出与「咬人的那一级」（面板诊断用）
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
  const { bw, runtime, tier, getPlaybackRate, getPrefetchTargetSecs, getSafeWallSecs, getColdStartConn } = deps
  const caps = useConcurrencyCaps(deps)
  const { catchUpFloor, wallConnCap, stallGuard, dilutionCap, soloFastCap, aggregateKneeCap } = caps

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
    avgSegLoadMs: 0, aggKneeConn: 0, connTrace: '',
  })

  // 并发控制的持久状态。**没有「受控并发」这个积分器了**：目标值每拍由 desiredConn 的
  // 吞吐模型现算（见 getAdaptivePrefetchCount），这里只留爬坡/沉降/迟滞需要的几个时间戳与档位。
  let lastTargetConn = 0                  // 上一拍算出的目标并发（卡顿守卫拿它判「带宽够不够」）
  /**
   * 是否已经出过至少一拍目标。
   * **首拍直接给基值**（冷启动/切集要 2~3 条把第一片让过去，不是从 1 慢慢爬）；
   * 之后一律一档一档——**包括「已到目标停取（0）之后又掉下来」的恢复**：以前判据是
   * `lastTargetConn > 0`，于是从 0 恢复会**直接跳到目标**（慢源上可能是 6~12），
   * 跟「3→12 一步顶格」是同一个毛病。
   */
  let hasEvaluated = false
  /**
   * 「缓冲卡住」探测的观察窗状态（见 BUFFER_STUCK_MS）：窗口起点时刻 + 起点时的有效可播 + 上一窗结论。
   * 用来打破「消费 ≈ 填充 → 缓冲原地不动 → 存货阶梯不给更多线程 → 更涨不动」的自锁。
   */
  let stuckWinAt = 0
  let stuckWinAhead = 0
  let bufferStuck = false
  let connDownAt = 0                      // 上次**下调**并发的时刻：沉降期内只许再降不许升
  let connUpAt = 0                        // 上次**上调**并发的时刻：爬升按 CONN_RAMP_MS_SLOW/FAST 一档一档来
  let headroomIdle = false                // 缺口已到目标、停取中：恢复要等缺口张开到 5%（迟滞）
  let lastHealthZone: HealthZone = 'healthy'  // 健康区（驱动 UI 与降速守卫）
  let lastPlayable = 0                    // 上次量到的有效可播秒数（MSE + 预取缓存）
  // 上一拍的九级诊断：desiredConn 写停取原因，getAdaptivePrefetchCount 逐级追加，refreshStrategy 落快照。
  // 曾是控制台 [conn] 日志（排查时被删），现挂在面板「目标并发」上——盲猜九级里谁咬人太贵了
  let connTrace = ''
  let stopReason = ''

  // 刷新对外策略快照（供 UI 展示与倍速可行性判断）
  const refreshStrategy = (targetConn: number) => {
    /*
     * 「最高流畅倍速」用**实测交付吞吐**，不再用带宽模型外推——外推模型不了每 IP 限速/摊薄，
     * 虚成十来倍是实测过的（面板先后出现过 11.75x / 75x）。每片下载都是真实交付，限速、
     * 摊薄、硬顶已经全在这个数里。**但只有「系统真的在抢带宽」（目标并发 > 0）的秒才等于能力**——
     * 停取期（缓存到目标、预取主动停工）那一秒的真实流量是「播放消耗」（≈码率本身），
     * 拿它当能力会把展示钉死在 1x（实测踩过：稳态下恒 1x）。所以：
     *   · 目标并发 > 0：用本拍交付，并记为「最近活跃读数」；本拍桶还空着 → 沿用它；
     *   · 目标并发 = 0：一律沿用最近活跃读数（网络真变差由卡顿守卫/健康区兜，那里看的是地面真值）。
     * **但只有「系统真的在抢带宽」（目标并发 > 0）的拍才喂 EWMA**——停取期（缓存到目标、
     * 预取主动停工）那一秒的真实流量是「播放消耗」（≈码率本身），喂了就把读数污染成 1x
     *（实测踩过：稳态恒 1x）；停取拍不喂，EWMA 冻结。单秒交货成簇，靠 EWMA 平滑 +
     * 0.25 档取整保稳，不再叠「窗口最差值」（那专挑噪声，钉死过 0.75x）。
     * 显示 = max(1, min(5, EWMA ÷ (码率×安全) 向下取 0.25 档))。**下限 1 必须在计算分支也有**——
     * 对着 3x 零卡顿的播放显示 0.75x 毫无意义（实测踩过）。
     * 首拍没有活跃样本 → 按当前倍速显示（摆 0 会让人以为连 1x 都撑不住）。
     */
    const live = bw.deliveredBps()
    if (targetConn > 0) bw.noteActiveDelivery(live)
    const segBps = bw.segBps()
    const activeBps = bw.activeDeliveryBps()
    const sustainable = !bw.hasSamples() || activeBps <= 0 || segBps <= 0
      ? Math.max(1, Math.round(getPlaybackRate() / 0.25) * 0.25)
      : Math.max(1, Math.min(MAX_PLAYBACK_RATE, Math.floor(activeBps / (segBps * tier().safety) / 0.25) * 0.25))
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
      connTrace,
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
    if (stop) {
      stopReason = headroomIdle
        ? `停取:缺口${gap.toFixed(1)}v,复工需${Math.max(2 * seg, target * HEADROOM_RESUME_FRAC).toFixed(1)}v`
        : `停取:缺口${gap.toFixed(1)}v≤一片`
      headroomIdle = true
      return 0                                                   // 已到目标（上层还会再判一次停取）
    }
    headroomIdle = false
    stopReason = '取中'
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
    const now = performance.now()
    let target = cachedAhead === undefined ? runtime.hostConcurrencyCap : desiredConn(cachedAhead)
    connTrace = `入=${cachedAhead === undefined ? '不限' : `${cachedAhead.toFixed(1)}v`}/${stopReason} 基=${target}`
    let biter = ''
    const clamp = (name: string, v: number) => { connTrace += ` ${name}=${v}`; if (v < target) { target = v; biter = name } }
    if (!bw.hasSamples()) clamp('①冷启动', COLD_START_CONN_CAP)               // ①
    if (cachedAhead !== undefined) {
      const wall = cachedAhead / Math.max(1, getPlaybackRate())
      const targetSecs = effectivePrefetchTarget()
      // ── 「缓冲卡住」探测：目标没到、而有效可播一个观察窗内没明显增长 → 少开线程换不来存货 ──
      if (stuckWinAt === 0) { stuckWinAt = now; stuckWinAhead = cachedAhead }
      else if (now - stuckWinAt >= BUFFER_STUCK_MS) {
        bufferStuck = cachedAhead < stuckWinAhead + BUFFER_GROW_MIN
        stuckWinAt = now
        stuckWinAhead = cachedAhead
      }
      const notAtTarget = Number.isFinite(targetSecs)
        && targetSecs - cachedAhead > (runtime.segDurSecs || FALLBACK_SEG_SECS)
      clamp('②阶梯', wallConnCap(wall, getSafeWallSecs(), bufferStuck && notAtTarget))   // ②
      const guard = stallGuard()                                            // ③
      clamp('③卡顿', guard.cap)
      clamp('④摊薄', dilutionCap())                                        // ④
      clamp('⑤单条快', soloFastCap(wall))                                  // ⑤
      clamp('⑥拐点', aggregateKneeCap())                                   // ⑥
      // ⑧ 地板只在「真慢型卡顿」时抬——它要压过上面所有的收紧，否则慢源永远补不回来。
      //    冷启动帽不受它影响：那时没样本，stallGuard 直接返回不咬人的值
      const floor = Math.min(runtime.hostConcurrencyCap, guard.floor)
      connTrace += ` ⑧地板=${floor}`
      if (floor > target) { target = floor; biter = '⑧地板' }
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
    const settleMs = Math.min(CONN_SETTLE_MAX_MS, Math.max(CONN_SETTLE_MIN_MS, bw.avgSegLoadMs()))
    if (hasEvaluated && target > lastTargetConn) {
      // 爬升间隔：**默认慢档**（线程涨太快会把紧邻播放头那一片摊薄——用户反馈）；但
      // 「存货吃紧/濒卡」或「源站真慢（地板被顶起来，`catchUpFloor`>0）」是真需要更多连接的
      // 场合，回快档——那里慢爬会把恢复拖很久。
      const urgent = lastHealthZone !== 'healthy' || catchUpFloor() > 0
      const rampMs = urgent ? CONN_RAMP_MS_FAST : CONN_RAMP_MS_SLOW
      if (now - connDownAt < settleMs) { target = lastTargetConn; biter = '⑨沉降' }   // 刚减过：等在途排空
      else if (now - connUpAt < rampMs) { target = lastTargetConn; biter = '⑨爬坡' }  // 上一档还没站稳
      else if (lastTargetConn + 1 < target) { target = lastTargetConn + 1; biter = '⑨+1' } // 一档一档来
    }
    if (biter) connTrace += ` ⚡${biter}`
    if (target !== lastTargetConn) {
      if (lastTargetConn > 0 && target < lastTargetConn) connDownAt = now
      if (target > lastTargetConn) connUpAt = now
      bw.markConcChange()
    }
    lastTargetConn = target
    hasEvaluated = true
    refreshStrategy(target)
    return target
  }

  /** 面板诊断：上一拍九级的逐级输出（见 connTrace） */
  const getConnTrace = (): string => connTrace

  /** 换视频/CDN 时重置本模块的状态（带宽样本与 lane 由装配层一并重置）。 */
  const reset = () => {
    lastTargetConn = 0
    hasEvaluated = false
    stuckWinAt = 0
    stuckWinAhead = 0
    bufferStuck = false
    connDownAt = 0
    connUpAt = 0
    caps.reset()
    headroomIdle = false
    lastHealthZone = 'healthy'
    lastPlayable = 0
    strategy.value = {
      perConnKBps: 0, soloKBps: 0, soloRetain: 0, satConn: 0, segMbps: 0, targetConn: 4, maxFluentRate: 0,
      aggregateScales: true, healthZone: 'healthy', playableSecs: 0, avgSegLoadMs: 0, aggKneeConn: 0, connTrace: '',
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
    effectivePrefetchTarget, getConnTrace,
    updateHealthZone,
    getAdaptivePrefetchCount,
    reset,
    resetConcurrencyRamp,
  }
}

export type ConcurrencyStrategy = ReturnType<typeof useConcurrencyStrategy>
