/**
 * 播放统计刷新：面板上的缓冲秒数 / 当前清晰度档 / 掉帧数，以及一行可读的播放状态诊断。
 *
 * 从 `useVideoEngine` 拆出来：它只读 hls 与 `<video>`，纯展示，不驱动任何生命周期。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type HlsType from 'hls.js'
import type { Ref } from 'vue'
import { describePlaybackState, describeLevel, type StuckSegment } from '../videoDiag'

export interface HlsStatsDeps {
  getHls: () => HlsType | null
  getVideoEl: () => HTMLVideoElement | undefined
  /** MSE + 预取缓存的有效可播秒数（面板展示的是它，不只 MSE 的 ~60s） */
  getCachedAhead: (v: HTMLVideoElement) => number
  getStuckSegment: () => StuckSegment | null
  playbackDiag: Ref<string>
  hlsStats: Ref<{ buffered: number; level: string; dropped: number; total: number } | null>
}

export function useHlsStats(deps: HlsStatsDeps) {
  const { getHls, getVideoEl, getCachedAhead, getStuckSegment, playbackDiag, hlsStats } = deps

  const updateHlsStats = () => {
    const hls = getHls()
    const video = getVideoEl()
    if (!hls || !video) return
    playbackDiag.value = describePlaybackState(video, getStuckSegment())
    // 掉帧只有 <video> 自己知道（解码器丢的帧不会体现在任何缓冲读数上）
    const q = video.getVideoPlaybackQuality?.()
    hlsStats.value = {
      buffered: getCachedAhead(video),   // 含预取缓存的有效已缓冲，不只 MSE 的 ~60s
      /*
       * 档位索引三级兜底：
       * · 只有一档时不存在「选哪档」的问题，直接就是它——不用等 currentLevel/loadLevel 落定，
       *   刚切集、一片都还没请求时（0 线程 0 KB/s）这两个都还是 -1，会晚好几拍才亮出清晰度
       * · `currentLevel` 只在切过档之后才有效，多档流没切过档时也是 -1
       * · `loadLevel` 是「正在下载/已下载的档」，比 currentLevel 更早有值
       */
      level: describeLevel(hls.levels[
        hls.levels.length === 1 ? 0 : hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel
      ]),
      dropped: q?.droppedVideoFrames ?? 0,
      total: q?.totalVideoFrames ?? 0,
    }
  }

  return { updateHlsStats }
}

export type HlsStats = ReturnType<typeof useHlsStats>
