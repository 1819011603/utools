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

  /** 采样一次下载。只认真实网络传输：缓存命中（极快）、过小分片、离谱值一律丢弃 */
  const sampleSpeed = (bytes: number, ms: number, concurrency = 0) => {
    if (bytes < 100_000 || ms < 50) return
    const bps = (bytes * 8) / (ms / 1000)
    if (bps > 500_000_000) return   // >500Mbps 基本是缓存/异常，丢弃
    perConnBps = ewma(perConnBps, bps)
    if (concurrency > 0 && concurrency <= 2) perConnLow = ewma(perConnLow, bps)
    else if (concurrency >= 5) perConnHigh = ewma(perConnHigh, bps)
  }

  const sampleBitrate = (bytes: number, sec: number) => {
    if (bytes > 0 && sec > 0) segBitrate = ewma(segBitrate, (bytes * 8) / sec)
  }

  /** 聚合是否随线程增长。两档都有数据才比较，否则乐观按「可并行」（多数 CDN 如此） */
  const getAggregateScales = (): boolean => {
    if (perConnLow > 0 && perConnHigh > 0) return perConnHigh >= perConnLow * 0.55
    return true
  }

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
  }

  return {
    sampleSpeed, sampleBitrate, getAggregateScales,
    hasSamples, requiredConn, maxFluentRate, perConnKBps, segMbps, resetSamples,
  }
}

export type BandwidthModel = ReturnType<typeof useBandwidthModel>
