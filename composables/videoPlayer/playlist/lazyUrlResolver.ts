/**
 * 按需取址（`clientTask.lazy` 的站点）：占位地址 → 真实播放地址。
 *
 * 这类站点的播放列表里存的是**源站播放页地址占位**，真实地址每集现取、带时效签名。
 * 两类原因（见 CLAUDE.md「按需取址」）：nbmovie 系是站点限流，htmlRule 站点是逐集抓页太重。
 *
 * 这里管住这件事的全部复杂度：**同集去重 + 预热单向让路 + 三道超时 + 预热地址缓存 + 死地址自救**。
 * 从 useVideoPlaylistCtl 拆出来——那边只该管「列表、进度、切到第几集」。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoHandoff } from '../useVideoHandoff'

export interface LazyResolverDeps {
  media: VideoMediaState
  handoff: VideoHandoff
  /** 当前这一集在列表里的占位地址（`refetchCurrentUrl` 要用） */
  currentPlaceholder: () => string
  /** 把解析结果里的防盗链候选值交给连接策略 */
  applyHints: (origin?: string, referer?: string) => void
  /** 换上新地址后重载 */
  loadVideo: () => Promise<void>
}

export function useLazyUrlResolver(deps: LazyResolverDeps) {
  const { media, handoff } = deps
  const { videoUrl, errorMessage } = media

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
   * **后台预热的死线要比前台短**（前台 15s，这里 12s）。
   *
   * 预热是「顺手做掉」的事，没人等它，跑多久对它自己无所谓——但它会连累前台：
   * 同集去重会让用户那一下点击直接复用这条在飞的 promise（见 fetchLazyUrl），
   * 预热挂 30s 就意味着这 30s 里的每一次点击都被拴在一具尸体上。
   * 排成「预热 12s < 前台 15s」之后，被复用的那一发一定先死，前台还有时间自己重来。
   */
  const PREWARM_TIMEOUT = 12_000
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
  /** 这条占位地址现在有没有在飞的取址（前台据此判断「我复用的是别人那一发」） */
  const isInflight = (placeholder: string): boolean => inflight.has(placeholder)

  const fetchLazyUrl = (placeholder: string, giveWay = false, timeoutMs = RESOLVE_TIMEOUT): Promise<string> => {
    const idx = handoff.lazyIndexByUrl.value[placeholder]
    if (!handoff.lazyTask.value || idx === undefined) return Promise.resolve(placeholder)

    const cur = inflight.get(placeholder)
    if (cur) return cur

    const withTimeout = () => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`取址超时（${timeoutMs / 1000}s 没有响应），站点可能在限流`)),
        timeoutMs,
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
    // 死线跟着**这次点击**走，不跟着底层那条 promise（它可能是别人的、已经排了很久的）
    const raced = () => Promise.race([
      fetchLazyUrl(placeholder),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`等了 ${FOREGROUND_TIMEOUT / 1000}s 还没拿到地址，站点可能在限流`)),
        FOREGROUND_TIMEOUT,
      )),
    ])
    try {
      /*
       * **复用了后台预热那一发、而它失败了 → 自己立刻重来一次，别让用户再点一遍。**
       *
       * 同集去重是无条件的（`inflight.get()` 直接返回），这在预热健康时是对的（省一发请求，
       * 也避开 nbmovie 那个「两发并发抢 <meta id="nb-plt"> 时间戳 → 401」的坑）。
       * 但预热卡住时它就变成了陷阱：那条 promise 已经跑了十几秒、注定要超时，
       * 而这段时间里**每一次点击都会被拴到这具尸体上**，各自等满自己的 15s 然后报错。
       * 用户看到的就是「点了好几次下一集才切过去」——实测日志：
       *   预热取址失败（30s 超时）… 切集取址 10932ms（预热未命中）
       * 最后成功的那一发，正是预热咽气之后重发的。
       *
       * 重来的这一发不会撞上 401：走到这里说明在飞的那条已经出局（inflight 在它落定时就清了）。
       * 只重来一次——真限流和真失效表现一样，无限重试只会把限流坐实。
       */
      if (isInflight(placeholder)) {
        try {
          return await raced()
        } catch (e: any) {
          console.warn('复用的在飞取址失败，改自己重取一次:', e?.message || e)
          media.resolveStage.value = '上一发没回来，正在重新获取…'
        }
      }
      return await raced()
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
  /** 换了一集 → 「重新取址」的额度重新给一次（原来是切集处直接写这个变量） */
  const resetRefetchQuota = () => { refetchedFor = '' }
  const refetchCurrentUrl = async (silent = false): Promise<boolean> => {
    const ph = deps.currentPlaceholder()
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
      const url = await fetchLazyUrl(placeholder, true, PREWARM_TIMEOUT)   // 让路 + 更短死线：前台取址优先
      if (url && url !== placeholder) lazyUrlCache.set(placeholder, { url, at: Date.now() })
      return url
    } catch (e: any) {
      console.warn('预热取址失败（不影响当前播放）:', e?.message || e)
      return ''
    }
  }

  return { clearLazyUrlCache, resolveLazyUrl, peekLazyUrl, refetchCurrentUrl, hasWarmLazyUrl, resetRefetchQuota }
}
