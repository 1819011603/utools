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

  /**
   * 上一次目标并发变更的时刻（`performance.now()`）。**「按并发档记账」这件事全靠它才成立。**
   *
   * 由来：**减线程是没法立即生效的**——在途的下载不会被回收，实际并发要等它们各自跑完才降下来。
   * 于是那几片是「在 6 条里挤着下、在 2 条时交货」的：速度是高并发时的低速度，
   * 而记账时读到的并发已经是 2。后果是它把**低并发档污染成低速**（`perConnLow`、`aggByConn[2]`），
   * 而低并发档正是「这个源单条能跑多快」的唯一依据（见 soloConnKBps）→
   * 「刚减完线程 → 看着单条变慢 → 判定被限速 → 又加回去」的震荡，加减各一次就自锁。
   *
   * 加线程那一侧同样错，只是方向相反：早就在跑的那一片会被记进新的高档，把高档抬得虚高。
   *
   * 所以跨越变更点的样本一律不进分档账本（只喂混合均值，那本来就是混的）。
   */
  let concChangedAt = 0
  /** 目标并发一变就调；在此之前发起的请求，其读数属于上一个并发档 */
  const markConcChange = () => { concChangedAt = performance.now() }

  /**
   * 采样一次下载。只认真实网络传输：缓存命中（极快）、过小分片、离谱值一律丢弃。
   * `startedAt` 是请求发起时刻（`performance.now()`）：跨越并发变更点的样本不进分档账本。
   */
  const sampleSpeed = (bytes: number, ms: number, concurrency = 0, startedAt?: number) => {
    if (bytes < 100_000 || ms < 50) return
    const bps = (bytes * 8) / (ms / 1000)
    if (bps > 500_000_000) return   // >500Mbps 基本是缓存/异常，丢弃
    perConnBps = ewma(perConnBps, bps)
    segLoadMs = ewma(segLoadMs, ms)
    // 这一片是在「上一个并发档」里发起的 → 记进当前档会把两个档都判错，只留混合均值
    if (startedAt !== undefined && startedAt < concChangedAt) return
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

  /**
   * 单条速度的**保有率**：当前每连接速度 ÷ 单条基线。1 = 没被摊薄；0.5 = 掉一半。0 = 没基线，别据此下判断。
   *
   * 这是「加线程到底该不该加」最快的信号，比聚合成绩（`bestAggConn`）早得多：
   * 加线程之后**单连接速度立刻就掉**，而聚合要等各档都攒够样本才比得出拐点。
   * 所以**单条优先于聚合**——只有单条没被摊薄多少时才允许继续加。
   *
   * 分子用混合均值 `perConnBps`（含当前高并发档的采样，反应快）、分母用低并发档 `perConnLow`
   * （这个源单条的真实上限）。跟 `getAggregateScales()` 的区别是它不要求有 ≥5 并发的采样，
   * 任何并发档下都能给出读数，因此爬坡途中就能刹住，而不是等爬到顶才发现白爬。
   */
  const soloRetainRatio = (): number =>
    perConnLow > 0 && perConnBps > 0 ? perConnBps / perConnLow : 0

  /** 一片平均下载耗时（ms）。0 = 还没测到 */
  const avgSegLoadMs = (): number => Math.round(segLoadMs)

  /** 有没有测出东西来。没有时上层要走「冷启动乐观值」那条路 */
  const hasSamples = (): boolean => !!perConnBps && !!segBitrate

  /**
   * 喂满「码率 × 倍速 × 安全系数」需要几条连接。
   *
   * `solo = true` 时分母改用**单条基线**（低并发档实测），**这是打断正反馈的关键**：
   * 分母用混合均值 `perConnBps` 会形成死循环——线程一多 → 每条都被摊薄 → 均值掉 →
   * 「需要更多条」→ 再加线程 → 更摊薄。实测截图：单条 369KB/s 的源被摊到 222KB/s，
   * requiredConn 从 4 涨到 6，`catchUpFloor` 于是 ×2 顶到 12（= hostCap），
   * 把所有帽子全顶回满并发；而那一刻聚合 20.8Mbps 已经是 5.2Mbps 码率的 4 倍。
   *
   * 凡是问「这个源要几条才喂得动」的地方（地板）都该用 solo；
   * 问「当前这一拍的供给够不够」的地方（headroomConnCap）才用混合均值。
   */
  const requiredConn = (rate: number, safety: number, solo = false): number => {
    const per = solo && perConnLow > 0 ? perConnLow : perConnBps
    return Math.ceil((segBitrate * rate * safety) / per)
  }

  /** 实测到的最高聚合吞吐（bps，按并发档记的最好成绩）。0 = 还没测到 */
  const peakAggBps = (): number => aggByConn.reduce((m, v) => (v > m ? v : m), 0)

  /**
   * **饱和并发**：多到这个数以上，加线程就纯粹是把同一份带宽分摊。0 = 数据不够，别据此下判断。
   *
   *     饱和并发 = 实测峰值聚合 ÷ 单条基线
   *
   * 推导：源站给这个 IP 的总量上限就是实测到的峰值聚合；一条连接自己能跑 `perConnLow`；
   * 那么「每条都能跑到自己上限」的连接数就是两者的比。再多开的每一条都只能从别人嘴里抢。
   * 实测截图：峰值聚合 20.8Mbps ÷ 单条 2.95Mbps ≈ 7 —— **12 条里有 5 条纯属摊薄**。
   *
   * 它是治「减了又加」那个死循环的关键，因为**两个输入都不随当前线程数漂移**：
   * 峰值是历史最好成绩（按档独立记账，收线程也不会掉），单条基线只收低并发档的采样。
   * 保有率（`soloRetainRatio`）反应快但会随线程数一起回升，只能当快信号，不能当稳态判据
   * ——收完线程它就恢复了，于是放开、再摊薄、再收，来回振。
   */
  const saturationConn = (): number => {
    const peak = peakAggBps()
    if (peak <= 0 || perConnLow <= 0) return 0
    const sat = Math.max(2, Math.ceil(peak / perConnLow))
    /*
     * **只有「试探过更高并发」时这个数才可信**（同 bestAggConn 那句 `best.conn >= maxTried`）。
     *
     * 不加这道判据就会自锁：只在 2 条上测过时，峰值聚合就是 2 条那一档 = 2 × 单条，
     * 于是算出饱和 = 2，`saturationLimit()` 把地板也封在 2 —— 源站压根没被试探过更高并发，
     * 而「饱和值 = 试过的最高档」这个结论反过来禁止了试探。慢源上表现为**线程数永远上不去**：
     * 5x 倍速下存货墙钟本来就长期停在濒卡档（保险线 5s 墙钟 = 25 视频秒），
     * 唯一能救的 `catchUpFloor` 又被这个假饱和值封死（实测日志：全程钉在 2 条，一条 [conn] 都不再打）。
     *
     * 判据是「饱和点必须严格低于试过的最高档」——那才叫真的看见了饱和，
     * 而不是「还没往上试过」。数据不够就返回 0（不咬人），交给存货阶梯和地板去试探。
     */
    const maxTried = aggByConn.reduce((m, v, i) => (v > 0 ? i : m), 0)
    return sat < maxTried ? sat : 0
  }

  /**
   * 「实测聚合到底喂不喂得动」——`卡顿守卫`那个「摊薄型 vs 真慢型」分岔的判据，抽出来复用。
   *
   * 判据用**实测峰值聚合**而不是「当前线程数 × 当前每连接速度」：后者跟着目标并发走，
   * 会让「地板要不要抬」依赖于「地板刚才抬到多少」→ 3↔8 来回震荡。峰值是只读的历史事实，
   * 收线程之后也不会掉（EWMA 按档独立记账），所以结论稳定。
   * 代价是网络变差时它会偏乐观——那一侧由卡顿守卫和存货阶梯兜（它们看的是地面真值）。
   */
  const aggregateFeeds = (rate: number, safety: number): boolean => {
    const need = segBitrate * rate * safety
    return need > 0 && peakAggBps() >= need
  }

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
    concChangedAt = 0
  }

  return {
    sampleSpeed, sampleBitrate, markConcChange,
    getAggregateScales, bestAggConn, soloConnKBps, soloRetainRatio, avgSegLoadMs,
    hasSamples, requiredConn, aggregateFeeds, peakAggBps, saturationConn, maxFluentRate,
    perConnKBps, segMbps, resetSamples,
  }
}

export type BandwidthModel = ReturnType<typeof useBandwidthModel>
