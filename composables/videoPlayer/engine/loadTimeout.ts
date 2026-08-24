/**
 * 加载超时的两档闹钟。
 *
 * 第一档 10s：一个字节都没来 → **静默**后台重新取址（签名地址过期时换哪条通道都是 403）。
 * 第二档 15s：还是没来 → 认定加载超时，报错并销毁。
 *
 * 从 useVideoEngine 拆出来（那边超了 500 行）。内部实现模块，走显式相对 import。
 */
import { isOffline, isRecovering } from './netWatch'

// 加载超时：走服务端代理时需要更长，统一 15s
//（代理要先请求远端再返回，3s 往往不够，会误触 destroyHls 取消所有请求）
const LOAD_TIMEOUT = 15000
// 到这个点还没收到任何数据，先怀疑「地址本身死了」而不是通道选错了：
// 预热或按需取址拿到的签名地址会过期，过期后换哪条通道都是 403。比 LOAD_TIMEOUT 早，
// 这样重新取址那一次还能落在用户耐心之内（重取成功会把两个计时器一起重置）。
const STALE_URL_TIMEOUT = 10000

export interface LoadTimeoutDeps {
  /** 还在加载中吗（不在就别打扰） */
  isLoading: () => boolean
  /** 第一档：静默重新取址 */
  refetchUrl: () => void
  /** 第二档：报错收场 */
  onTimeout: () => void
}

/**
 * 断网时**两档闹钟都要顺延**（每 2s 回来看一眼），不能到点就照常开火：
 * 这两档判的是「地址死了」和「源站取不到」，而本机没网时它们的前提压根不成立——
 * 重新取址那一发同样发不出去（还要吃掉每集仅一次的额度），第二档更是直接销毁播放器。
 * 表现就是「进电梯十几秒出来，播放器已经报加载超时了」。
 */
const OFFLINE_RECHECK_MS = 2000
/**
 * 刚换过网时也各顺延一次（同上一段的道理）：换网那一刻起算 10s 就去重新取址，
 * 多半是白吃掉「每集一次」的取址额度——那时候取址那一发同样发不出去。
 * 只顺延**一次**，避免恢复窗口被反复续着而把真正的死链一直拖着不报。
 */
const RECOVER_DEFER_MS = 5000

export function useLoadTimeout(deps: LoadTimeoutDeps) {
  let loadTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  let staleUrlTimer: ReturnType<typeof setTimeout> | null = null
  let hasReceivedData = false

  const clearLoadTimeout = () => {
    if (loadTimeoutTimer) { clearTimeout(loadTimeoutTimer); loadTimeoutTimer = null }
    if (staleUrlTimer) { clearTimeout(staleUrlTimer); staleUrlTimer = null }
  }
  const startLoadTimeout = () => {
    clearLoadTimeout()
    hasReceivedData = false
    // 第一档：10s 一个字节都没来，可能是地址过期 → **静默**后台重新取址（每集一次额度，
    // 不是按需取址的列表直接返回 false）；取到不一样的地址才重载，那时 loadVideo 会把这两个
    // 计时器重新起一遍。
    //
    // 静默是硬要求：这一档**必然会误伤**——慢源的 manifest 本身就要十几秒，它没死。
    // 早先在这里写了句「正在重新获取播放地址」并拉起 isResolvingUrl，于是正常的慢加载
    // 也会盖上转圈遮罩，表现成「视频刚开始点下一集，一直显示获取中」（踩过）。
    let staleDeferred = false, timeoutDeferred = false   // 恢复窗口只让路一次，见 RECOVER_DEFER_MS
    const armStale = (ms: number) => {
      staleUrlTimer = setTimeout(() => {
        if (hasReceivedData || !deps.isLoading()) return
        if (isOffline()) { armStale(OFFLINE_RECHECK_MS); return }   // 没网 → 顺延，见 OFFLINE_RECHECK_MS
        if (isRecovering() && !staleDeferred) { staleDeferred = true; armStale(RECOVER_DEFER_MS); return }
        deps.refetchUrl()
      }, ms)
    }
    const armTimeout = (ms: number) => {
      loadTimeoutTimer = setTimeout(() => {
        if (hasReceivedData || !deps.isLoading()) return
        if (isOffline()) { armTimeout(OFFLINE_RECHECK_MS); return } // 同上：断网不算源站超时
        if (isRecovering() && !timeoutDeferred) { timeoutDeferred = true; armTimeout(RECOVER_DEFER_MS); return }
        deps.onTimeout()
      }, ms)
    }
    armStale(STALE_URL_TIMEOUT)
    armTimeout(LOAD_TIMEOUT)
  }
  const markDataReceived = () => {
    hasReceivedData = true
    clearLoadTimeout()
  }

  return { clearLoadTimeout, startLoadTimeout, markDataReceived }
}
