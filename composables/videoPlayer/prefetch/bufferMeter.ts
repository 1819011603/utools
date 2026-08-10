/**
 * 缓冲量测：两把尺子，用途严格分开。
 *
 * · `getAheadBuffered` = **仅 MSE** 的前向秒数（浏览器真正能立刻播的量）。跳片判据用它。
 * · `getCachedAhead`   = **有效可播**秒数 = MSE + JS 预取缓存。健康区分档、并发爬坡、
 *   倍速可行性都用它——预取缓存里的分片由 fLoader 同步返回、不需要任何网络等待，
 *   而 MSE 前向本身有天花板（maxBufferLength / 浏览器 MSE 配额），深缓存时它长期停在
 *   几十秒的平台上。按 MSE 分档的后果踩过：有效可播 651s、卡顿 0 次仍判「吃紧」，
 *   降速守卫永远等不到 healthy，「自动最佳倍速」被死锁在 1x。
 *
 * 从 useHlsPrefetch 拆出来：这是纯量测，不决定任何调度。
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import type HlsType from 'hls.js'

export interface BufferMeterDeps {
  getHls: () => HlsType | null
  /** 该分片在不在 JS 预取缓存里（在 = 不需要网络，算作「可播」） */
  getPrefetchedBuf: (url: string) => ArrayBuffer | null
  /** 量测起点：起播定位未到位时是 pendingStartPos，否则是真实播放头 */
  anchorTime: (video: HTMLVideoElement) => number
}

export function useBufferMeter(deps: BufferMeterDeps) {
  const { getPrefetchedBuf, anchorTime } = deps
  const opts = { getHls: deps.getHls }

  // 计算当前播放位置前方的缓冲秒数（仅 MSE，真实可立即播放的量）。
  // 抗卡顿闭环/自适应并发必须用这个，不能掺预取缓存（否则误判缓冲充足而停下载）。
  const getAheadBuffered = (video: HTMLVideoElement): number => {
    const ct = video.currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= ct + 0.1 && ct <= video.buffered.end(i)) {
        return video.buffered.end(i) - ct
      }
    }
    return 0
  }

  // 有效已缓冲时长（秒）：从当前播放位置往后，能「无需再下载」连续播出去的秒数。
  // 一片算「可播」的条件：已在 MSE 里（播放器已有）或在 JS 预取缓存里（一拖就命中）——
  // 两者都不需要再下载。逐片累加，直到遇到第一个「还需要下载」的分片（既不在 MSE 也没预取）为止。
  const getCachedAhead = (video: HTMLVideoElement): number => {
    const ct = anchorTime(video)   // 起播定位期间从 pendingStartPos 量起，反映恢复位置的真实缓冲
    const hls = opts.getHls()
    const level = hls && hls.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = (hls as any)?.levels?.[level]?.details?.fragments ?? []
    if (!frags.length) return getAheadBuffered(video)

    // 某时间点是否已落在 MSE 已缓冲区间内（已下载进播放器，无需再取）
    const inMSE = (t: number): boolean => {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.1 && t < video.buffered.end(i) + 0.1) return true
      }
      return false
    }

    let reach = ct
    for (const frag of frags) {
      if (frag.end <= ct + 0.1) continue                     // 播放头之前的分片，跳过
      if (frag.start > reach + 0.5) break                     // 与已达区间不连续（真空洞）→ 停
      const mid = (frag.start + frag.end) / 2
      const available = getPrefetchedBuf(frag.url) !== null || inMSE(mid)
      if (!available) break                                   // 该分片还需下载 → 停
      reach = frag.end                                        // 可播 → 延伸
    }
    return Math.max(0, reach - ct)
  }

  return { getAheadBuffered, getCachedAhead }
}
