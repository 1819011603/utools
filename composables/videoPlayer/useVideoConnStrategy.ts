/**
 * 连接策略：起播前实测「清单轴 / 分片轴」各自能走哪条通道，并把结论写回代理 ref。
 *
 * 连接方式**只有这一个来源**：手动模式与站点规则都已删除。
 * 过去是「直连 → 失败重载 → 代理 → 失败重载 → 代理+防盗链」的线性盲试，两个毛病：
 * 一是把 manifest 和分片当成一个维度（它们常在不同 host，CORS/防盗链/端口各自独立），
 * 二是靠失败反应式升级，最多黑屏重载 3 次。现在改成起播前几个小请求把矩阵测出来，一次到位；
 * 线性阶梯只保留为「探测拿不到结论」（断网/全超时）时的兜底。
 */
import type { Ref } from 'vue'
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
const STRATEGY_STEP_LABELS = ['直连', '代理清单·分片直连', '代理·伪装', '代理·防盗链', '代理·防盗链·主域']
const MAX_STRATEGY_STEP = 4

export function useVideoConnStrategy(deps: VideoConnStrategyDeps) {
  const { media, tier } = deps
  const { videoUrl, videoUrlInput, errorMessage } = media

  // ── 生效中的连接配置（getProxyUrl 直接读这些）──
  // 这五个 ref 一律由引擎写：探测结论 / 兜底阶梯。用户改不动它们，
  // 因为「手动模式」已经取消了——所有情况都收敛进自动，见下面的 originHint。
  const useProxy = ref(false)
  const requestOrigin = ref('')            // 实际注入的 Origin 请求头
  const requestReferer = ref('')           // 实际注入的 Referer（空则自动为 origin + /）
  const manifestOnly = ref(true)           // 只代理 manifest，分片直连 CDN（更快）
  const disguiseAsDownloader = ref(false)  // 默认直连不注入；探测结论可置真
  // 直连+代理双通道：分片在「直连 CDN」和「/api/proxy」两个 origin 间分流，把并发从 6 提到 ~12
  const dualChannel = ref(false)

  // ── 用户填的防盗链候选值 ──
  // 不是配置，是**给探测的线索**：有些站点的 Referer 从视频地址根本推不出来
  //（实测视频在 vod1.maowushi.com，防盗链认的却是 aeete.com，两个域名毫无关系）。
  // 填了它，探测的 headers 通道就拿它去试；试不通照样降级到别的通道，不会把源卡死。
  // 与 requestOrigin 分开存的理由：后者是「引擎最终用了什么」，会被探测结论覆写；
  // 合并成一个 ref 的话，探测判定直连可达时会顺手把用户辛苦找到的域名抹掉。
  const originHint = ref('')
  const refererHint = ref('')

  const proxy = useVideoProxy({ requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, useProxy })
  const { isHlsUrl, effectiveReferer, refererHelp, getProxyUrl, getProxyPassthroughUrl, isDirectMode } = proxy


  const probeResult = ref<ProbeResult | null>(null)
  const isProbing = ref(false)
  let probeSeq = 0        // 竞态守卫：连点/切集时只认最后一次探测
  let reprobedFor = ''    // 该地址是否已因加载失败重探过（避免无限重探）

  const autoStrategyStep = ref(0)
  const ladderMode = ref(false)
  let lastStrategyUrl = ''

  // ── 「代理 Manifest」/「双通道」的可用性判定 ──

  // 「代理 Manifest」需要代理确实介入才有意义：伪装模式下它表示「代理 manifest 补 CORS + 分片直连」，
  // 注入头模式下表示「manifest 走防盗链 + 分片直连」。两者都没有时代理压根不会介入，勾了无效 → 禁用。
  const manifestOnlyDisabled = computed(() =>
    !disguiseAsDownloader.value && !requestOrigin.value.trim() && !requestReferer.value.trim())

  // 分片轴是否真的被实测过。清单通了但没解析出分片时（master 下钻失败/空列表），
  // probeAxis 压根不会跑，四个通道全留在 'skip'——那是「没测」不是「测过不通」。
  // 拿它当证据会把双通道永久钉死在禁用，提示还振振有词说「实测分片无法直连」（踩过）。
  const axisMeasured = (a: AxisProbe): boolean => CHANNEL_ORDER.some(c => (a[c] ?? 'skip') !== 'skip')

  // 双通道需要分片「直连」和「经代理」两条路都通。有实测就用实测，否则按当前配置推断。
  const dualChannelUnavailable = computed(() => {
    const r = probeResult.value
    if (r && !r.degraded && axisMeasured(r.segment)) {
      return !(r.segment.direct === 'ok' && r.segment.disguise === 'ok')
    }
    // 无探测数据（分片轴没测到 / 走了兜底阶梯）：跟 getProxyUrl 对分片(.ts)的判定保持一致——
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
    if (r && !r.degraded && axisMeasured(r.segment)) {
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
    rememberOne(originHistory, ORIGIN_HISTORY_KEY, originHint.value)
    rememberOne(refererHistory, REFERER_HISTORY_KEY, refererHint.value)
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
    } else if (step === 3) {             // 代理+注入 Origin/Referer：防盗链站点，全程代理。
      // 用户填了候选值就用他的——阶梯是探测没结论时才走的盲试，这时用户那点线索比从地址硬推更值钱
      const o = originHint.value.trim() || host
      disguiseAsDownloader.value = false
      requestOrigin.value = o
      requestReferer.value = refererHint.value.trim() || (o ? o + '/' : '')
      manifestOnly.value = false
    } else {                             // 同上，但注入主域：防盗链只认主域的站点（见 parentOrigin）
      const root = parentOrigin(videoUrl.value) || host
      disguiseAsDownloader.value = false
      requestOrigin.value = root; requestReferer.value = root ? root + '/' : ''; manifestOnly.value = false
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

  /** 交给探测的候选头（用户填的那对，空则由探测自己从视频地址推） */
  const hintPair = () => ({ origin: originHint.value.trim(), referer: refererHint.value.trim() })

  /** 跑一次探测并套用结论。返回结果；没结论（degraded）时落回线性阶梯兜底 */
  const runProbe = async (url: string, blocking: boolean): Promise<ProbeResult | null> => {
    const seq = ++probeSeq
    if (blocking) isProbing.value = true
    try {
      const r = await probeReachability(url, hintPair())
      if (seq !== probeSeq) return null            // 已被更新的一次探测取代，丢弃
      probeResult.value = r
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

  /**
   * 决定本次加载策略。档位记忆总是取；可达性部分可能 await 探测。
   * 由 loadVideo 在 startLoadTimeout **之前** await，否则探测耗时会被算进加载超时。
   */
  const applyStrategy = async (url: string) => {
    tier.beginHost(hostOf(url))   // 档位记忆仍按 host 学（可达性不再缓存，见下）
    if (url !== lastStrategyUrl) {
      autoStrategyStep.value = 0
      ladderMode.value = false
      reprobedFor = ''
      probeResult.value = null
      lastStrategyUrl = url
    }
    if (ladderMode.value || !isProbeable(url)) {
      applyReachabilityStep(autoStrategyStep.value)
      return
    }
    // **每次加载都实测，不吃缓存**。
    // 缓存曾经按 host 存 30~60 分钟，问题是同一个 host 的结论并不稳定：
    // 按需取址的站点每集都是现签的地址，签名/路径一换，上一集测出来的「直连可达」对这一集就是 403，
    // 表现是「切一集就播不了、等半天自己好」（实测被反复问到）。
    // 代价是每次切集多等一轮探测——但探测本身有两级超时（单通道 8s、整轮 12s 硬顶），
    // 慢源上也就一两秒，比播不了强。
    await runProbe(url, true)
  }

  /**
   * 加载失败时的恢复：先重探一次（结论可能过期，比如签名换了 / 源站改策略），
   * 重探还救不回来才退回线性阶梯继续盲试。返回 true 表示已接手（调用方别再报错）。
   */
  const escalateStrategyAndReload = (): boolean => {
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
      // axis[c] 兜 'skip'：加通道之前写进 localStorage 的旧探测结果没有新字段，
      // 直接渲染 undefined 会得到一个没有底色、也没有 title 的空格子
      cells: CHANNEL_ORDER.map(c => ({ channel: c, label: CHANNEL_LABEL[c], reach: axis[c] ?? 'skip', ms: axis.ms[c] })),
    }))
  })

  // ── 用户操作 ──

  /**
   * 用户改了 Origin/Referer 候选值 → 拿新线索重探一遍。
   *
   * 必须作废该 host 的可达性缓存：缓存只按 host 存，不含候选值，
   * 不清的话新填的域名压根没机会被试（直接命中上一次用旧候选值探出的结论）。
   * 也必须重载视频：连接策略只在加载时生效（manifest 带不带 noseg 决定分片直连还是走代理），
   * 不重载则 hls.js 仍在用上次那批分片 URL，看着就像「填了没反应」。
   */
  const onHeaderHintChange = () => {
    rememberHeaders()   // 记住本次候选值供下拉复用
    invalidateReachCache()
    ladderMode.value = false
    autoStrategyStep.value = 0
    lastStrategyUrl = ''
    probeResult.value = null
    deps.onDirty()
    if (videoUrl.value) deps.reload()
  }

  // 没有可达性缓存了（见 applyStrategy），这里只把「本次加载已重探过」的标记清掉
  const invalidateReachCache = () => { reprobedFor = '' }

  // 重探（作废缓存，重新实测一遍并按结论重载）
  const reprobeNow = async () => {
    const url = videoUrl.value.trim()
    if (!url || !isProbeable(url) || isProbing.value) return
    ladderMode.value = false
    invalidateReachCache()
    const before = currentConnSignature()
    await runProbe(url, true)
    if (currentConnSignature() !== before) deps.reload()
  }

  /**
   * 用户填的候选值这次到底用上没有。UI 据此标「已采用 / 未采用」——
   * 只显示输入框而不说结果的话，用户没法判断是自己填错了还是引擎压根没试。
   */
  // Referer 输入框的说明：跟着候选 Origin 走（useVideoProxy 那个 refererHelp 读的是引擎生效值，
  // 用在这里会显示成引擎当前用的域名，跟用户正在填的候选值对不上）
  const refererHintHelp = computed(() => {
    const o = originHint.value.trim()
    return '留空时按 Origin 自动补 ' + (o ? o.replace(/\/$/, '') + '/' : '「Origin + /」')
  })

  const hintStatus = computed<'' | 'adopted' | 'unused'>(() => {
    const h = originHint.value.trim()
    if (!h) return ''
    return requestOrigin.value.trim() === h ? 'adopted' : 'unused'
  })

  return {
    // 生效中的连接配置（引擎写，UI 只读）
    useProxy, requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, dualChannel,
    // 用户填的候选头
    originHint, refererHint, hintStatus, refererHintHelp, onHeaderHintChange,
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
    strategyLabel, probeRows, reprobeNow,
  }
}

export type VideoConnStrategy = ReturnType<typeof useVideoConnStrategy>
