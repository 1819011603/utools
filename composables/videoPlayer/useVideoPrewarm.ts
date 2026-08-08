/**
 * 下一集预热：快播完这一集时，后台把下一集「取址 → 探测 → manifest」三段提前做好。
 *
 * 切一集慢在哪：这三段全是**点了下一集之后才开始串行等**的——
 * 按需取址一发 /api/resolve 抓源站页面（慢站 1-5s）、可达性探测一轮（1-2s）、
 * hls.js 再拉一次 manifest。加起来常常好几秒，画面停在转圈上。
 *
 * 为什么不在起播就预热：地址带时效签名，站点还限流（实测 nbmovie 系取到第 186 发开始
 * 回「请求过于频繁」）。提前四十分钟取的地址到时候多半已经死了，白发一次请求还把限流坐实。
 * 所以只在「快播完」时做一次，那时签名最新鲜。
 *
 * 依赖方向：prewarm → (media, conn, playlist)，与 engine 平行。挂在引擎心跳上由 controller 接线。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'

/**
 * 提前多久备下一集。
 *
 * **宁可短不可长**：取到的地址带时效签名（nbmovie 系尤其短），提前太久备好的是一条死链，
 * 而且切过去之后没有补救路径——`reload()` 直接用 `videoUrl`，不会再重新取址，
 * 表现是「自动跳到下一集，然后 403 卡死、也不自动播」，比慢几秒糟得多。
 * 60s 足够跑完三段（取址 1-5s + 探测最坏 12s + manifest），又让地址在用上时不超过一分钟。
 * 跳过片尾开着时要再往前挪：那时自动跳集发生在 `duration - skipOutro`。
 */
const BASE_LEAD_SECS = 60

export interface VideoPrewarmDeps {
  media: VideoMediaState
  conn: VideoConnStrategy
  playlist: VideoPlaylistCtl
}

export function useVideoPrewarm(deps: VideoPrewarmDeps) {
  const { media, conn, playlist } = deps

  /** 已经为「哪一集」备过下一集。每集只跑一次：失败也不重试，站点限流比慢几秒难受得多 */
  let warmedFor = ''
  let warming = false

  /** 备好的是哪一集（占位地址）。目前只用于日志，UI 上不显示——预热成功与否用户不该关心 */
  const prewarmedUrl = ref('')

  const originOf = (url: string): string => {
    try { return new URL(url.startsWith('//') ? 'https:' + url : url).origin } catch { return '' }
  }

  const nearEnd = (): boolean => {
    const dur = media.duration.value
    if (!dur) return false
    // 自动跳集点：跳过片尾开着时是 duration - skipOutro，否则是片尾。留 30s 让三段跑完
    const lead = media.skipOutro.value > 0 ? media.skipOutro.value + 30 : BASE_LEAD_SECS
    return dur - media.currentTime.value <= Math.max(BASE_LEAD_SECS, lead)
  }

  /**
   * 预热一集。三段都是「静默尽力」：任何一段失败都只写日志，
   * 正常切集那条路照样会自己重做一遍，用户不该看见任何提示。
   */
  const warm = async (placeholder: string) => {
    // ① 真实地址（非按需取址的列表原样返回，这一段是零成本的）
    const realUrl = await playlist.peekLazyUrl(placeholder)
    if (!realUrl) return

    // ② 可达性。存在 conn 里按**完整 URL**记，切过去时 applyStrategy 直接取用
    const probe = await conn.prewarmProbe(realUrl)
    if (!probe) return

    // ③ manifest。用探测结论算出的那条通道拼地址——必须与真正加载时 getProxyUrl 生成的
    // 完全一致，否则预热的是另一个 URL，浏览器缓存一条也命不中。
    // 没结论（degraded）时跳过：不知道该走哪条，乱试只是白发请求。
    const cfg = probe.manifestChannel ? resolveConnConfig(probe, originOf(realUrl)) : null
    if (!cfg || !probe.manifestChannel) return
    const manifestUrl = buildChannelUrl(realUrl, probe.manifestChannel, {
      origin: cfg.requestOrigin,
      referer: cfg.requestReferer,
      noseg: cfg.manifestOnly,
    })
    // body 要读完才进浏览器 HTTP 缓存（/api/proxy 对点播 m3u8 本来就发 1 天缓存头）；
    // 只读响应头的话这一发等于白跑
    const res = await fetch(manifestUrl, { referrerPolicy: 'no-referrer' })
    await res.text()
    prewarmedUrl.value = placeholder
    console.log('已预热下一集:', placeholder, '→', describeProbe(probe))
  }

  /** 每秒被引擎心跳调一次。条件不满足时是纯读判断，便宜 */
  const prewarmTick = () => {
    if (warming || !playlist.hasNext.value) return
    if (media.isResolvingUrl.value) return       // 正在前台取址（切集中），别去抢站点的配额
    const cur = playlist.playlist.value[playlist.currentIndex.value]
    if (!cur || warmedFor === cur) return
    if (!nearEnd()) return

    const next = playlist.playlist.value[playlist.currentIndex.value + 1]
    if (!next) return
    warmedFor = cur
    warming = true
    console.log('开始预热下一集（剩余',
      Math.round(media.duration.value - media.currentTime.value), '秒）:', next)
    warm(next)
      .catch(e => console.warn('预热下一集失败（不影响当前播放）:', e))
      .finally(() => { warming = false })
  }

  return { prewarmTick, prewarmedUrl }
}

export type VideoPrewarm = ReturnType<typeof useVideoPrewarm>
