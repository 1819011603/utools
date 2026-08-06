/**
 * 播放卡点诊断：「已缓冲一直加却不播」时，一眼看出卡在哪。
 *
 * 关键区分：「已缓冲」是 JS 预取缓存（getCachedAhead），能一直涨；
 * 能不能播只看 video 元素的 MSE 缓冲。
 * readyState 是「整体就绪等级」，不是帧序号：2=有当前帧但不够续播 → 会停下等。
 *
 * 纯函数：只读 video 和一份「最久在途分片」快照，方便单独验证。
 */

const READY_STATE_TXT = ['无数据(0)', '仅元数据(1)', '有当前帧·不够续播(2)', '够续播(3)', '缓冲充足(4)']

/** useHlsPrefetch.getStuckSegment() 的返回形状 */
export interface StuckSegment {
  name: string
  elapsedMs: number
  count: number
}

export function describePlaybackState(video: HTMLVideoElement, stuck: StuckSegment | null): string {
  const ct = video.currentTime
  const rs = READY_STATE_TXT[video.readyState] ?? String(video.readyState)
  if (video.error) {
    return `❌ 媒体错误(code ${video.error.code})：${video.error.message || '解码/格式失败'}`
  }
  const n = video.buffered.length
  if (n === 0) {
    return `⏳ MSE 为空：播放器尚未 append 任何分片（hls.js 正在下载/解码首片，readyState=${rs}）`
  }

  const ranges: string[] = []
  let curEnd = -1   // 播放头所在区间的末尾
  let nextStart = -1 // 其后最近一个区间的起点（用于判空洞）
  for (let i = 0; i < n; i++) {
    const s = video.buffered.start(i)
    const e = video.buffered.end(i)
    ranges.push(`${s.toFixed(1)}~${e.toFixed(1)}`)
    if (s <= ct + 0.1 && ct <= e + 0.1) curEnd = e
    else if (s > ct && (nextStart < 0 || s < nextStart)) nextStart = s
  }

  const stuckText = stuck
    ? ` ｜ 最久在途：${stuck.name} 已下 ${(stuck.elapsedMs / 1000).toFixed(1)}s（共 ${stuck.count} 片）`
    : ''

  if (curEnd < 0) {
    // 播放头不在任何区间内：定位错位/落在洞里
    const after = nextStart >= 0 ? `，最近的下一段从 ${nextStart.toFixed(1)}s 开始` : ''
    return `⚠️ 播放头 ${ct.toFixed(1)}s 不在任何缓冲区间内（定位错位）${after}；MSE 区间：${ranges.join(', ')}s${stuckText}`
  }

  const mseAhead = curEnd - ct
  if (mseAhead < 0.5) {
    const dl = stuck
      ? ` ｜ 最久在途：${stuck.name} 已下 ${(stuck.elapsedMs / 1000).toFixed(1)}s（共 ${stuck.count} 片在下）`
      : ' ｜ 当前无分片在下载（卡在 append/解码，非下载）'
    if (nextStart > curEnd + 0.05) {
      // MSE 有空洞：播到 curEnd 就断，下一段从 nextStart 开始，中间没接上（不是某帧坏了）
      return `⚠️ 缓冲空洞：播到 ${curEnd.toFixed(1)}s 断开，下一段从 ${nextStart.toFixed(1)}s 起（缺 ${(nextStart - curEnd).toFixed(1)}s 没接上）→ 卡在洞前${dl}`
    }
    // 无洞、就是喂得慢：hls.js 还没把下一片 append 进来（下载/解码中）
    return `⏳ MSE 到头（前向仅 ${mseAhead.toFixed(1)}s）：在等下一片${dl}`
  }

  if (video.paused) {
    return `⏸ 已就绪(前向 ${mseAhead.toFixed(1)}s) 但处于暂停：等待/被拦截的自动播放`
  }
  return `✅ 正常播放（前向 MSE ${mseAhead.toFixed(1)}s，readyState=${rs}）`
}

/** 把 hls.js 的画质档位说成人话；部分流不上报分辨率(height=0)，退回显示码率避免出现无意义的「0p」 */
export function describeLevel(level: { height?: number; bitrate?: number } | undefined): string {
  if (!level) return '自动'
  if (level.height) {
    let s = `${level.height}p`
    if (level.bitrate) s += ` (${Math.round(level.bitrate / 1000)}kbps)`
    return s
  }
  if (level.bitrate) return `${Math.round(level.bitrate / 1000)}kbps`
  return '自动'
}
