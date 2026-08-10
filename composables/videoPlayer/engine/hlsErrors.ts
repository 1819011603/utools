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
export const failMessageOf = (verdict: { severity: string; title: string; detail: string }, fallback: string): string =>
  verdict.severity === 'fatal' ? `${verdict.title}——${verdict.detail}` : fallback

const MAX_HLS_RETRY = 3
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
}

export function useHlsErrorHandler(deps: HlsErrorDeps) {
  const { HlsLib, getHls, setError, failMessage, giveUp } = deps
  const hlsRetryCount = ref(0)
  let mediaErrorRecovered = 0
  const resetErrorCounters = () => { hlsRetryCount.value = 0; mediaErrorRecovered = 0 }

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

  const onHlsError = (data: any) => {
    console.warn('HLS 错误:', data.type, data.details, 'fatal:', data.fatal)
    if (!data.fatal) return
    switch (data.type) {
      case HlsLib.ErrorTypes.NETWORK_ERROR:
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

  return { onHlsError, resetErrorCounters, hlsRetryCount }
}
