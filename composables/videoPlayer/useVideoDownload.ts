/**
 * 下载（画面右上角那颗按钮 + 底部下载抽屉）。
 *
 * 分两条完全不同的路，因为浏览器的能力就是这么分的：
 *  · **HLS**（这些站几乎全是）→ 只能前端自己拉分片 + AES-128 解密 + 拼文件。
 *    `<a download>` 对 m3u8 只会下到那份几 KB 的清单文本，而 `download` 属性对**跨源** URL
 *    还会被浏览器静默忽略（变成导航，在标签页里直接播起来）。
 *  · **整片 MP4** → 走 `/api/proxy?dl=1` 交给**浏览器原生下载器**：断点续传、后台下载、
 *    关标签页也继续、零内存占用，比自己写一套强得多。
 *
 * 真正的下载循环在 `download/`（模块级单例，抽屉关掉/切集/离开这一页都接着跑）。
 * 这里只是薄壳：把队列包成 ctx 里的键，并回答「这一集能不能下、现在该开几条连接」。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoHandoff } from './useVideoHandoff'
import type { VideoEngine } from './useVideoEngine'
import type { VideoConnStrategy } from './useVideoConnStrategy'
import type { VideoPlaylistCtl } from './useVideoPlaylistCtl'
import * as queue from './download/downloadQueue'
import { pickDownloadDir, supportsDiskSink, safeFileName, DIR_BLOCKED_HINT } from './download/fileSink'

export interface VideoDownloadDeps {
  media: VideoMediaState
  handoff: VideoHandoff
  engine: VideoEngine
  conn: VideoConnStrategy
  playlist: VideoPlaylistCtl
  /** 输出格式这类设置要落 localStorage（`video-player-state`） */
  onDirty: () => void
}

export function useVideoDownload(deps: VideoDownloadDeps) {
  const { media, handoff, engine, conn, playlist } = deps

  /** 全速下载：默认关。开着就不再给播放让路（用户明确要「先下完再说」时才该勾） */
  const dlFullSpeed = ref(false)

  /**
   * 输出 MP4（重封装）还是 `.ts`（原样拼）。**默认 MP4**：`.ts` 只有 VLC / mpv / PotPlayer 认，
   * QuickTime、Windows「电影和电视」、手机相册、微信、浏览器一概打不开，而下完之后
   * 「传手机上看 / 发给别人」正是主要用途。
   *
   * 留这个开关是因为 MP4 多一层 mux.js：源里贴片和正片编码参数不一样时那一层有翻车的可能，
   * 而 `.ts` 是字节原样落盘、最不会出事的那条路（出问题时的退路）。
   */
  const dlMp4 = ref(true)
  watch(dlMp4, () => deps.onDirty())

  /** 选文件夹这一步的结果提示（选到哪个 / 为什么没选上）。抽屉里显示，点开始时清掉 */
  const dlNotice = ref('')
  /** 已授权的文件夹名，让用户知道东西存哪儿了，也是「换一个」的锚点 */
  const dlDirName = ref('')

  /**
   * 「这一集是 HLS 还是整片 MP4」。
   *
   * 按需取址的站点列表里存的是**播放页占位地址**（`isM3u8Url` 一律为假），
   * 光看地址会把整站都判成 MP4 → 点下载弹出一个下不动的原生下载。
   * 有作业单就是那类站点，而它们全是 m3u8。
   */
  const kindOf = (url: string): 'hls' | 'mp4' =>
    (handoff.lazyTask.value && handoff.lazyIndexByUrl.value[url] !== undefined) || isM3u8Url(url)
      ? 'hls' : 'mp4'

  /**
   * FLV 不给下载：直播流没有终点（原生下载器会一直写到磁盘满），
   * 而它又必然被 `kindOf` 判成 `mp4` 走原生下载那条路。
   */
  const canDownload = computed(() =>
    playlist.playlist.value.length > 0 && !playlist.playlist.value.some(u => isFlvUrl(u)))
  /** 当前列表是不是整片 MP4（抽屉据此换成「交给浏览器下载」那一版） */
  const dlIsMp4 = computed(() => {
    const list = playlist.playlist.value
    return list.length > 0 && kindOf(list[0]!) === 'mp4'
  })

  /**
   * 这一拍允许几条连接。
   *
   * 「能不能播下去」全靠紧邻播放头那一两片（见 CLAUDE.md 那九级并发决策），
   * 所以下载器一律排在播放后面：没在播就放开，正在播就收着，缓冲一吃紧再收。
   * 它**不参与**引擎那套决策、也不往它的带宽账本里写数（污染分档采样会连累好几级）。
   *
   * **这几个数不是「同 host 6 条」那条老规矩推出来的**（那条只对 HTTP/1.1 成立，
   * 而分片 CDN 走 HTTP/2）。实测源站按连接限速、聚合到 16 条还在线性涨
   *（1 条 0.47MB/s → 16 条 6.0MB/s），所以「全速」给到 16；
   * 上限就是 `MAX_WORKERS`，别写得比它大（多出来的永远轮不到）。
   */
  const dlConcurrency = (): number => {
    if (dlFullSpeed.value) return 16
    if (!media.isPlaying.value) return 8
    return engine.strategy.value.healthZone === 'healthy' ? 3 : 2
  }

  /** 非空即「先停一下」，内容直接显示在任务行上 */
  const dlHoldReason = (): string => {
    if (dlFullSpeed.value) return ''
    if (media.isPlaying.value && engine.strategy.value.healthZone === 'panic') {
      return '画面正在缓冲，已暂缓下载'
    }
    return ''
  }

  /**
   * 把运行时依赖交给模块级队列。**每次装配都覆盖一次**（换了一部剧、刷新过页面，
   * 那些闭包要指向新的 ctx）；卸载时**不清空** —— 离开播放页时下载理应接着跑。
   */
  queue.setQueueRuntime({
    // 静默、给前台让路、死线更短的那一版取址：前台那版会盖上「正在获取播放地址」的转圈遮罩，
    // 用在后台下载上等于正播着的这一集突然被一块遮罩盖住
    resolveUrl: ph => playlist.peekLazyUrl(ph),
    /*
     * 防盗链候选值取 `xxxHint` 而不是生效值 `requestOrigin`：后者是「正在播的这一集」
     * 探测出来的结论，而下载要跑几分钟、中途还会切集，读它就会漂。
     * 候选值是整条线路共用的（解析那一下拿到的），对这部剧的每一集都成立。
     */
    origin: () => conn.originHint.value || conn.requestOrigin.value,
    referer: () => conn.refererHint.value || conn.requestReferer.value,
    getSegBuf: engine.getSegBuf,
    concurrency: dlConcurrency,
    holdReason: dlHoldReason,
    wantMp4: () => dlMp4.value,
  })

  const dlTasks = queue.tasks
  const dlRunning = queue.running
  const dlPending = computed(() => queue.pendingCount())
  /** 桌面 Chrome/Edge 才有流式写盘。面板上要如实标出来，否则体积上限只会被当成 bug */
  const dlStreaming = computed(() => supportsDiskSink())

  /**
   * 集数的显示写法。**纯数字的补成「第02集」**：站点给的集名多半就是个孤零零的 `2`，
   * 单独摆在文件名最前面看不出是什么（同 `currentVideoName` 的规矩）。
   *
   * 顺带**补零到跟总集数一样宽**（至少 2 位）：不补的话文件管理器按字典序排成
   * 第1集、第10集、第11集、…、第2集，而「集数放前面」本来就是为了让同一部剧顺着排。
   * 不是纯数字的（「第一季01」「上」「下」）原样保留 —— 那些本来就说得清，硬套只会更难认。
   */
  const epLabelOf = (ep: string, total: number): string => {
    if (!/^\d+$/.test(ep)) return ep
    return `第${ep.padStart(Math.max(2, String(total).length), '0')}集`
  }

  /** 文件名主体：**集数在前、剧名在后**（`第02集-现在不是出轨的问题`） */
  const fileBaseOf = (index: number): string => {
    const list = playlist.playlist.value
    const url = list[index]
    if (!url) return '视频'
    const ep = epLabelOf(handoff.getVideoName(url, index), list.length)
    return safeFileName(`${ep}-${handoff.playlistTitle.value || '视频'}`)
  }

  /**
   * 开始下载勾选的那几集。**必须在点击的同步调用栈里调**：
   * 目录授权弹窗要用户激活，`await` 之后再弹就弹不出来了。
   */
  const startDownload = async (indexes: number[]) => {
    const list = playlist.playlist.value
    const picked = indexes.filter(i => i >= 0 && i < list.length)
    if (!picked.length) return

    // 目录只请一次：一个手势覆盖整个队列。勾了 10 集要点 10 次保存框的话，
    // 后 9 次都发生在用户早已切走的时候（那时压根弹不出来）
    if (!queue.hasDownloadDir() && supportsDiskSink()) {
      dlNotice.value = ''
      const r = await pickDownloadDir()
      if (r.handle) {
        queue.setDownloadDir(r.handle)
        dlDirName.value = r.handle.name || ''
      } else if (r.canceled) {
        /*
         * **他点了取消 → 整个动作作废，别偷偷改用内存下载。**
         * 内存那条有 3GB 上限、手机上还可能被系统杀掉；而他之所以取消，
         * 很可能正是撞上了「无法打开此文件夹，因为其中含有系统文件」那个弹窗
         *（Chrome 的敏感目录黑名单）—— 这时候静默换一条更差的路，
         * 表现就是「下着下着莫名失败」，他压根不知道自己在用哪条路。
         */
        dlNotice.value = '没有选文件夹，下载没有开始。' + DIR_BLOCKED_HINT
        return
      } else if (r.error) {
        dlNotice.value = r.error + ' ' + DIR_BLOCKED_HINT
        return
      }
    }

    queue.enqueue(picked.map(i => ({
      // 任务行上只显示集数（「第02集」），不重复剧名 —— 抽屉标题栏上已经有了；
      // 文件名走 fileBaseOf，那份要带剧名（文件是要离开这个页面的）
      epName: epLabelOf(handoff.getVideoName(list[i]!, i), list.length),
      fileBase: fileBaseOf(i),
      placeholder: list[i]!,
    })))
  }

  /**
   * 整片 MP4：拼一个 `dl=1` 的代理地址交给浏览器。
   * 返回 href 让模板直接绑在 `<a download>` 上 —— `a.click()` 也必须在手势调用栈里同步发生。
   */
  const mp4DownloadHref = (index: number): string => {
    const list = playlist.playlist.value
    const url = list[index]
    if (!url) return ''
    const params = new URLSearchParams({ url, dl: '1', name: fileBaseOf(index) + '.mp4' })
    const o = conn.originHint.value || conn.requestOrigin.value
    const r = conn.refererHint.value || conn.requestReferer.value
    if (o) params.set('origin', o)
    if (r) params.set('referer', r)
    if (!o && !r) params.set('noref', '1')
    return '/api/proxy?' + params.toString()
  }

  /**
   * 换一个保存文件夹（也是「上次选错了」的出口）。同样必须在点击的调用栈里调。
   * 换不成就保持原来那个，别把已经能用的授权弄丢。
   */
  const pickDownloadFolder = async () => {
    dlNotice.value = ''
    const r = await pickDownloadDir()
    if (r.handle) {
      queue.setDownloadDir(r.handle)
      dlDirName.value = r.handle.name || ''
      dlNotice.value = `保存到「${dlDirName.value}」`
    } else if (r.canceled) dlNotice.value = ''
    else if (r.error) dlNotice.value = r.error + ' ' + DIR_BLOCKED_HINT
  }

  return {
    canDownload, dlIsMp4, dlTasks, dlRunning, dlPending, dlStreaming, dlFullSpeed, dlMp4,
    dlNotice, dlDirName, pickDownloadFolder,
    startDownload, mp4DownloadHref,
    cancelDownload: queue.cancel,
    clearFinishedDownloads: queue.clearFinished,
  }
}

export type VideoDownload = ReturnType<typeof useVideoDownload>
