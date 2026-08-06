/**
 * 连接策略：起播前实测「清单轴 / 分片轴」各自能走哪条通道，并把结论写回代理 ref。
 *
 * 优先级恒为 **手动 > 站点规则 > 自动探测**。
 *
 * 过去是「直连 → 失败重载 → 代理 → 失败重载 → 代理+防盗链」的线性盲试，两个毛病：
 * 一是把 manifest 和分片当成一个维度（它们常在不同 host，CORS/防盗链/端口各自独立），
 * 二是靠失败反应式升级，最多黑屏重载 3 次。现在改成起播前几个小请求把矩阵测出来，一次到位；
 * 线性阶梯只保留为「探测拿不到结论」（断网/全超时）时的兜底。
 */
import type { Ref } from 'vue'
import type { SiteRule } from '../videoSiteRules'
import type { ProbeResult, ConnConfig, AxisProbe } from './useReachabilityProbe'
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoServerTier } from './useVideoServerTier'

export interface VideoConnStrategyDeps {
  media: VideoMediaState
  tier: VideoServerTier
  /** 状态有变，持久化一次 */
  onDirty: () => void
  /** 把当前策略写回地址栏 */
  syncUrl: () => void
  /** 重载当前视频。连接策略只在加载时生效，改了必须重载 */
  reload: () => void
}

/** 线性阶梯每一级的展示文案（下标即 step） */
const STRATEGY_STEP_LABELS = ['直连', '代理清单·分片直连', '代理·伪装', '代理·防盗链']
const MAX_STRATEGY_STEP = 3

export function useVideoConnStrategy(deps: VideoConnStrategyDeps) {
  const { media, tier } = deps
  const { videoUrl, videoUrlInput, errorMessage } = media

  // ── 代理相关 ref（getProxyUrl 直接读这些） ──
  const useProxy = ref(false)
  const requestOrigin = ref('')            // 注入的 Origin 请求头
  const requestReferer = ref('')           // 注入的 Referer（空则自动为 origin + /）
  const manifestOnly = ref(true)           // 仅代理 manifest，分片直连 CDN（更快）
  const disguiseAsDownloader = ref(false)  // 默认直连不注入；探测结论或站点规则可置真
  // 直连+代理双通道：分片在「直连 CDN」和「/api/proxy」两个 origin 间分流，把并发从 6 提到 ~12
  const dualChannel = ref(false)
  const manualStrategyOverride = ref(false)  // 开启后用手动设置，引擎不再覆盖可达性

  const proxy = useVideoProxy({ requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, useProxy })
  const { isHlsUrl, effectiveReferer, refererHelp, getProxyUrl, getProxyPassthroughUrl, isDirectMode } = proxy

  // 当前 URL 命中的内置站点规则（供代理/预取/下载并发和档位读取）。
  // 自定义规则的编辑界面已移除，这里只吃 videoSiteRules.ts 里的内置表。
  const activeRule = ref<SiteRule | null>(null)

  const probeResult = ref<ProbeResult | null>(null)
  const isProbing = ref(false)
  let probeSeq = 0        // 竞态守卫：连点/切集时只认最后一次探测
  let reprobedFor = ''    // 该地址是否已因加载失败重探过（避免无限重探）

  const autoStrategyStep = ref(0)
  const ladderMode = ref(false)
  let lastStrategyUrl = ''

  // ── 「仅代理 Manifest」/「双通道」的可用性判定 ──

  // 「仅代理 Manifest」需要代理确实介入才有意义：伪装模式下它表示「代理 manifest 补 CORS + 分片直连」，
  // 注入头模式下表示「manifest 走防盗链 + 分片直连」。两者都没有时代理压根不会介入，勾了无效 → 禁用。
  const manifestOnlyDisabled = computed(() =>
    !disguiseAsDownloader.value && !requestOrigin.value.trim() && !requestReferer.value.trim())

  // 双通道需要分片「直连」和「经代理」两条路都通。有探测结果就用实测，否则按当前配置推断。
  const dualChannelUnavailable = computed(() => {
    const r = probeResult.value
    if (r && !r.degraded) return !(r.segment.direct === 'ok' && r.segment.disguise === 'ok')
    // 无探测数据（手动/规则/兜底阶梯）：跟 getProxyUrl 对分片(.ts)的判定保持一致——
    // 分片走代理时直连 lane 必 403/CORS，没有分流可言。
    if (disguiseAsDownloader.value) return !manifestOnly.value
    const hasHeaders = !!requestOrigin.value.trim() || !!requestReferer.value.trim()
    if (hasHeaders) return !manifestOnly.value
    return useProxy.value
  })

  const dualChannelHint = computed(() => {
    if (!dualChannelUnavailable.value) {
      return '分片在直连 CDN 与本站代理两个 origin 间分流，把并发从 6 提到 ~12（代价：占用服务器出口流量）'
    }
    const r = probeResult.value
    if (r && !r.degraded) {
      if (r.segment.direct !== 'ok') return '实测分片无法直连（须走代理）→ 直连通道会失败'
      return '实测分片无法经代理获取（如源站端口非标被 CF 吞、服务器 IP 被封）→ 代理通道会失败'
    }
    return '需分片直连可达才有效：分片走代理时直连通道会 403'
  })

  // ── Origin/Referer 输入历史（localStorage 永久保存，供输入框下拉复用） ──
  const ORIGIN_HISTORY_KEY = 'video-player-origin-history'
  const REFERER_HISTORY_KEY = 'video-player-referer-history'
  const originHistory = ref<string[]>([])
  const refererHistory = ref<string[]>([])

  const loadHeaderHistory = () => {
    try { originHistory.value = JSON.parse(localStorage.getItem(ORIGIN_HISTORY_KEY) || '[]') } catch {}
    try { refererHistory.value = JSON.parse(localStorage.getItem(REFERER_HISTORY_KEY) || '[]') } catch {}
  }
  const rememberOne = (listRef: Ref<string[]>, key: string, value: string) => {
    const v = value.trim()
    if (!v) return
    listRef.value = [v, ...listRef.value.filter(x => x !== v)].slice(0, 30)  // 去重、置顶、上限 30
    try { localStorage.setItem(key, JSON.stringify(listRef.value)) } catch {}
  }
  const rememberHeaders = () => {
    rememberOne(originHistory, ORIGIN_HISTORY_KEY, requestOrigin.value)
    rememberOne(refererHistory, REFERER_HISTORY_KEY, requestReferer.value)
  }

  // 下拉建议：当前视频域名置顶 + 历史
  //（自动策略下用户很少手填，历史常为空，故用当前域名兜底保证有可选项）
  const currentVideoOrigin = computed(() => {
    const u = (videoUrl.value || videoUrlInput.value || '').trim()
    if (!u) return ''
    try { return new URL(u.startsWith('//') ? 'https:' + u : u).origin } catch { return '' }
  })
  const originSuggestions = computed(() => {
    const host = currentVideoOrigin.value
    return host ? [host, ...originHistory.value.filter(x => x !== host)] : originHistory.value
  })
  const refererSuggestions = computed(() => {
    const r = currentVideoOrigin.value ? currentVideoOrigin.value + '/' : ''
    return r ? [r, ...refererHistory.value.filter(x => x !== r)] : refererHistory.value
  })

  // ── 阶梯 / 结论套用 ──

  // 规则是否显式接管可达性（任一代理相关字段有值）；有则用规则，跳过自动探测
  const ruleControlsReachability = (r: SiteRule | null): boolean =>
    !!r && (r.useProxy !== undefined || r.manifestOnly !== undefined ||
      r.disguiseAsDownloader !== undefined || r.origin !== undefined || r.referer !== undefined)

  const selfOriginOf = (url: string): string => {
    try { return new URL(url.startsWith('//') ? 'https:' + url : url).origin } catch { return '' }
  }
  // blob:/file: 是本地资源，没有可达性可言，一律跳过探测
  const isProbeable = (url: string): boolean => /^https?:\/\//i.test(url) || url.startsWith('//')

  /**
   * 应用阶梯第 step 级配置（写回 ref，getProxyUrl 随即生效）。
   *
   * 每一级都必须把四个 ref 全写一遍——漏写任何一个都会让上一级的残留值改变本级语义
   *（典型：忘了关 manifestOnly，「全程代理」就悄悄变成「分片直连」）。
   */
  const applyReachabilityStep = (step: number) => {
    const host = selfOriginOf(videoUrl.value)
    useProxy.value = false
    if (step <= 0) {                     // 直连：最快，CORS 开放站点直接用
      disguiseAsDownloader.value = false
      requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = false
    } else if (step === 1) {             // 代理 manifest 补 CORS，分片仍直连 CDN（比全代理快得多）
      disguiseAsDownloader.value = true
      requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = true
    } else if (step === 2) {             // 代理+伪装全程：服务端补 CORS、不发 Origin/Referer
      disguiseAsDownloader.value = true
      requestOrigin.value = ''; requestReferer.value = ''; manifestOnly.value = false
    } else {                             // 代理+注入 Origin/Referer：防盗链站点，全程代理
      disguiseAsDownloader.value = false
      requestOrigin.value = host; requestReferer.value = host ? host + '/' : ''; manifestOnly.value = false
    }
  }

  // 探测结论 → 写回连接 ref（getProxyUrl 随即生效）
  const applyConnConfig = (cfg: ConnConfig) => {
    useProxy.value = false
    disguiseAsDownloader.value = cfg.disguiseAsDownloader
    requestOrigin.value = cfg.requestOrigin
    requestReferer.value = cfg.requestReferer
    manifestOnly.value = cfg.manifestOnly
    dualChannel.value = cfg.dualChannel
  }

  // 连接配置指纹：后台复验时用来判断「结论有没有变」，没变就绝不动 ref
  //（连接策略只在加载时生效，播放中改它只会让 UI 和实际请求对不上）
  const connSignature = (c: ConnConfig) =>
    [c.disguiseAsDownloader, c.requestOrigin, c.requestReferer, c.manifestOnly, c.dualChannel].join('|')
  const currentConnSignature = () =>
    [disguiseAsDownloader.value, requestOrigin.value, requestReferer.value, manifestOnly.value, dualChannel.value].join('|')

  /** 跑一次探测并套用结论。返回结果；没结论（degraded）时落回线性阶梯兜底 */
  const runProbe = async (url: string, blocking: boolean): Promise<ProbeResult | null> => {
    const seq = ++probeSeq
    if (blocking) isProbing.value = true
    try {
      const r = await probeReachability(url)
      if (seq !== probeSeq) return null            // 已被更新的一次探测取代，丢弃
      probeResult.value = r
      saveLearnedProfile(hostOf(url), { reach: r as any })
      const cfg = resolveConnConfig(r, selfOriginOf(url))
      if (cfg) {
        ladderMode.value = false
        applyConnConfig(cfg)
        console.log('可达性探测:', describeProbe(r), r)
      } else {
        ladderMode.value = true                    // 三条路都没测通 → 交回阶梯继续盲试
        applyReachabilityStep(autoStrategyStep.value)
        console.warn('可达性探测无结论，退回线性阶梯', r)
      }
      return r
    } catch (e) {
      console.error('可达性探测异常:', e)
      ladderMode.value = true
      applyReachabilityStep(autoStrategyStep.value)
      return null
    } finally {
      if (seq === probeSeq) isProbing.value = false
    }
  }

  // 命中缓存时的后台静默复验：结论一致就什么都不做，变了才提示 + 重载一次。
  // 每个 host 一轮会话只复验一次——否则「复验 → 重载 → 又命中刚写的缓存 → 又复验」会白跑一圈。
  const revalidatedHosts = new Set<string>()
  const revalidateInBackground = (url: string) => {
    const host = hostOf(url)
    if (revalidatedHosts.has(host)) return
    revalidatedHosts.add(host)
    probeReachability(url).then(r => {
      if (videoUrl.value.trim() !== url) return     // 用户已切走
      probeResult.value = r
      saveLearnedProfile(hostOf(url), { reach: r as any })
      const cfg = resolveConnConfig(r, selfOriginOf(url))
      if (!cfg || connSignature(cfg) === currentConnSignature()) return
      console.log('连接方式已变化，重新套用:', describeProbe(r))
      applyConnConfig(cfg)
      useToast().add({ title: '连接方式已更新', description: describeProbe(r), color: 'blue', timeout: 2500 })
      deps.reload()
    }).catch(() => {})
  }

  /**
   * 决定本次加载策略。同步部分（规则/档位记忆）总是跑；可达性部分可能 await 探测。
   * 由 loadVideo 在 startLoadTimeout **之前** await，否则探测耗时会被算进加载超时。
   */
  const applyStrategy = async (url: string) => {
    const rule = matchSiteRule(url)
    activeRule.value = rule
    const learned = tier.beginHost(hostOf(url))
    // 双通道：规则可指定；手动模式保留用户当前设置（dualChannel 与可达性无关，单独套用）
    if (!manualStrategyOverride.value && rule?.dualChannel !== undefined) dualChannel.value = rule.dualChannel
    if (url !== lastStrategyUrl) {
      autoStrategyStep.value = 0
      ladderMode.value = false
      reprobedFor = ''
      probeResult.value = null
      lastStrategyUrl = url
    }
    if (manualStrategyOverride.value) return  // 手动模式：保留用户当前代理设置，不自动改
    if (ruleControlsReachability(rule)) {
      if (rule!.useProxy !== undefined) useProxy.value = rule!.useProxy
      if (rule!.manifestOnly !== undefined) manifestOnly.value = rule!.manifestOnly
      if (rule!.disguiseAsDownloader !== undefined) disguiseAsDownloader.value = rule!.disguiseAsDownloader
      if (rule!.origin !== undefined) requestOrigin.value = rule!.origin
      if (rule!.referer !== undefined) requestReferer.value = rule!.referer
      return
    }
    if (ladderMode.value || !isProbeable(url)) {
      applyReachabilityStep(autoStrategyStep.value)
      return
    }
    // 缓存新鲜（同 host 30 分钟内探过）→ 直接套用秒起播，后台静默复验；
    // 否则阻塞探一次，一步到位，不做「先播再重载」的抖动。
    const cached = isReachFresh(learned) ? (learned!.reach as unknown as ProbeResult) : null
    if (cached) {
      probeResult.value = cached
      const cfg = resolveConnConfig(cached, selfOriginOf(url))
      if (cfg) {
        applyConnConfig(cfg)
        revalidateInBackground(url)
        return
      }
    }
    await runProbe(url, true)
  }

  /**
   * 加载失败时的恢复：先重探一次（结论可能过期，比如签名换了 / 源站改策略），
   * 重探还救不回来才退回线性阶梯继续盲试。返回 true 表示已接手（调用方别再报错）。
   */
  const escalateStrategyAndReload = (): boolean => {
    if (manualStrategyOverride.value) return false
    if (ruleControlsReachability(activeRule.value)) return false
    const url = videoUrl.value.trim()
    if (url && isProbeable(url) && !ladderMode.value && reprobedFor !== url) {
      reprobedFor = url
      console.log('加载失败，重新探测连接方式')
      errorMessage.value = '加载失败，正在重新探测连接方式...'
      runProbe(url, true).then(() => deps.reload())
      return true
    }
    if (autoStrategyStep.value >= MAX_STRATEGY_STEP) return false
    ladderMode.value = true
    autoStrategyStep.value++
    console.log('探测未能救回，退回线性阶梯 → step', autoStrategyStep.value)
    errorMessage.value = `正在自动尝试「${STRATEGY_STEP_LABELS[autoStrategyStep.value]}」...`
    deps.reload()
    return true
  }

  // ── 展示 ──

  const strategyLabel = computed(() => {
    if (manualStrategyOverride.value) return '手动'
    if (ruleControlsReachability(activeRule.value)) return `规则(${activeRule.value?.name})`
    if (isProbing.value) return '探测中…'
    if (probeResult.value && !probeResult.value.degraded) return describeProbe(probeResult.value)
    return STRATEGY_STEP_LABELS[autoStrategyStep.value] ?? '直连'
  })

  // 探测矩阵读数（展开设置里展示，排查源站用）
  const probeRows = computed(() => {
    const r = probeResult.value
    if (!r) return []
    const axes: Array<{ name: string; axis: AxisProbe }> = r.isHls
      ? [{ name: '清单', axis: r.manifest }, { name: '分片', axis: r.segment }]
      : [{ name: '视频', axis: r.segment }]
    return axes.map(({ name, axis }) => ({
      name,
      cells: CHANNEL_ORDER.map(c => ({ channel: c, label: CHANNEL_LABEL[c], reach: axis[c], ms: axis.ms[c] })),
    }))
  })

  // ── 用户操作 ──

  /**
   * 用户改动任一连接设置 → 转手动（引擎不再覆盖可达性；并发/预取仍全自动）。
   * 必须重载视频：连接策略只在加载时生效（manifest 是否带 noseg 决定分片直连/代理），
   * 不重载则 hls.js 仍在用上次策略解析出的分片 URL（改「仅代理 Manifest」看似不生效）。
   */
  const onManualProxyChange = () => {
    manualStrategyOverride.value = true
    rememberHeaders()   // 记住本次 Origin/Referer 供下拉复用
    deps.onDirty()
    deps.syncUrl()      // 手动策略要能随链接带走
    if (videoUrl.value) deps.reload()
  }

  // 交回引擎全自动：顺带作废该 host 的可达性缓存，强制重探一次
  //（用户点这个按钮多半就是因为觉得当前选择不对）
  const resetToAuto = () => {
    manualStrategyOverride.value = false
    autoStrategyStep.value = 0
    ladderMode.value = false
    reprobedFor = ''
    probeResult.value = null
    lastStrategyUrl = ''
    if (tier.currentHost.value) {
      saveLearnedProfile(tier.currentHost.value, { reach: undefined })
      revalidatedHosts.delete(tier.currentHost.value)
    }
    deps.onDirty()
    deps.syncUrl()      // 策略参数从地址栏摘掉
    if (videoUrl.value) deps.reload()
  }

  // 手动重探（作废缓存，重新实测一遍并按结论重载）
  const reprobeNow = async () => {
    const url = videoUrl.value.trim()
    if (!url || !isProbeable(url) || isProbing.value) return
    ladderMode.value = false
    reprobedFor = ''
    const before = currentConnSignature()
    await runProbe(url, true)
    if (currentConnSignature() !== before) deps.reload()
  }

  return {
    // 代理 ref
    useProxy, requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, dualChannel,
    manualStrategyOverride, activeRule,
    // 代理 URL 生成
    isHlsUrl, effectiveReferer, refererHelp, getProxyUrl, getProxyPassthroughUrl, isDirectMode,
    // 可用性 / 提示
    manifestOnlyDisabled, dualChannelUnavailable, dualChannelHint,
    // 头历史
    originHistory, refererHistory, loadHeaderHistory, rememberHeaders,
    originSuggestions, refererSuggestions,
    // 探测
    probeResult, isProbing, ladderMode, autoStrategyStep,
    applyStrategy, escalateStrategyAndReload, applyReachabilityStep,
    // 展示 / 操作
    strategyLabel, probeRows, onManualProxyChange, resetToAuto, reprobeNow,
  }
}

export type VideoConnStrategy = ReturnType<typeof useVideoConnStrategy>
