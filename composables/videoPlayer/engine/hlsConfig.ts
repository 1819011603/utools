/**
 * hls.js 的实例配置。
 *
 * 单独放一个文件不是为了「配置集中管理」，而是因为这里每一项都带着一段「为什么是这个值」——
 * 挤在 useVideoEngine 里会把加载流程冲得看不见（那边超了 500 行）。
 * 内部实现模块，走显式相对 import。
 */
import { MSE_CEILING_SECS, type HlsTuning } from '../types'

export interface HlsConfigInput {
  tuning: HlsTuning
  /** 起播位置（秒）。0 = 从头，交给 hls.js 就是 -1 */
  startPos: number
  /** 自定义分片加载器（命中预取缓存即时返回） */
  fLoader: any
  /** 自定义清单加载器（命中探测下载过的原文即时返回） */
  pLoader: any
}

export function buildHlsConfig(input: HlsConfigInput): Record<string, any> {
  const { tuning: hlsConfigValue, startPos } = input
  return {
    // MSE 缓冲要「小而健康」——append 太多（几百 MB）会触发浏览器 MSE 配额/驱逐，
    // 产生缓冲空洞导致明明缓冲很多却卡在原地。真正的大量预读放在 JS 预取缓存里
    //（容量 = maxBufferSizeMB），hls.js 只在 MSE 里留 ~30s，随播随取。
    // Math.min 兼容并迁移旧的超大配置。
    /*
     * **MSE 窗口不再跟着用户的「预加载时长」走**。
     *
     * 那个旋钮的单位已经改成「**够播几秒**」（墙钟，随倍速换算），而 hls.js 这两项要的是
     * **视频秒**——直接喂过去等于喂错单位（3x 下用户填 30 会被当成 30 秒视频，只有该有的三分之一）。
     * 而且它本来也几乎没生效过：原来是 `Math.min(30, 用户值)`，用户填 600 也只是 30。
     *
     * MSE 窗口是**技术天花板**不是偏好：append 几百 MB 会触发浏览器配额/驱逐，
     * 产生缓冲空洞。大量预读放在 JS 预取缓存里（深度 = 那个旋钮），hls.js 只留这么点随播随取。
     */
    maxBufferLength: 30,
    maxMaxBufferLength: MSE_CEILING_SECS,
    backBufferLength: Math.min(30, hlsConfigValue.backBufferLength),
    maxBufferSize: 60 * 1000 * 1000,   // MSE 最多 ~60MB，其余交给 JS 预取缓存
    /*
     * 缓冲空洞 / 卡顿自动跳跃恢复。
     *
     * **`maxBufferHole` 必须给到 1s，0.5 太小**（实测踩过，症状是「缓冲几百秒却冻死在某个固定时间点」）：
     * 抓来的源常有**音视轨不对齐**的分片。实测甄嬛传第 67 集 33:07 那一片（ffprobe）：
     *   视轨 2041.525~2047.525（6.0s 完整）
     *   音轨 2042.165~2047.413（**开头缺 0.64 秒**）
     * 而 `video.buffered` 是音轨与视轨的**交集**，于是音频那 0.64s 的洞就成了播放的硬墙。
     * 洞比 `maxBufferHole` 大一丝，hls.js 的 gapController 就不肯跳，`nudgeOffset` 0.2s 也跨不过去；
     * 更要命的是它按**视轨**记账（那一片的 PTS 是完整的），于是认定「这片已经缓冲好了」→
     * `_doTickIdle` 每拍都算出「下一片已有」→ 状态停在 IDLE，**永远不再请求任何分片**。
     * 这是死锁，不是慢：预取缓存里躺着几百秒也没用，因为它压根不来要。
     *
     * 给 1s 就能让它自己跳过这类洞（0.6~0.9s 的音轨错位是最常见的一档）。再大就不合适了——
     * 那会开始跳过真正缺失的内容，而且掩盖掉「分片确实没下下来」这类该报的问题。
     * 兜底仍在 `engine/stallRecovery.ts`（阶梯里有「整片放弃」那一级）。
     */
    maxBufferHole: 1,
    highBufferWatchdogPeriod: 1,
    nudgeOffset: 0.2,
    nudgeMaxRetry: 8,
    fragLoadingTimeOut: hlsConfigValue.fragLoadingTimeOut,
    fragLoadingMaxRetry: hlsConfigValue.fragLoadingMaxRetry,
    manifestLoadingTimeOut: 20000,
    manifestLoadingMaxRetry: 3,
    levelLoadingTimeOut: 20000,
    levelLoadingMaxRetry: 3,
    enableWorker: hlsConfigValue.enableWorker,
    lowLatencyMode: hlsConfigValue.lowLatencyMode,
    startLevel: -1,
    startPosition: startPos > 0 ? startPos : -1,
    // 自定义分片加载器：接管分片请求，命中预取缓存直接返回
    fLoader: input.fLoader,
    // 自定义清单加载器：命中「探测刚下载过的同一份 m3u8」就同步返回，省一次 RTT。
    // 必须包在 hls.js 默认 loader 之上（miss 时要走它原来的那套重试/超时）
    pLoader: input.pLoader,
    // Origin/Referer 由 /api/proxy 服务端注入，XHR 层只需关闭 credentials
    xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false },
  }
}
