/**
 * 带宽实测模型：每连接速度 / 视频码率 / 聚合能否并行 / 最高流畅倍速。
 *
 * 全是 EWMA 采样加几个纯算式，跟「预取哪一片」「用哪条 lane」都无关，
 * 所以从 `useHlsPrefetch` 里拆出来单独放（那边只留调度）。
 *
 * 「最高流畅倍速」为什么是纯带宽模型：早期靠「缓冲增长率」反推，
 * 但预取到「预加载时长」封顶之后缓冲不再增长、增长率≈0，会把可持续倍速误判成 1x。
 * 改成「满并发聚合带宽 ÷ 码率」直接算，与并发模型（computeTargetConcurrency）同源。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
const ewma = (prev: number, cur: number) => (prev ? prev * 0.7 + cur * 0.3 : cur)

export function useBandwidthModel() {
  let perConnBps = 0   // 实测每连接速度（bps）
  let segBitrate = 0   // 实测视频码率（bps）
  // 聚合可并行探针：分别记「低并发时」与「高并发时」的每连接速度。
  // 若高并发下每连接速度基本持平 → 每连接限速、加线程聚合线性增长（可并行）；
  // 若高并发下每连接速度骤降 → 每 IP 总量硬顶、加线程只是分摊（不可并行）。
  let perConnLow = 0   // 并发 ≤2 时的每连接速度
  let perConnHigh = 0  // 并发 ≥5 时的每连接速度
  /**
   * 各并发档实测到的**聚合**吞吐（bps），下标 = 当时的在途并发数。
   *
   * 「加线程到底换没换来总带宽」只能这么答：每连接速度乘当时的并发，按档记住最好成绩。
   * 每 IP 限总量的源上，6 条的聚合跟 2 条差不多甚至更低（互相抢 + 排队），
   * 这张表能直接把那个拐点指出来（见 bestAggConn）。
   */
  const aggByConn: number[] = []
  /** 一片下载耗时（ms）的 EWMA：判「每连接够不够快」比看瞬时速度直观，也给面板展示 */
  let segLoadMs = 0

  /** 采样一次下载。只认真实网络传输：缓存命中（极快）、过小分片、离谱值一律丢弃 */
  const sampleSpeed = (bytes: number, ms: number, concurrency = 0) => {
    if (bytes < 100_000 || ms < 50) return
    const bps = (bytes * 8) / (ms / 1000)
    if (bps > 500_000_000) return   // >500Mbps 基本是缓存/异常，丢弃
    perConnBps = ewma(perConnBps, bps)
    segLoadMs = ewma(segLoadMs, ms)
    if (concurrency > 0 && concurrency <= 2) perConnLow = ewma(perConnLow, bps)
    else if (concurrency >= 5) perConnHigh = ewma(perConnHigh, bps)
    // 按档记聚合成绩：这一片是在 `concurrency` 条在途的情况下跑出 bps 的 → 那一档的聚合 ≈ bps × 并发
    if (concurrency > 0 && concurrency <= 32) {
      aggByConn[concurrency] = ewma(aggByConn[concurrency] ?? 0, bps * concurrency)
    }
  }

  const sampleBitrate = (bytes: number, sec: number) => {
    if (bytes > 0 && sec > 0) segBitrate = ewma(segBitrate, (bytes * 8) / sec)
  }

  /** 聚合是否随线程增长。两档都有数据才比较，否则乐观按「可并行」（多数 CDN 如此） */
  const getAggregateScales = (): boolean => {
    if (perConnLow > 0 && perConnHigh > 0) return perConnHigh >= perConnLow * 0.55
    return true
  }

  /**
   * 实测到的「聚合最高点」在哪一档并发上。返回 0 = 数据不够，别据此下判断。
   *
   * 用法是给并发**封顶**（`bestConn + 1`，留一档继续试探），而不是直接锁死：
   * 网络会变，锁死就再也爬不回去了。判据要求高档位确实**明显更差**（低于最好成绩的 85%），
   * 只差几个百分点算噪声——EWMA 本来就抖。
   */
  const bestAggConn = (minSamples = 2): number => {
    const levels = aggByConn.map((v, i) => ({ conn: i, agg: v })).filter(x => x.agg > 0)
    if (levels.length < minSamples) return 0
    const best = levels.reduce((a, b) => (b.agg > a.agg ? b : a))
    // 最高点就在最高档 → 还没见到拐点，不封顶
    const maxTried = levels[levels.length - 1]!.conn
    if (best.conn >= maxTried) return 0
    // 更高档里只要有一档明显更差，就认这个拐点
    const worseAbove = levels.some(x => x.conn > best.conn && x.agg < best.agg * 0.85)
    return worseAbove ? best.conn : 0
  }

  /**
   * 「一条连接自己能跑多快」（KB/s）。**只认低并发（≤2）档的采样**，0 = 还没测到。
   *
   * 不能拿 `perConnBps` 代替：它把高并发档的采样一起 EWMA 进去了，而每 IP 限总量的源上
   * 6 条连接各自都慢——用那个数判「单连接是不是被限速了」会得到正好相反的结论
   * （越多开越显得该多开）。低并发档的读数才是这个源单条的真实上限。
   *
   * 样本来源不用另找：存货阶梯在起播、切集、拖进度时必然先走 2~3 条那一档（见 WALL_CONN_STEPS），
   * 低并发采样天然就有，不需要主动降并发去探（那会在慢源上直接造卡顿）。
   */
  const soloConnKBps = (): number => Math.round(perConnLow / 8 / 1024)

  /** 一片平均下载耗时（ms）。0 = 还没测到 */
  const avgSegLoadMs = (): number => Math.round(segLoadMs)

  /** 有没有测出东西来。没有时上层要走「冷启动乐观值」那条路 */
  const hasSamples = (): boolean => !!perConnBps && !!segBitrate

  /** 喂满「码率 × 倍速 × 安全系数」需要几条连接 */
  const requiredConn = (rate: number, safety: number): number =>
    Math.ceil((segBitrate * rate * safety) / perConnBps)

  /**
   * 当前带宽最高能撑几倍速：满并发聚合带宽 ÷ (码率 × 安全系数)，向下对齐 0.25 档（保守，不过度承诺）。
   * 还没测出数时按「当前倍速」展示而不是 0——面板上摆个 0 会让人以为连 1x 都撑不住。
   */
  const maxFluentRate = (cap: number, safety: number, currentRate: number): number =>
    !hasSamples()
      ? Math.max(1, Math.round(currentRate / 0.25) * 0.25)
      : Math.max(1, Math.floor((perConnBps * cap) / (segBitrate * safety) / 0.25) * 0.25)

  const perConnKBps = () => Math.round(perConnBps / 8 / 1024)
  const segMbps = () => Math.round((segBitrate / 1e6) * 10) / 10

  /** 换视频/换 CDN 时清空：用上个流的数据判新流必然跑偏 */
  const resetSamples = () => {
    perConnBps = 0
    segBitrate = 0
    perConnLow = 0
    perConnHigh = 0
    aggByConn.length = 0
    segLoadMs = 0
  }

  return {
    sampleSpeed, sampleBitrate, getAggregateScales, bestAggConn, soloConnKBps, avgSegLoadMs,
    hasSamples, requiredConn, maxFluentRate, perConnKBps, segMbps, resetSamples,
  }
}

export type BandwidthModel = ReturnType<typeof useBandwidthModel>
