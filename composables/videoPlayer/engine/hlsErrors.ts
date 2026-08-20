/**
 * hls.js 的致命错误处理：网络错误重试 → 重新取址 → 重探通道；媒体错误恢复（带次数上限）。
 *
 * 从 useVideoEngine 拆出来（那边超了 500 行）。这一块的每个分支都对应一类踩过的坑，
 * 注释比代码长，挤在加载流程里会让流程本身看不见。内部实现模块，走显式相对 import。
 */
/**
 * 报错文案：探测已经实测证伪时，一律用它的结论顶掉笼统的兜底话术。
 *
 * 「加载超时」「链接无效或已过期」这些兜底只是猜，而 `diagnoseProbe` 手上有实测证据
 *（典型：源站已被 Cloudflare 下线，换哪条通道都一样）。更要紧的是**它得留在页面上**——
 * toast 会自己消失，用户回过神来想看原因时只剩一句猜的（踩过：「提醒一下就没了」）。
 */
import { isOffline, isRecovering, waitForNet } from './netWatch'

export const failMessageOf = (verdict: { severity: string; title: string; detail: string }, fallback: string): string =>
  verdict.severity === 'fatal' ? `${verdict.title}——${verdict.detail}` : fallback

const MAX_HLS_RETRY = 3
/**
 * 刚换过网/刚从断网恢复时的**快退重试**间隔（ms）。
 *
 * 这一档存在的理由：换网那几秒的失败跟源站、地址、通道全都无关，它只是「网还没通」。
 * 常态那档是 1s×3 共三秒就烧完额度，接着掉进「重新取址（封顶 30s）→ 重探通道（硬顶 12s）
 * → 销毁播放器」——而一次 Wi-Fi 切换本身就要好几秒，那条路必然全程白跑。
 * 所以恢复窗口内**不计额度、不进那条慢路径**，只按这三档越等越松地重试，
 * 窗口一过（见 netWatch.RECOVER_WINDOW_MS）自然回到常态那档，死链该报的还是会报。
 */
const RECOVER_BACKOFF_MS = [300, 600, 1200]
/**
 * `recoverMediaError()` 的次数上限。**必须有上限**：它重建 MediaSource 再从当前位置续拉，
 * 前提是「数据本身没问题、只是解码器状态坏了」。可如果取回来的字节压根不是视频
 *（实测被 Cloudflare 下线的源，每个分片都是同一张 20KB 诱饵图，见 server/api/proxy.ts 的
 * DEAD_SOURCE_LANDINGS），那就是「恢复 → 立刻再失败 → 再恢复」的死循环，
 * 屏幕上是**一直在闪**、永远出不来画面，而错误提示每次 2s 后自己清掉，用户连原因都看不到（踩过）。
 */
const MAX_MEDIA_ERROR_RECOVER = 3

export interface HlsErrorDeps {
  HlsLib: any
  getHls: () => any
  setError: (msg: string) => string
  /** 探测已实测证伪时用它的结论顶掉笼统的兜底话术 */
  failMessage: (fallback: string) => string
  /** 放弃：把 loading/buffering/loaded 三个状态收干净并销毁 */
  giveUp: () => void
  /** 2 秒后清掉那条「正在恢复」，但只在它没被别人改过时 */
  clearIfUnchanged: (msg: string) => void
  /** 就地重新取一次播放地址并重载。true = 已换新地址，别再往下走 */
  refetchUrl: () => Promise<boolean>
  /** 重探连接方式（或退回线性阶梯）并重载。true = 已接手 */
  escalateStrategy: () => boolean
  /** 非致命的缓冲停滞：货在手上却播不动，交给 stallRecovery 自救 */
  onBufferStalled: () => void
}

export function useHlsErrorHandler(deps: HlsErrorDeps) {
  const { HlsLib, getHls, setError, failMessage, giveUp } = deps
  const hlsRetryCount = ref(0)
  let mediaErrorRecovered = 0
  let recoverRetries = 0   // 恢复窗口内已经快退重试了几次（额度另算，不动 hlsRetryCount）
  const resetErrorCounters = () => { hlsRetryCount.value = 0; mediaErrorRecovered = 0; recoverRetries = 0 }

  /**
   * **成功一片就把网络重试额度还回去**（`FRAG_BUFFERED` 时调）。
   *
   * 额度的语义只能是「连续失败几次」，不能是「本次播放一共失败几次」（踩过：
   * 「网络卡顿之后完全不能加载」）。原来只在 `loadVideo` 里清一次，于是看片一小时里
   * 攒够 3 次偶发失败之后，**下一次任何网络抖动都直接落到 `recoverFromNetworkFailure`**
   * ——重新取址 + 重探通道全试完还是不行就 `giveUp()` 把 hls.js 整个销毁，
   * 而那时网络可能只是断了两秒。中间一直在正常播放，那 3 次早就不能算「连续」了。
   */
  const noteLoadOk = () => {
    if (hlsRetryCount.value) hlsRetryCount.value = 0
    mediaErrorRecovered = 0
    recoverRetries = 0
  }

  /**
   * 网络错误重试用尽后的恢复顺序：**重新取址 → 重探连接方式 → 才报错**。
   *
   * 顺序不能反。按需取址的站点给的是带时效签名的地址，过期之后无论走哪条通道都是 403，
   * 而重探一轮好几秒、探不出结论还会连着走完线性阶梯 5 级，全程是白等——
   * 用户看到的是「自动跳到下一集然后卡死在转圈上」。地址过期比通道判断错常见得多。
   */
  const recoverFromNetworkFailure = async (details: string) => {
    setError('链接可能已过期，正在重新获取播放地址...')
    if (await deps.refetchUrl()) return
    if (deps.escalateStrategy()) return
    setError(failMessage(details === 'manifestLoadError'
      ? '视频链接无效或已过期，请检查链接是否正确'
      : `网络错误: ${details}，链接可能已过期`))
    giveUp()
  }

  /** 具名（引用稳定）→ `waitForNet` 的幂等去重才起作用：断网期间每秒复发的错误只挂一个等待者 */
  const resumeAfterNet = () => { getHls()?.startLoad() }

  const onHlsError = (data: any) => {
    console.warn('HLS 错误:', data.type, data.details, 'fatal:', data.fatal)
    /*
     * **非致命错误不能一概丢掉**（踩过：这一行原来就是 `if (!data.fatal) return`）。
     * `bufferStalledError` 是非致命的、每秒复发，而它恰恰是「缓冲 305s 却一直转圈」
     * 那一幕的唯一线索：hls.js 卡在一个比 `maxBufferHole`(0.5s) 更大的空洞前面，
     * 自己的 nudge 跨不过去，就只能一直报给我们听——而我们连听都没听。
     * 现在把它接到 stallRecovery（见那个文件的两级出路）。
     */
    if (data.details === HlsLib.ErrorDetails.BUFFER_STALLED_ERROR) deps.onBufferStalled()
    if (!data.fatal) return
    switch (data.type) {
      case HlsLib.ErrorTypes.NETWORK_ERROR:
        /*
         * **本机断网不消耗重试额度，也绝不 giveUp**（踩过：切 Wi-Fi / 进电梯之后彻底不加载）。
         * 离线时 fetch 是立刻失败的，三次重试外加 1s 间隔一共两三秒就烧完，
         * 而一次网络切换动辄十几秒——于是它必然走到「重新取址 → 重探通道 → 销毁」那条路，
         * 每一步都在没有网的情况下白跑，最后把播放器拆了。而这跟源站、跟地址、跟通道全无关系。
         * 正确的动作是什么都别做，只等 online 事件（引擎那边同时会把 lane 熔断记录作废）。
         */
        if (isOffline()) {
          setError('网络已断开，恢复后会自动继续')
          // waitForNet 是幂等的（同一个函数体每次 new 出来的是新引用，所以这里用一个稳定的具名回调），
          // 而且「已经有网」时会下一拍直接跑——老的 waitForOnline 漏掉了这两点，
          // `online` 若恰好在挂监听之前发生，那一发 startLoad 就永远不会来
          waitForNet(resumeAfterNet)
          break
        }
        /*
         * **刚换过网/刚恢复：不计额度、不进慢路径，只快退重试。**
         *
         * 那几秒的失败只说明「网还没通」，跟源站、地址、通道都无关。常态那档三秒就烧完额度，
         * 接着「重新取址 → 重探通道 → 销毁播放器」每一步都在没网的情况下白跑
         *（这正是切 Wi-Fi 恢复得最慢的原因）。窗口一过自然回到下面那档，死链照样会报。
         */
        if (isRecovering() && recoverRetries < RECOVER_BACKOFF_MS.length) {
          const wait = RECOVER_BACKOFF_MS[recoverRetries++]!
          setError('网络已切换，正在重新连接...')
          setTimeout(() => { getHls()?.startLoad() }, wait)
          break
        }
        hlsRetryCount.value++
        if (hlsRetryCount.value <= MAX_HLS_RETRY) {
          setError(`网络错误，正在重试 (${hlsRetryCount.value}/${MAX_HLS_RETRY})...`)
          setTimeout(() => { getHls()?.startLoad() }, 1000)
        } else {
          void recoverFromNetworkFailure(data.details)
        }
        break
      case HlsLib.ErrorTypes.MEDIA_ERROR:
        mediaErrorRecovered++
        if (mediaErrorRecovered > MAX_MEDIA_ERROR_RECOVER) {
          // 恢复了几次还在同一个地方倒下 → 不是解码器状态坏了，是数据不对。
          // 继续恢复只会无限闪屏，停下来把原因说清楚才是有用的
          setError(failMessage('媒体解码持续失败：取回的数据不是可播的视频（源站可能已下线或返回了占位内容），换一条线路试试'))
          giveUp()
          break
        }
        {
          const msg = setError(`媒体错误，正在恢复 (${mediaErrorRecovered}/${MAX_MEDIA_ERROR_RECOVER})...`)
          getHls()?.recoverMediaError()
          // **只在这条提示还没被别人改过时才清掉**。不加这道判断，恢复失败得快的时候
          // 上一次的定时器会把刚写上去的「放弃原因」一起擦掉——表现正是「报了一下就没了」
          setTimeout(() => { deps.clearIfUnchanged(msg) }, 2000)
        }
        break
      default:
        setError('播放失败: ' + data.details)
        giveUp()
    }
  }

  return { onHlsError, resetErrorCounters, noteLoadOk, hlsRetryCount }
}
