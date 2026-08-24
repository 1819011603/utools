/**
 * 下一集预热：快播完这一集时，后台把下一集「取址 → 探测 → manifest → 首几片」提前做好。
 *
 * 切一集慢在哪：这几段全是**点了下一集之后才开始串行等**的——
 * 按需取址一发 /api/resolve 抓源站页面（慢站 1-5s）、可达性探测一轮（1-2s）、
 * hls.js 再拉一次 manifest，最后还要从零攒够起播门槛的缓冲。加起来常常好几秒，画面停在转圈上。
 *
 * 为什么不在起播就无脑预热：**要看这个站点取址贵不贵**。
 * 按需取址（`lazyTask`）的站点，取址意味着抓一遍源站页面，地址带时效签名、站点还限流
 *（实测 nbmovie 系取到第 186 发开始回「请求过于频繁」）——提前四十分钟取的地址到时候多半已经死了，
 * 白发一次请求还把限流坐实。所以那类站点只在「快播完」时做一次，那时签名最新鲜。
 * 而地址已经在手上的普通列表（`urls=` 直贴、非 lazy 解析结果），预热压根不需要访问源站页面，
 * 剩下的探测/manifest/分片都是打 CDN，代价只有一点带宽 → 起播稳定后就可以备好。
 *
 * 依赖方向：prewarm → (media, conn, engine, playlist)，与 engine 平行（只用它的暂存入口）。
 * 挂在引擎心跳上由 controller 接线。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoHandoff } from './useVideoHandoff'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoEngine } from './useVideoEngine'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'

/**
 * 「快播完」的提前量。
 *
 * **宁可短不可长**：取到的地址带时效签名（nbmovie 系尤其短），提前太久备好的是一条死链。
 * 60s 足够跑完各段（取址 1-5s + 探测最坏 12s + manifest + 几片），又让地址在用上时不超过一分钟。
 * 跳过片尾开着时要再往前挪：那时自动跳集发生在 `duration - skipOutro`。
 */
const BASE_LEAD_SECS = 60

/**
 * 非 lazy 列表「起播稳定」的判据：已播这么久且缓冲健康。
 *
 * 要等一会儿而不是一起播就备：起播那几秒带宽全用在当前这一集上（还有起播窄口在收着并发），
 * 这时候插进来抢连接正好会拖慢用户眼前正在等的画面。
 */
const EARLY_WARM_AFTER_SECS = 30

/**
 * 预备几片。够跨过定位类起播的门槛（AUTOPLAY_BUFFER_TARGET_RELOCATE = 2.5s）就行，
 * 多下的那些切过去之后预取自己会补，提前下只是替用户猜他一定会看下一集。
 * 分片时长各站不同（常见 3-10s），按累计秒数收口、并封一个片数上限。
 */
const WARM_SEG_TARGET_SECS = 4
const WARM_SEG_MAX = 4

export interface VideoPrewarmDeps {
  media: VideoMediaState
  handoff: VideoHandoff
  conn: VideoConnStrategy
  engine: VideoEngine
  playlist: VideoPlaylistCtl
}

export function useVideoPrewarm(deps: VideoPrewarmDeps) {
  const { media, handoff, conn, engine, playlist } = deps

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
    // 自动跳集点：跳过片尾开着时是 duration - skipOutro，否则是片尾。留 30s 让各段跑完
    const lead = media.skipOutro.value > 0 ? media.skipOutro.value + 30 : BASE_LEAD_SECS
    return dur - media.currentTime.value <= Math.max(BASE_LEAD_SECS, lead)
  }

  /**
   * 这个列表取址贵不贵。贵（按需取址）→ 只在快播完时预热；不贵（地址已在手上）→ 起播稳定后就能备。
   * 判据取 `lazyTask`：它在就说明列表里存的是占位地址，每一集都要现抓源站页面。
   */
  const isCostlyToResolve = (): boolean => !!handoff.lazyTask.value

  /** 现在该不该开始预热 */
  const shouldWarmNow = (): boolean => {
    if (nearEnd()) return true
    if (isCostlyToResolve()) return false          // 取址贵的站点只认「快播完」这一个窗口
    // 地址已在手上：起播稳定（已播一会儿 + 缓冲健康）之后就备好，省掉用户中途点下一集的那几秒
    return media.currentTime.value >= EARLY_WARM_AFTER_SECS
      && engine.strategy.value.healthZone === 'healthy'
  }

  /**
   * ④ 预备首几片。
   *
   * 键必须与 hls.js 之后请求的 URL **完全一致**，否则 fLoader 一条都命不中（等于白下）。
   * 所以分片地址一律从**刚下载的这份 manifest 原文**里解析：
   * 分片要走代理时，服务端 rewriteM3u8 已经把 URI 改写成代理地址了，
   * 解析出来的绝对地址正好等于 fLoader 看到的 `context.url`；直连时它就是裸 CDN 地址。
   * 自己去拼 getProxyUrl 反而会错——那是「当前这一集」的连接配置，下一集的探测结论可能不同。
   */
  const warmSegments = async (nextVideoUrl: string, manifestText: string, manifestUrl: string) => {
    const { parseManifestText } = useM3u8(u => u)
    const { segments, keyUrl } = parseManifestText(manifestText, manifestUrl)
    if (!segments.length) return

    const picked: typeof segments = []
    let secs = 0
    for (const seg of segments) {
      if (picked.length >= WARM_SEG_MAX || secs >= WARM_SEG_TARGET_SECS) break
      picked.push(seg)
      secs += seg.duration || 0
    }

    // AES key 顺手取一次：它由 hls.js 自己的 key loader 拉、不走我们的 fLoader，
    // 存进内存也用不上；但这一发能让它进浏览器 HTTP 缓存，切过去就不必再等一个 RTT
    if (keyUrl) void fetch(keyUrl, { referrerPolicy: 'no-referrer' }).then(r => r.arrayBuffer()).catch(() => {})

    const got: Array<[string, ArrayBuffer]> = []
    await Promise.all(picked.map(async seg => {
      try {
        const res = await fetch(seg.url, { referrerPolicy: 'no-referrer' })
        if (!res.ok) return
        got.push([seg.url, await res.arrayBuffer()])
      } catch { /* 预热失败静默：正常切集那条路会自己重下 */ }
    }))
    if (!got.length) return
    engine.stageSegments(nextVideoUrl, got)
    console.log(`已预备下一集 ${got.length} 个分片（约 ${Math.round(secs)}s）`)
  }

  /**
   * 预热一集。每一段都是「静默尽力」：任何一段失败都只写日志，
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
    /*
     * **通道要听 cfg，不能直接拿 `probe.manifestChannel`**：分片轴可能挑了代理而清单轴自己
     * 直连就通了，`resolveConnConfig` 的归一化规则是「分片要代理 → manifest 也必须走同一种代理」
     * （分片 URL 的重写只发生在服务端 rewriteM3u8）。之前这里直接用探测出的清单通道，
     * 分片需要代理时预热到的会是一份指向裸 CDN 分片地址的清单——`warmSegments` 拿着这些地址
     * 直接 `fetch`，撞的是同一个 CORS/403，预热静默失败（察觉不到，直到清晰度探测把同一个坑现出原形）。
     * 跟 getProxyUrl（useVideoProxy.ts）用同一套判据，才对得上注释里说的「必须完全一致」
     */
    const channel = cfg.disguiseAsDownloader
      ? 'disguise'
      : (cfg.requestOrigin || cfg.requestReferer ? 'headers' : 'direct')
    const manifestUrl = buildChannelUrl(realUrl, channel, {
      origin: cfg.requestOrigin,
      referer: cfg.requestReferer,
      noseg: cfg.manifestOnly,
    })
    // body 要读完才进浏览器 HTTP 缓存（/api/proxy 对点播 m3u8 本来就发 1 天缓存头）；
    // 只读响应头的话这一发等于白跑
    const res = await fetch(manifestUrl, { referrerPolicy: 'no-referrer' })
    const text = await res.text()
    prewarmedUrl.value = placeholder
    console.log('已预热下一集:', placeholder, '→', describeProbe(probe))

    // ④ 首几片。放在最后且不影响前三段的成果：这一段失败只是少赚一点，
    // 前面备好的取址/探测/manifest 照样生效
    if (res.ok && isM3u8Url(realUrl)) {
      await warmSegments(realUrl, text, manifestUrl).catch(
        e => console.warn('预备分片失败（不影响切集）:', e?.message || e),
      )
    }
  }

  /** 每秒被引擎心跳调一次。条件不满足时是纯读判断，便宜 */
  const prewarmTick = () => {
    if (warming || !playlist.hasNext.value) return
    if (media.isResolvingUrl.value) return       // 正在前台取址（切集中），别去抢站点的配额
    const cur = playlist.playlist.value[playlist.currentIndex.value]
    if (!cur || warmedFor === cur) return
    if (!shouldWarmNow()) return

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

  /**
   * 用户把手指/指针放到「下一集」上了——这是最强的意图信号，比任何时间窗口都准。
   * 取址贵的站点平时守着 `nearEnd` 窗口，中途点下一集必然全冷；这条给它开一扇小门：
   * 真要点的时候提前那几百毫秒也算赚，而 hover 一次只发一轮（`warmedFor` 记着）。
   */
  const prewarmNextNow = () => {
    if (warming || !playlist.hasNext.value || media.isResolvingUrl.value) return
    const cur = playlist.playlist.value[playlist.currentIndex.value]
    if (!cur || warmedFor === cur) return
    const next = playlist.playlist.value[playlist.currentIndex.value + 1]
    if (!next) return
    warmedFor = cur
    warming = true
    warm(next)
      .catch(e => console.warn('预热下一集失败（不影响当前播放）:', e))
      .finally(() => { warming = false })
  }

  return { prewarmTick, prewarmNextNow, prewarmedUrl }
}

export type VideoPrewarm = ReturnType<typeof useVideoPrewarm>
