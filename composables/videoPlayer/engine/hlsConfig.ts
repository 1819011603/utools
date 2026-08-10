/**
 * hls.js 的实例配置。
 *
 * 单独放一个文件不是为了「配置集中管理」，而是因为这里每一项都带着一段「为什么是这个值」——
 * 挤在 useVideoEngine 里会把加载流程冲得看不见（那边超了 500 行）。
 * 内部实现模块，走显式相对 import。
 */
import type { HlsTuning } from '../types'

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
    maxBufferLength: Math.min(30, hlsConfigValue.maxBufferLength),
    maxMaxBufferLength: Math.min(60, hlsConfigValue.maxMaxBufferLength),
    backBufferLength: Math.min(30, hlsConfigValue.backBufferLength),
    maxBufferSize: 60 * 1000 * 1000,   // MSE 最多 ~60MB，其余交给 JS 预取缓存
    // 缓冲空洞 / 卡顿自动跳跃恢复
    maxBufferHole: 0.5,
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
    fLoader: createHlsFragLoader() as any,
    // 自定义清单加载器：命中「探测刚下载过的同一份 m3u8」就同步返回，省一次 RTT。
    // 必须包在 hls.js 默认 loader 之上（miss 时要走它原来的那套重试/超时）
    pLoader: createHlsPlaylistLoader((HlsLib as any).DefaultConfig.loader) as any,
    // Origin/Referer 由 /api/proxy 服务端注入，XHR 层只需关闭 credentials
    xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false },
  }
}
