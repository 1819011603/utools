/**
 * 播放列表：解析输入、切集、进度记忆、按需取址、就地刷新链接。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoHandoff } from './useVideoHandoff'

export interface VideoPlaylistDeps {
  media: VideoMediaState
  handoff: VideoHandoff
  /** 状态有变，持久化一次 */
  onDirty: () => void
  /** 把当前列表/集数写回地址栏 */
  syncUrl: () => void
  /** 加载 videoUrl 指向的视频 */
  loadVideo: () => Promise<void>
  /**
   * 把解析结果里的防盗链候选值交给连接策略。
   * conn 与 playlist 同级（都在 media/handoff 之上），不能互相 import，所以走回调。
   */
  applyHints: (origin?: string, referer?: string) => void
}

export function useVideoPlaylistCtl(deps: VideoPlaylistDeps) {
  const { media, handoff } = deps
  const { videoUrl, videoUrlInput, errorMessage, savedProgress } = media

  const playlist = ref<string[]>([])
  const currentIndex = ref(0)
  const hasPrev = computed(() => currentIndex.value > 0)
  const hasNext = computed(() => currentIndex.value < playlist.value.length - 1)

  const isRefreshingLinks = ref(false)
  const lastRefreshAt = ref(0)

  // ── 进度记忆 ──

  /**
   * 进度存取用的键。
   *
   * 普通列表里 playlist[currentIndex] 就等于 videoUrl，取哪个都一样；
   * 但按需取址的站点每次现取到的真实地址都不同（带时效签名），拿它当键等于每次都查不到，
   * 所以一律用播放列表里那个稳定的占位地址。没有播放列表时（直接贴地址播）退回 videoUrl。
   */
  const progressKey = (): string => playlist.value[currentIndex.value] || videoUrl.value

  /**
   * 当前这一集的显示名。理由与 progressKey 完全相同——集名也是按「列表里那条地址」存的，
   * 而按需取址时 videoUrl 是现取的真实地址（每次都不同），拿它去查 playlistNames 必然落空，
   * 退化成显示 `ec54d9af…m3u8` 这种文件名，可播放列表里同一集却好端端写着「1」（踩过）。
   */
  const currentVideoName = computed(() => {
    const name = handoff.getVideoName(progressKey(), currentIndex.value)
    // 站点给的集名多半就是个纯数字（「1」「10」），标题栏上孤零零一个「1」看不出是什么。
    // 只在这里补成「第N集」：播放列表格子窄、一屏要摆几十个，那边保持纯数字。
    return /^\d{1,4}$/.test(name) ? `第${name}集` : name
  })

  /**
   * 「这集算看完了」的位置：片尾区的起点（至少留 5 秒，`skipOutro` 关着时就是结尾附近）。
   * 越过它就不该再记进度——记下来下次进这集会从片尾恢复，一恢复就又落进「跳过片尾」的判据里，
   * 当场被弹到下一集，**这集永远看不成**（踩过：看到 22 集后回头点 21 集，播完自动进 22 集又被弹走）。
   */
  const finishedThreshold = (): number => {
    const dur = media.duration.value
    return dur > 0 ? dur - Math.max(5, media.skipOutro.value) : Infinity
  }

  const saveCurrentProgress = () => {
    const key = progressKey()
    if (!key || media.currentTime.value <= 0) return   // 还没播就别动已有记录（切集时会经过这里）
    if (media.currentTime.value >= finishedThreshold()) {
      // 看完了：清掉记录，下次从头开始
      if (savedProgress.value[key] !== undefined) {
        delete savedProgress.value[key]
        deps.onDirty()
      }
      return
    }
    savedProgress.value[key] = media.currentTime.value
    deps.onDirty()
  }

  /** 起播后发现存的位置已经在片尾区（老版本留下的记录）时，就地作废 */
  const dropSavedProgress = (url: string) => {
    if (savedProgress.value[url] === undefined) return
    delete savedProgress.value[url]
    deps.onDirty()
  }

  const getSavedProgress = (url: string): number => savedProgress.value[url] || 0

  const clearAllProgress = () => {
    savedProgress.value = {}
    deps.onDirty()
  }

  // ── 按需取址 ──

  /**
   * 预热取到的地址（占位地址 → 真实地址）。只为「后台备好下一集」而存，见 useVideoPrewarm。
   *
   * TTL 很短且**用一次就删**：这类地址带时效签名，留久了下次拿出来就是死链，
   * 那比慢几秒糟得多——切过去之后没有补救路径（`reload()` 直接用 `videoUrl`，不会重新取址），
   * 表现是「自动跳到下一集，然后 403 卡死、也不自动播」。过期宁可现取。
   * 90s 是配合 useVideoPrewarm 那个 60s 提前量定的，正常路径上用到时地址不超过一分钟。
   */
  const LAZY_URL_TTL = 90_000
  const lazyUrlCache = new Map<string, { url: string; at: number }>()
  const clearLazyUrlCache = () => lazyUrlCache.clear()

  /**
   * 取址的硬超时。这一步没有终点是**致命**的：转圈遮罩挂在 isResolvingUrl 上，
   * 卡住就表现成「点了下一集，一直显示正在获取播放地址」，用户除了刷新没有任何出路。
   * 30s 比任何正常取址都宽（慢站抓页实测 5-10s），到点就报错，让人知道是站点没给。
   */
  const RESOLVE_TIMEOUT = 30_000
  /**
   * 用户点了之后最多让他等这么久。**必须独立于底层那条 promise**：
   * 前台可能命中去重、复用一条正在排队让路的预热请求，那条的剩余寿命跟点击这一刻毫无关系。
   * 15s 是「还愿意等」的上限，到点就明确报错，比无声转圈强。
   */
  const FOREGROUND_TIMEOUT = 15_000
  /** 预热给前台让路的上限。让路本身不能变成新的等待源 */
  const GIVE_WAY_MAX = 3_000

  /**
   * 取址**同集去重 + 预热单向让路**。
   *
   * 「后台预热」和「用户点下一集」现在会同时想取址（预热窗口跟「看到片尾附近点下一集」高度重合），
   * 而 nbmovie 系的 wasm 签名要读页面上那个 `<meta id="nb-plt">` 当时间戳、每次签名前还要刷新它，
   * 两发并发会互相踩（其中一发拿到过期时间戳 → 401）。两条规矩：
   *   · **同集去重**：点的正是预热在取的那一集 → 直接等那一发，不再多发一次请求
   *   · **预热让路**：预热要等在飞的取址跑完再开始；**反过来绝对不行**——
   *     让用户点击排在后台工作后面，最坏要干等一个 30s 超时，那比偶发 401 糟得多
   */
  const inflight = new Map<string, Promise<string>>()
  /** 在飞的取址（含预热），供预热判断「要不要让路」 */
  const pending = new Set<Promise<unknown>>()

  /** 只负责取址，不碰任何 UI；失败抛错，由调用方决定是报给用户还是咽下去 */
  const doFetchLazyUrl = async (placeholder: string): Promise<string> => {
    const idx = handoff.lazyIndexByUrl.value[placeholder]
    // 取址时站点会带回最新的防盗链域名（它是从站点播放器配置里现取的、会变）
    const hintOpts = { onHints: deps.applyHints }
    try {
      return await resolveOneUrl(handoff.lazyTask.value!, idx!, hintOpts)
    } catch (e) {
      // 作业单里的令牌是源站按次渲染的、会过期。知道来源页面就重解析一次拿新作业单再试，
      // 只重试一次——真失效和真限流表现一样，无限重试只会把限流坐实。
      const src = handoff.playlistSource.value
      if (!src) throw e
      const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line })
      if (!result.clientTask?.lazy) throw e
      // 集数可能变了，按集名把下标对回来；对不上就退回原下标
      const names = (result.lines[result.activeLineIndex]?.episodes ?? []).map(ep => ep.title)
      const want = handoff.playlistNames.value[placeholder]
      const hit = want ? names.indexOf(want) : -1
      handoff.lazyTask.value = result.clientTask
      return await resolveOneUrl(result.clientTask, hit >= 0 ? hit : idx!, hintOpts)
    }
  }

  /**
   * 占位地址 → 真实播放地址（去重 + 让路 + 超时）。不是占位地址就原样返回。
   *
   * 为什么不把结果存进播放列表：这类地址带时效签名，存下来下次进来就是死链，
   * 而且站点限流，与其提前批量取被封，不如播一集取一集（站点自己也是这么做的）。
   */
  const fetchLazyUrl = (placeholder: string, giveWay = false): Promise<string> => {
    const idx = handoff.lazyIndexByUrl.value[placeholder]
    if (!handoff.lazyTask.value || idx === undefined) return Promise.resolve(placeholder)

    const cur = inflight.get(placeholder)
    if (cur) return cur

    const withTimeout = () => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`取址超时（${RESOLVE_TIMEOUT / 1000}s 没有响应），站点可能在限流`)),
        RESOLVE_TIMEOUT,
      )
      doFetchLazyUrl(placeholder).then(resolve, reject).finally(() => clearTimeout(timer))
    })

    // 让路要有上限：allSettled 而不是 all（让路只是「等它们不再占着站点」，别人失败不该连坐），
    // 再跟一个 3s 的闹钟赛跑。不封顶的话「让路 30s + 自己 30s」能叠成一分钟，
    // 而前台点击一旦命中去重、复用的正是这条在排队的 promise，就成了「点下一集一直转」（踩过）
    const p = giveWay && pending.size
      ? Promise.race([
        Promise.allSettled([...pending]),
        new Promise(r => setTimeout(r, GIVE_WAY_MAX)),
      ]).then(withTimeout)
      : withTimeout()

    inflight.set(placeholder, p)
    pending.add(p)
    const drop = () => { inflight.delete(placeholder); pending.delete(p) }
    p.then(drop, drop)
    return p
  }

  /**
   * 前台取址：转圈遮罩、计秒文案、错误文案都归它管（后台预热绝不能碰这三样）。
   *
   * 遮罩上**要报秒数**：慢站取址本来就要好几秒，一个不动的「正在获取播放地址…」既看不出
   * 是在跑还是卡死了，也没法归因（用户只会说「一直在获取」）。
   */
  const resolveWithUi = async (placeholder: string): Promise<string> => {
    media.isResolvingUrl.value = true
    errorMessage.value = ''
    const t0 = performance.now()
    const tick = () => {
      media.resolveStage.value = `正在获取播放地址…${Math.round((performance.now() - t0) / 1000)}s`
    }
    tick()
    const timer = setInterval(tick, 1000)
    try {
      // 死线跟着这次点击走，不跟着底层那条 promise（它可能是别人的、已经排了很久的）
      return await Promise.race([
        fetchLazyUrl(placeholder),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`等了 ${FOREGROUND_TIMEOUT / 1000}s 还没拿到地址，站点可能在限流`)),
          FOREGROUND_TIMEOUT,
        )),
      ])
    } catch (e: any) {
      errorMessage.value = '获取播放地址失败：' + (e?.message || '未知错误')
      return ''
    } finally {
      clearInterval(timer)
      media.resolveStage.value = ''
      media.isResolvingUrl.value = false
    }
  }

  /** 预热的地址还在不在（只为日志，别拿它做分支——判过之后可能就过期了） */
  const hasWarmLazyUrl = (placeholder: string): boolean => {
    const warm = lazyUrlCache.get(placeholder)
    return !!warm && Date.now() - warm.at < LAZY_URL_TTL
  }

  /** 真正要播这一集时调。预热过就直接用那份（切集的大头就是这一发请求） */
  const resolveLazyUrl = async (placeholder: string): Promise<string> => {
    const warm = lazyUrlCache.get(placeholder)
    lazyUrlCache.delete(placeholder)   // 一次性：留着只会在下次拿出一条过期签名
    if (warm && Date.now() - warm.at < LAZY_URL_TTL) return warm.url
    return await resolveWithUi(placeholder)
  }

  /**
   * 播不动了 → 就地重新取一次地址。返回 true 表示已换上新地址并重载（调用方别再报错）。
   *
   * 治的是「预热/交接槽里的签名地址已经过期」这一类：加载 10s 没数据、或 hls 网络错误重试用尽时，
   * 无论换哪条通道都是 403，而重探一轮要好几秒、还可能连着走完线性阶梯 5 级，全是白等。
   * 地址过期比通道判断错常见得多，所以这一步要排在重探**前面**。
   *
   * 每集只硬取一次（refetchedFor）：真失效和真限流表现一样，反复取只会把限流坐实，
   * 还会「取址 → 失败 → 再取址」原地打转。
   *
   * silent：给「加载 10s 没数据」那一档用。那一档**必然会误伤**——慢源的 manifest 本身
   * 就可能要十几秒，它并没有死。所以那时候绝不能亮出「正在获取播放地址」的转圈遮罩：
   * 误判时用户只是白发一发后台请求，什么都看不见；亮出来就变成「视频刚开始点下一集，
   * 一直显示获取中」（踩过）。hls 网络错误重试用尽那条相反，确实该告诉用户在干什么。
   */
  let refetchedFor = ''
  const refetchCurrentUrl = async (silent = false): Promise<boolean> => {
    const ph = playlist.value[currentIndex.value]
    if (!ph || refetchedFor === ph) return false
    // 不是按需取址的列表：地址就是用户/解析给的那条，无从「重取」
    if (!handoff.lazyTask.value || handoff.lazyIndexByUrl.value[ph] === undefined) return false

    refetchedFor = ph
    lazyUrlCache.delete(ph)          // 预热那份显然不好使了
    console.log('加载不顺，后台重新获取播放地址:', ph)
    const fresh = silent
      ? await fetchLazyUrl(ph).catch(e => { console.warn('后台重取地址失败:', e?.message || e); return '' })
      : await resolveWithUi(ph)
    // 取回来还是同一条 → 不是过期问题，交回上层去重探连接方式
    if (!fresh || fresh === videoUrl.value) return false

    videoUrl.value = fresh
    errorMessage.value = ''
    media.isRestoringFromSaved.value = true
    await deps.loadVideo()
    return true
  }

  /**
   * 后台预热：静默取址并存起来，供随后的 resolveLazyUrl 秒取。已有未过期的就不重复发请求。
   * 失败只写日志——预热是锦上添花，任何提示都会让用户以为正播着的这一集出了问题。
   */
  const peekLazyUrl = async (placeholder: string): Promise<string> => {
    const warm = lazyUrlCache.get(placeholder)
    if (warm && Date.now() - warm.at < LAZY_URL_TTL) return warm.url
    try {
      const url = await fetchLazyUrl(placeholder, true)   // 让路：前台取址优先
      if (url && url !== placeholder) lazyUrlCache.set(placeholder, { url, at: Date.now() })
      return url
    } catch (e: any) {
      console.warn('预热取址失败（不影响当前播放）:', e?.message || e)
      return ''
    }
  }

  // ── 切集 ──

  /**
   * 解析多行输入并加载。
   * startIndex 只由代码调用时传（?index=N）；模板里当事件回调用，首参是 Event，故做类型判断。
   */
  const parseAndLoad = async (startIndex?: number | Event) => {
    const input = videoUrlInput.value.trim()
    if (!input) return

    const urls = input
      .split(/[\n\r]+/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && (line.startsWith('http') || line.startsWith('//')))

    if (urls.length === 0) {
      errorMessage.value = '未找到有效的视频链接'
      return
    }

    // 手工贴进来的地址跟上一份来源没关系了，附加信息（作业单/来源/集名）留着只会张冠李戴：
    // 作业单的占位地址对不上、来源会让地址栏写成上一部剧的 parseUrl，分享出去驴唇不对马嘴。
    //
    // 判据是「这批地址不全认识」而不是「列表变了」：onMounted 走 query 进来时也经过这里，
    // 而那份 meta 是刚从交接槽读出来的，按「列表变了」清会把它冲掉
    //（踩过一次，表现为播放列表一排 index.m3u8）。
    // 注意要赶在 playlist 被覆盖**之前**判，否则 includes 恒真、等于没判。
    const known = (u: string) =>
      handoff.lazyIndexByUrl.value[u] !== undefined ||
      handoff.playlistNames.value[u] !== undefined ||
      playlist.value.includes(u)
    if (!urls.every(known)) { handoff.clearHandoffMeta(); clearLazyUrlCache() }

    playlist.value = urls
    const from = typeof startIndex === 'number' && startIndex >= 0 && startIndex < urls.length ? startIndex : 0
    currentIndex.value = from

    deps.onDirty()
    await playByIndex(from)
  }

  /**
   * 切集期间的门闩。
   *
   * 切一集是**异步**的（按需取址一发请求 + 重建 hls.js，慢站点好几秒），而这期间旧的 `<video>`
   * 还在原地播、`timeupdate` 照常每秒 4 次地打出来——「跳过片尾」正是挂在 timeupdate 上判的，
   * 条件（剩余时间 ≤ 阈值）在整个切集过程中一直成立，于是 playNext 被连着调十几次，
   * 每次都 +1 集。实测安卓上「第 15 集触发跳片尾 → 直接落到第 30 集」，正好是这几秒里跑掉的量。
   * 用户手速快连点两下「下一集」是同一个问题的轻症版。
   */
  let switching = false
  /**
   * 切集中又来了新目标（latest-wins）。
   *
   * 原来是 `if (switching) return`——**静默丢弃**。防跳片尾连跳那件事它做到了，
   * 但用户连点两下「下一集」只跳一集、在选集面板上急着改主意点了别的集也没反应，
   * 看着就是「点了没用」。现在把最新目标记下来，本轮落地后若目标变了就接着切过去：
   * 门闩仍然只允许一轮在飞（跳片尾那十几次重复调用照旧被吸收——它们的目标都是同一集，
   * 记下来也等于没变），但用户的最后一次点击一定会兑现。
   */
  let queuedIndex: number | null = null
  /** 切集中（含取址/探测/建流）。UI 据此给上/下一集按钮上 loading，别只有画面中央一个转圈 */
  const isSwitching = ref(false)

  const playByIndex = async (index: number) => {
    if (index < 0 || index >= playlist.value.length) return
    if (switching) { queuedIndex = index; return }
    switching = true
    isSwitching.value = true
    try {
      await doPlayByIndex(index)
      // 排队的目标可能又被后来的点击改过，所以是 while 而不是 if；
      // 每一轮都先把槽清空，避免「切到 A 的过程中又点了 A」自己跟自己循环。
      //
      // 连排上限：`playNext` 也被「播完自动下一集」和「跳过片尾」调，
      // 而一个坏源可能一 attach 就立刻 `ended`——那时每一集都会往槽里塞下一集，
      // 于是整份列表被飞快走完（用户看到集数自己一路涨）。原来那句 `if (switching) return`
      // 顺带把这种情况挡掉了，改成排队就得自己封顶。3 次足够覆盖「手快连点几下」。
      let drained = 0
      while (queuedIndex !== null && queuedIndex !== currentIndex.value && drained++ < 3) {
        const next = queuedIndex
        queuedIndex = null
        await doPlayByIndex(next)
      }
    } finally {
      queuedIndex = null
      switching = false
      isSwitching.value = false
    }
  }

  const doPlayByIndex = async (index: number) => {
    saveCurrentProgress()
    currentIndex.value = index
    refetchedFor = ''   // 换了一集，「重新取址」的额度重新给一次

    // 按需取址的站点：列表里是占位地址，真实地址现取（拿不到就别往下走，
    // 否则 hls.js 会去加载源站的 HTML 页面，报一个完全看不懂的解析错）
    const t0 = performance.now()
    const warmHit = hasWarmLazyUrl(playlist.value[index])
    const realUrl = await resolveLazyUrl(playlist.value[index])
    if (!realUrl) return
    // 切集慢在哪一段，光看转圈看不出来 → 把取址耗时和「预热有没有命中」打出来
    console.log(`切集取址 ${Math.round(performance.now() - t0)}ms（预热${warmHit ? '命中' : '未命中'}）`)

    videoUrl.value = realUrl
    media.hasSkippedIntro.value = false

    deps.onDirty()
    deps.syncUrl()   // 地址栏跟着当前集数走，随时可复制分享

    // 切换集数时标记需要自动播放（MP4 在 onCanPlay 中触发，HLS 在 MANIFEST_PARSED 中已有）
    media.isRestoringFromSaved.value = true

    await deps.loadVideo()
  }

  /**
   * 从「源站播放页地址 + 线路」现场解析出整份播放列表并起播（`?parseUrl=…&line=N&index=M`）。
   *
   * 这是分享链接的落地点：别人拿到链接时本机没有交接槽，列表得自己解析出来。
   * 与「刷新链接」共用 resolvePlaylist（工作量证明 / 分批续拉 / 作业单都在里面），
   * 两处各写一份必然漂移。
   */
  const loadFromParseSource = async (
    pageUrl: string,
    line = 0,
    index = 0,
    lineName?: string,
    epName?: string,
  ) => {
    media.isResolvingUrl.value = true
    media.resolveStage.value = '正在获取页面…'
    errorMessage.value = ''
    try {
      const rules = loadUserParseRules()
      // 慢站点要好几秒，逐段告诉用户在干什么（反爬校验、解析选集…）
      const onStage = (t: string) => { media.resolveStage.value = t }

      let { result } = await resolvePlaylist({ pageUrl, line, rules, onStage })

      // 线路按名字认，序号只是兜底：源站增删线路后序号就指到别的线路去了，
      // 而链接是拿来分享的、寿命以天计。名字对不上才多花一次请求换条线路重解析。
      if (lineName) {
        const want = result.lines.findIndex(l => l.name === lineName)
        if (want >= 0 && want !== result.activeLineIndex) {
          onStage(`正在切换到「${lineName}」…`)
          ;({ result } = await resolvePlaylist({ pageUrl, line: want, rules, onStage }))
        }
      }

      const { urls, names } = toPlaylist(result)
      if (!urls.length) throw new Error('没有解析出可播放的地址')

      // 上一份列表的集名/作业单/来源一律作废——这是一份全新的列表（预热的地址跟着旧作业单，一并扔）
      handoff.clearHandoffMeta()
      clearLazyUrlCache()
      playlist.value = urls
      handoff.setPlaylistNames(urls, names)
      handoff.setLazyTask(result.clientTask?.lazy ? result.clientTask : null, urls)
      if (result.title) handoff.playlistTitle.value = result.title
      // 线路记解析结果实际用的那条：传入的 line 越界时服务端会退回 active 线路，
      // 记成传入值会让地址栏与实际播的对不上，分享出去又是另一条线路
      handoff.playlistSource.value = {
        pageUrl,
        line: result.activeLineIndex,
        lineName: result.lines[result.activeLineIndex]?.name || undefined,
      }

      // 这类站点的防盗链常认播放页域名，而视频挂在毫不相干的 CDN 上，光看视频地址推不出来。
      // 只是候选值，探测仍从直连起逐级降级（见 CLAUDE.md「连接方式只有一个来源」）
      const srcOrigin = (() => { try { return new URL(pageUrl).origin } catch { return '' } })()
      deps.applyHints(result.origin || srcOrigin, result.referer || (srcOrigin ? srcOrigin + '/' : ''))

      videoUrlInput.value = urls.join('\n')
      // 集数同样按名字认：源站往中间插一集（实测 ylsp 有「虚天战纪上/下」这种加塞），
      // 后面每一集的下标都会挪位，光靠 index 分享出去就是另一集
      const byName = epName ? names.indexOf(epName) : -1
      const from = byName >= 0 ? byName : (index >= 0 && index < urls.length ? index : 0)
      currentIndex.value = from
      deps.onDirty()
      media.isRestoringFromSaved.value = true
      await playByIndex(from)
    } catch (e: any) {
      const msg = e?.statusMessage || e?.data?.statusMessage || e?.message || '未知错误'
      errorMessage.value = `解析播放列表失败：${msg}`
    } finally {
      media.isResolvingUrl.value = false
      media.resolveStage.value = ''
    }
  }

  const playPrev = async () => { if (hasPrev.value) await playByIndex(currentIndex.value - 1) }
  const playNext = async () => { if (hasNext.value) await playByIndex(currentIndex.value + 1) }

  const clearPlaylist = () => {
    playlist.value = []
    handoff.clearHandoffMeta()
    clearLazyUrlCache()
    currentIndex.value = 0
    videoUrlInput.value = ''
    deps.syncUrl()
  }

  const loadExample = async (url: string) => {
    videoUrlInput.value = url
    await parseAndLoad()
  }

  // ── 刷新链接 ──

  /**
   * 就地重新解析当前播放列表，换成新链接。
   *
   * 动机：部分线路给的是带签名的地址（`?sign=…&timestamp=…`），过一阵会失效，
   * 表现为好好播着突然 403。此时不必回解析页重来一遍，用交接槽里带过来的
   * 「源页面地址 + 线路」原地重解析即可。
   *
   * 三个要点：
   *   · 按集名认当前集，不按下标——重解析后可能多出或少掉几集，下标会错位
   *   · 播放进度是按 URL 存的，地址一换就查不到了，所以要手动搬到新地址上
   *   · 只有当前这一集需要重载；其余集的新地址进列表即可，切过去时自然生效
   */
  const refreshPlaylistLinks = async () => {
    const src = handoff.playlistSource.value
    if (!src || isRefreshingLinks.value) return

    isRefreshingLinks.value = true
    const toast = useToast()
    try {
      // 用户自定义规则要带上：服务端没有 localStorage，不带的话自定义规则的站点刷不动
      const { result } = await resolvePlaylist({ pageUrl: src.pageUrl, line: src.line, rules: loadUserParseRules() })
      const { urls, names } = toPlaylist(result)
      if (!urls.length) throw new Error('没有解析出可播放的地址')

      // 刷新前后按「集名 → 地址」对照，才能说清到底变了什么。
      // 只报「已刷新 N 集」等于没说：用户要知道的是地址换没换、集数多没多
      const before = new Map<string, string>()
      playlist.value.forEach((u, i) => before.set(handoff.playlistNames.value[u] ?? `#${i}`, u))
      let changed = 0
      let added = 0
      names.forEach((n, i) => {
        const old = before.get(n)
        if (old === undefined) added++
        else if (old !== urls[i]) changed++
      })
      const removed = [...before.keys()].filter(n => !names.includes(n)).length

      // 认名字而不是下标：集数可能变了
      const curUrl = playlist.value[currentIndex.value] ?? ''
      const curName = handoff.playlistNames.value[curUrl] ?? ''
      const hit = curName ? names.indexOf(curName) : -1
      const nextIndex = hit >= 0 ? hit : Math.min(currentIndex.value, urls.length - 1)
      const curChanged = urls[nextIndex] !== curUrl

      // 进度按 URL 存，换地址等于丢进度 → 先把当前时间搬到新地址上，
      // 后面 loadVideo 里的 getSavedProgress 就能原位续播
      const pos = media.videoEl.value?.currentTime ?? media.currentTime.value
      if (curChanged && pos > 0) savedProgress.value[urls[nextIndex]] = pos

      playlist.value = urls
      handoff.setPlaylistNames(urls, names)
      // 作业单里的令牌是源站按次渲染的，会过期 → 刷新时一并换成新的
      handoff.setLazyTask(result.clientTask?.lazy ? result.clientTask : null, urls)
      clearLazyUrlCache()   // 预热的地址是用旧令牌取的，跟着一起作废
      if (result.title) handoff.playlistTitle.value = result.title
      // 线路名跟着刷新一起更新：源站改了线路名的话，地址栏里那份得跟上，
      // 否则下次按名字认线路会落空、白白多解析一轮
      handoff.playlistSource.value = {
        ...src,
        line: result.activeLineIndex,
        lineName: result.lines[result.activeLineIndex]?.name || src.lineName,
      }
      currentIndex.value = nextIndex
      lastRefreshAt.value = Date.now()
      deps.onDirty()
      deps.syncUrl()

      // 当前这集地址没变就别重载：正播着呢，重载纯属打断。
      // 按需取址的列表里存的是永不变的占位地址，curChanged 恒为 false，
      // 正好就是想要的行为——刷新只为把新增的集数和新令牌收进来，不该打断播放
      if (curChanged) {
        const next = await resolveLazyUrl(urls[nextIndex])
        if (next) {
          videoUrl.value = next
          media.isRestoringFromSaved.value = true
          await deps.loadVideo()
        }
      }

      if (!changed && !added && !removed) {
        toast.add({
          title: '链接没有变化',
          description: `共 ${urls.length} 集，源站给的还是原来的地址`,
          color: 'blue',
          timeout: 3000,
        })
      } else {
        const parts: string[] = []
        if (changed) parts.push(`${changed} 集换了新地址`)
        if (added) parts.push(`新增 ${added} 集`)
        if (removed) parts.push(`少了 ${removed} 集`)
        toast.add({
          title: '刷新完成：' + parts.join('，'),
          description: `共 ${urls.length} 集` + (curChanged ? '；当前这集已用新地址重新载入' : '；当前这集地址未变，未打断播放'),
          color: 'green',
          timeout: 4000,
        })
      }
    } catch (e: any) {
      const msg = e?.statusMessage || e?.data?.statusMessage || e?.message || '刷新失败'
      toast.add({ title: '刷新链接失败', description: msg, color: 'red', timeout: 6000 })
    } finally {
      isRefreshingLinks.value = false
    }
  }

  return {
    playlist, currentIndex, hasPrev, hasNext, isRefreshingLinks, lastRefreshAt, isSwitching,
    progressKey, currentVideoName, saveCurrentProgress, getSavedProgress, clearAllProgress,
    parseAndLoad, playByIndex, playPrev, playNext, clearPlaylist, loadExample, dropSavedProgress,
    resolveLazyUrl, peekLazyUrl, refetchCurrentUrl, refreshPlaylistLinks, loadFromParseSource,
  }
}

export type VideoPlaylistCtl = ReturnType<typeof useVideoPlaylistCtl>
