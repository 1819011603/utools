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
import type { ProbeResult, ConnConfig } from './useReachabilityProbe'
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

/** 探测结论那条常驻 toast 的固定 id（同一时刻只留最新一条，见 notifyProbeVerdict） */
const VERDICT_TOAST_ID = 'vp-probe-verdict'

/** 线性阶梯每一级的展示文案（下标即 step） */
const STRATEGY_STEP_LABELS = ['直连', '代理清单·分片直连', '代理·伪装', '代理·防盗链']
const MAX_STRATEGY_STEP = 3

export function useVideoConnStrategy(deps: VideoConnStrategyDeps) {
  const { media, tier } = deps
  const { videoUrl, videoUrlInput, errorMessage } = media
  // 在 setup 期取一次。别放到探测回调里现取——那里已经跨了好几个 await，
  // 而 applyProbeResult 有一条调用路径（applyStrategy 用预热结果那条）**不在 try/catch 里**，
  // 一旦 useToast() 因为拿不到 Nuxt 实例而抛，异常会一路穿出 loadVideo，
  // isLoading 永远停在 true——症状就是「转圈卡死」，而且完全看不出是谁抛的
  const toast = useToast()

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
  let probedUrl = ''      // 当前 probeResult 属于哪个地址（见 escalateStrategyAndReload 的「别白重探」）

  const autoStrategyStep = ref(0)
  const ladderMode = ref(false)
  let lastStrategyUrl = ''

  // ── 「代理 Manifest」/「双通道」的可用性判定 ──

  // 「代理 Manifest」需要代理确实介入才有意义：伪装模式下它表示「代理 manifest 补 CORS + 分片直连」，
  // 注入头模式下表示「manifest 走防盗链 + 分片直连」。两者都没有时代理压根不会介入，勾了无效 → 禁用。
  const manifestOnlyDisabled = computed(() =>
    !disguiseAsDownloader.value && !requestOrigin.value.trim() && !requestReferer.value.trim())

  // 双通道需要分片「直连」和「经代理」两条路都通。有实测就用实测，否则按当前配置推断。
  const dualChannelUnavailable = computed(() => {
    // 已经开着就别再说「不可用」：那条 lane 可能是靠**迟到判定**开的（两条通道各自实测 ok，
    // 只是有一条没在预算内回来 → 矩阵里留着 'skip'）。此时按矩阵读会得出相反的结论，
    // 界面上就是「灯亮着、提示说不可用」（踩过）
    if (dualChannel.value) return false
    const r = probeResult.value
    if (r && !r.degraded && axisMeasured(r.segment)) {
      // **只把 'fail'/'unknown' 当不可用**：'skip' 是「没等到」，不是「测过不通」
      return r.segment.direct !== 'ok' || (r.segment.disguise !== 'ok' && r.segment.disguise !== 'skip')
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
      if (r.segment.disguise === 'skip') return '分片的代理通道这一轮没等到结论（起播不为它多等）→ 等它回来会自动开'
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
    } else {                             // 代理+注入 Origin/Referer：防盗链站点，全程代理。
      // 用户填了候选值就用他的——阶梯是探测没结论时才走的盲试，这时用户那点线索比从地址硬推更值钱。
      // 曾经在这后面还有一级「注入主域」（parentOrigin），已随 rootRef 通道一起删
      const o = originHint.value.trim() || host
      disguiseAsDownloader.value = false
      requestOrigin.value = o
      requestReferer.value = refererHint.value.trim() || (o ? o + '/' : '')
      manifestOnly.value = false
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

  /**
   * 探测已经实测证伪时**立刻**说出来（典型：清单能取到，分片三条通道全 403）。
   *
   * 不早说的代价是用户干等一分多钟：探测结束后还要跑「重新取址 → 重探」，失败还要爬阶梯，
   * 每级一次 15s 加载超时，画面全程转圈，最后只给一句「加载超时」——而结论在探测收尾那一刻
   * 就已经定了。真正的止损在 escalateStrategyAndReload（fatal 不爬阶梯），这里只负责把话说清。
   *
   * 按 URL 记一次：同一集会因加载失败重探，重复弹同一条只是噪音。
   */
  let verdictNotifiedFor = ''
  const notifyProbeVerdict = (r: ProbeResult, url: string) => {
    const v = diagnoseProbe(r)
    if (v.severity !== 'fatal' || verdictNotifiedFor === url) return
    verdictNotifiedFor = url
    errorMessage.value = v.title
    // Toast 而不只是那条 UAlert：接下来的重取址/重探会把 errorMessage 改成
    //「正在重新…」，真正的原因反而被自己的重试信息盖掉。
    // **`timeout: 0` = 不自动消失**，要用户自己点掉：这条不是「进度播报」而是结论，
    // 而且带着「换一条线路」这个待办。自动消失的话用户往往只瞥见一闪（踩过：「提醒一下就没了」）。
    // 固定 id + 先 remove：不消失就得防堆积——一部整季都死的剧点过五集会摞五张，
    // 而先 remove 保证留下的是最新那一集的结论（`add` 撞 id 时是丢弃新的，不是覆盖）
    toast.remove(VERDICT_TOAST_ID)
    toast.add({ id: VERDICT_TOAST_ID, title: v.title, description: v.detail, color: 'red', timeout: 0 })
  }

  /**
   * 探测顺手下载好的 m3u8 原文，交给引擎的 pLoader 直接喂 hls.js（省一次 RTT）。
   * 按**完整请求 URL** 存，一次性——见 useVideoEngine.createHlsPlaylistLoader 里的理由。
   */
  let seededManifest: { url: string; finalUrl: string; text: string } | null = null
  /**
   * 返回原文 + **重定向后的最终地址**。后者必须一起给：hls.js 拿 `response.url` 当基准还原
   * 清单里的相对分片 URI，真实 XHR 给它的恒是最终地址。只给请求地址会把分片指到错的机器上
   *（实测 ncat22 的清单 302 换 IP 换端口，表现是「分片全 200、解码持续失败」）。
   */
  const takeSeededManifest = (url: string): { text: string; finalUrl: string } | null => {
    if (!seededManifest || !url || seededManifest.url !== url) return null
    const hit = { text: seededManifest.text, finalUrl: seededManifest.finalUrl }
    seededManifest = null
    return hit
  }

  /** 结论 → 生效（或退回阶梯）。runProbe 与「用预热结果」两处共用 */
  const applyProbeResult = (r: ProbeResult, url: string) => {
    probeResult.value = r
    probedUrl = url          // 结论属于哪个地址。失败恢复要靠它判「这份结论是不是就是当前这条的」
    // 这一份原文只对紧接着的那一发加载有效（同一个完整 URL）。
    // 结论没结论（degraded → 走阶梯）时也照存：阶梯可能正好落在同一条通道上，命中就赚一次
    seededManifest = r.manifestText && r.manifestRequestUrl
      ? { url: r.manifestRequestUrl, finalUrl: r.manifestFinalUrl || r.manifestRequestUrl, text: r.manifestText }
      : null
    notifyProbeVerdict(r, url)
    const cfg = resolveConnConfig(r, selfOriginOf(url))
    if (cfg) {
      ladderMode.value = false
      applyConnConfig(cfg)
      console.log('可达性探测:', describeProbe(r), r)
      // 迟到的双通道结论：起播不等它（它只影响预取分流）。等回来了再把第二条 lane 打开，
      // 前提是这份结论还属于当前这条地址 —— 中途切了集就该作废，不能把上一集的判断按到这一集上
      if (r.dualChannelLate) {
        void r.dualChannelLate.then(late => {
          if (!late || dualChannel.value || probedUrl !== url) return
          dualChannel.value = true
          console.log('双通道（迟到判定）：分片直连与代理均实测可达 → 预取开第二条 lane')
        })
      }
    } else {
      ladderMode.value = true                    // 三条路都没测通 → 交回阶梯继续盲试
      applyReachabilityStep(autoStrategyStep.value)
      console.warn('可达性探测无结论，退回线性阶梯', r)
    }
  }

  // ── 预热探测（后台给下一集用，见 useVideoPrewarm）──
  //
  // **按完整 URL 存，绝不按 host**：按 host 缓存正是「切一集就播不了」那个坑——
  // 按需取址的站点每集都是现签的地址，签名/路径一换，上一集的结论对这一集就是 403。
  // 同一个具体地址几分钟内的结论才是稳定的，那不是猜测，是同一次实测。
  const WARM_PROBE_TTL = 90_000
  /**
   * 容量。原来是**单槽**，于是只有「刚预热的那一条」能命中：
   * 点「上一集」永远全冷（那一集几分钟前才播过，结论明明还在手上），
   * 预热过下一集之后又手动跳去别的集，那份结论也白扔。
   * 4 条足够覆盖「上一集 / 当前 / 下一集 / 刚重探过的」，又不至于攒下一堆过期结论。
   */
  const WARM_PROBE_MAX = 4
  /** 按**完整 URL**存的近期探测结论（Map 自带插入序，用它做 LRU） */
  const warmProbes = new Map<string, ProbeResult>()

  const rememberWarmProbe = (url: string, r: ProbeResult) => {
    warmProbes.delete(url)                 // 重新插到队尾，维持 LRU 顺序
    warmProbes.set(url, r)
    while (warmProbes.size > WARM_PROBE_MAX) {
      const oldest = warmProbes.keys().next().value
      if (oldest === undefined) break
      warmProbes.delete(oldest)
    }
  }

  /**
   * 取一条还没过期的近期结论；**取用即删**（同一份结论不重复吃第二次）。
   *
   * 只认**本实例内存里**这份 Map。曾经在 miss 时还去读一份 localStorage 跨页缓存
   * （解析页「可达性检测」刚测过的地址 → 播放器新标签页免掉整轮重测），已整块删除：
   * 现在播放器每次起播一律当场实测，代价是多等一轮探测（单通道 8s / 整轮 12s 硬顶）。
   */
  const takeWarmProbe = (url: string): ProbeResult | null => {
    const r = warmProbes.get(url)
    if (!r) return null
    warmProbes.delete(url)
    return Date.now() - r.at < WARM_PROBE_TTL ? r : null
  }

  /**
   * 后台探一个还没开始播的地址。**不写任何生效 ref、不碰 probeSeq/isProbing/probeResult**——
   * 那些是当前这一集正在用的，播放中改它们只会让 UI 和 hls.js 手上的分片 URL 对不上。
   */
  const prewarmProbe = async (url: string): Promise<ProbeResult | null> => {
    if (!isProbeable(url)) return null
    try {
      const r = await probeReachability(url, hintPair())
      rememberWarmProbe(url, r)
      return r
    } catch (e) {
      console.warn('预热探测失败（不影响当前播放）:', e)
      return null
    }
  }

  /** 跑一次探测并套用结论。返回结果；没结论（degraded）时落回线性阶梯兜底 */
  const runProbe = async (url: string, blocking: boolean): Promise<ProbeResult | null> => {
    const seq = ++probeSeq
    if (blocking) isProbing.value = true
    try {
      const r = await probeReachability(url, hintPair())
      if (seq !== probeSeq) return null            // 已被更新的一次探测取代，丢弃
      // 前台探测的结论也存一份：这是「点上一集永远全冷」的修法——那一集几分钟前刚播过，
      // 结论明明还在手上。也顺带让「重探 → reload」这条路不再连着探两遍同一个地址。
      rememberWarmProbe(url, r)
      applyProbeResult(r, url)
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
    /**
     * **MP4 一律先直连**（不探测、不伪装）。
     *
     * 探测那一套是为 HLS 写的：两根轴（清单/分片）、按「取回来的清单里解析出几个分片」判可达。
     * 整片 MP4 压根没有清单，这套判据对它只会给出误判——实测 4kvm 的天翼云盘直链
     * （`*.ctyunxs.cn`，预签名 + `Content-Disposition: attachment`）被判成直连不可达、
     * 于是按到代理·伪装上：几百 MB 的整片全程绕一跳服务端，还赔上探测那一两秒。
     * 而这类直链本来就是「拿到就能播」的，浏览器原生播放也不需要 CORS（我们已经不加
     * `crossorigin` 了，见 Stage.vue）。
     *
     * 直连播不了的 MP4（防盗链、mixed content）仍有出路：加载失败会走
     * `escalateStrategyAndReload` 的线性阶梯，第 1 级起就是代理。
     */
    if (ladderMode.value || !isProbeable(url) || !isHlsUrl(url)) {
      applyReachabilityStep(autoStrategyStep.value)
      return
    }
    // **每次加载都实测，不吃缓存**。
    // 缓存曾经按 host 存 30~60 分钟，问题是同一个 host 的结论并不稳定：
    // 按需取址的站点每集都是现签的地址，签名/路径一换，上一集测出来的「直连可达」对这一集就是 403，
    // 表现是「切一集就播不了、等半天自己好」（实测被反复问到）。
    // 代价是每次切集多等一轮探测——但探测本身有两级超时（单通道 8s、整轮 12s 硬顶），
    // 慢源上也就一两秒，比播不了强。
    //
    // 唯一的例外是预热：后台刚给**这个同一个地址**测过一轮，直接拿来用。
    // 这不违背上面那条——变的是地址，不是同一地址的结论；用完即弃，不留第二次。
    const warm = takeWarmProbe(url)
    if (warm) {
      console.log('用近期探测结果，跳过本轮探测:', url)
      applyProbeResult(warm, url)
      return
    }
    await runProbe(url, true)
  }

  /**
   * 加载失败时的恢复：先重探一次（结论可能过期，比如签名换了 / 源站改策略），
   * 重探还救不回来才退回线性阶梯继续盲试。返回 true 表示已接手（调用方别再报错）。
   */
  const escalateStrategyAndReload = (): boolean => {
    const url = videoUrl.value.trim()
    // **别白重探**：上一轮就是拿这条地址测的、而且三条通道全被实测证伪（fatal），
    // 那么同一条地址再测一遍必然是同样的结论，纯粹白等一整轮（单轮硬顶 12s，加起来就是用户
    // 看到的那「24s 才报错」）。地址真换了的话 url 会变，`reprobedFor !== url` 自然放行重探。
    const provenDead = probedUrl === url && diagnoseProbe(probeResult.value).severity === 'fatal'
    // MP4 不探测（见 applyStrategy），失败直接爬阶梯：对它重探只是白等一轮再得出同一个误判
    if (url && isProbeable(url) && isHlsUrl(url) && !ladderMode.value && reprobedFor !== url && !provenDead) {
      reprobedFor = url
      console.log('加载失败，重新探测连接方式')
      errorMessage.value = '加载失败，正在重新探测连接方式...'
      runProbe(url, true).then(() => deps.reload())
      return true
    }
    // 探测已经把三条通道全部实测证伪 → 不爬阶梯。阶梯那 5 级本就是同样这四种通道的排列组合，
    // 每级还各要等一次 15s 加载超时；爬完只是把「注定播不了」拖成一分多钟的转圈 + 反复重载
    //（每次 `videoKey++` 重建 `<video>`，看着就是页面一直在闪）。结论早就有了，直接交回上层报错。
    // 注意这一步在「重新取址」和「重探一次」之后：地址过期比通道判断错常见得多，那两条路要先走完
    if (diagnoseProbe(probeResult.value).severity === 'fatal') {
      console.warn('探测已实测证伪（三条通道全不可达），不再爬线性阶梯')
      return false
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

  // 探测矩阵读数（展开设置里展示，排查源站用）。渲染在 <ProbeMatrix>，与解析页共用一份
  const probeRows = computed(() => probeMatrixRows(probeResult.value))
  const probeVerdict = computed(() => diagnoseProbe(probeResult.value))

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

  /**
   * 作废近期探测结论 + 「本次加载已重探过」的标记。
   *
   * `warmProbes` 也必须清：它按完整 URL 存，但**不含候选头**。用户改了 Origin/Referer 之后
   * 不清的话，新填的域名压根没机会被试（直接命中上一次用旧候选值探出的结论），
   * 表现是「填了没反应」——这正是 CLAUDE.md 里记着的那个坑，只是缓存换了个地方。
   */
  const invalidateReachCache = () => { reprobedFor = ''; warmProbes.clear() }

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
    applyStrategy, escalateStrategyAndReload, applyReachabilityStep, prewarmProbe, takeSeededManifest,
    // 展示 / 操作
    strategyLabel, probeRows, probeVerdict, reprobeNow,
  }
}

export type VideoConnStrategy = ReturnType<typeof useVideoConnStrategy>
