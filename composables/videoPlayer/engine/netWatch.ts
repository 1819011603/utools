/**
 * 「网络变了」的唯一信号源。
 *
 * 恢复链路（hlsErrors 的重试额度、loadTimeout 的两档闹钟、fragLoader 的对冲、skipSegment）
 * 以前各自读 `navigator.onLine`，而**它恰好覆盖不到最慢的那个场景**：
 * Wi-Fi 换 AP、Wi-Fi→蜂窝 时 `onLine` 全程是 `true`，`online`/`offline` 一个都不发。
 * 于是 lane 熔断记录不作废（干等 30s 观察期）、重试额度 3×1s 飞快烧完 →
 * 「重新取址（封顶 30s）→ 重探通道（硬顶 12s）→ 销毁播放器」这条慢路径全程白跑，
 * 每一步都跟源站、地址、通道毫无关系。这就是「切网络恢复最慢」的来源。
 *
 * 所以这里把三个信号并成一个：
 *   · `online` / `offline` —— 真断网；
 *   · `navigator.connection` 的 `change` —— **换网**（NetworkInformation，Chromium/安卓有）；
 *   · 回前台 —— 移动端切走再回来常常已经换过网，而后台期间 `connection.change` 会被吞。
 *
 * 对外只有两个概念：**现在有没有网**（`isOffline`）和**刚刚是不是变过**（`isRecovering`）。
 * 后者是个短窗口，恢复那几秒里各处据此把节奏调快、把「地址死了/通道错了」那类判断全部让路。
 *
 * **不做主动 ping**：多发一个请求换不来任何信息，`hls.startLoad()` 本身就是最好的探针。
 *
 * 模块级单例（各处必须读到同一个窗口），内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/**
 * 一次网络变动后的「恢复窗口」时长。
 *
 * 实测一次 Wi-Fi→蜂窝 切换，从事件发出到第一个请求真能出去要好几秒（DHCP、路由、
 * 有的运营商还要过一次门户）。窗口比这个短就会在恢复真正完成之前关掉，
 * 那时的失败又会被当成「地址死了」，重新掉回慢路径——等于没改。
 * 也别调太大：窗口内我们不做重新取址/重探，真正的死链会被拖着晚报错。
 */
const RECOVER_WINDOW_MS = 8000

type NetCb = () => void

let inited = false
let lastChangeAt = 0
/** 上一次看到的连接特征，用来把 `change` 里的「带宽估计抖动」和「真的换网」分开 */
let lastConnSig = ''
const changeCbs = new Set<NetCb>()
/** `waitForNet` 的等待者。用 Set 存 = 天然幂等（同一个 cb 挂两次只算一次） */
const waiters = new Set<NetCb>()

export const isOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false

/** 刚刚变过网（含刚从断网恢复）→ 各处把节奏调快、别急着下「地址死了」的结论 */
export const isRecovering = (): boolean =>
  !!lastChangeAt && Date.now() - lastChangeAt < RECOVER_WINDOW_MS && !isOffline()

const connOf = (): any => (typeof navigator !== 'undefined' ? (navigator as any).connection : null)

/** 连接特征：只取会随「换网」变的两项。`downlink`/`rtt` 是估算值，一直在抖，取了就等于窗口永不关闭 */
const connSig = (): string => {
  const c = connOf()
  return c ? `${c.type ?? ''}/${c.effectiveType ?? ''}` : ''
}

/** 通告一次「网络变了」：续上恢复窗口 + 叫醒所有等待者 + 广播给订阅方 */
const fire = (reason: string) => {
  lastChangeAt = Date.now()
  console.info(`[net] 网络已变化（${reason}），进入 ${RECOVER_WINDOW_MS / 1000}s 恢复窗口`)
  // 先把等待者取干净再逐个跑：回调里可能又调一次 waitForNet（重试失败要接着等），
  // 边遍历边增删同一个 Set 会漏跑
  const pending = [...waiters]
  waiters.clear()
  pending.forEach(cb => { try { cb() } catch {} })
  changeCbs.forEach(cb => { try { cb() } catch {} })
}

const onOnline = () => fire('online')
const onOffline = () => { console.info('[net] 网络已断开') }
const onConnChange = () => {
  const sig = connSig()
  if (sig === lastConnSig) return   // 只是带宽估计抖了一下，不是换网
  lastConnSig = sig
  if (isOffline()) return           // 没网时的 change 没意义，等 online 那一发
  fire(`connection → ${sig || '未知'}`)
}
/** 回前台：后台期间 `connection.change` 会被吞，切走再回来很可能已经换过网 */
const onVisible = () => {
  if (document.visibilityState !== 'visible' || isOffline()) return
  const sig = connSig()
  if (sig === lastConnSig) return   // 特征没变 → 大概率还是同一个网，别白折腾正在播的流
  lastConnSig = sig
  fire('回前台且连接已变')
}

const init = () => {
  if (inited || typeof window === 'undefined') return
  inited = true
  lastConnSig = connSig()
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisible)
  // NetworkInformation 只有 Chromium 系有；拿不到就只剩 online/offline 那两个信号，
  // 行为退化成改动之前的样子（不会更差）
  try { connOf()?.addEventListener?.('change', onConnChange) } catch { /* iframe 权限策略会拒 */ }
}

/** 订阅「网络变了」。返回退订函数（引擎 stopHlsTick 时调） */
export const onNetChange = (cb: NetCb): (() => void) => {
  init()
  changeCbs.add(cb)
  return () => { changeCbs.delete(cb) }
}

/**
 * 等到有网再跑一次。**幂等 + 一次性 + 已经有网就下一拍直接跑**。
 *
 * 三条都是为了修掉老的 `waitForOnline`：它每次 fatal 都挂一个一次性 `online` 监听、
 * 不去重也不 remove；更糟的是**若 `online` 恰好在挂监听之前就发生了，那一发 startLoad
 * 永远不会来**——用户看到的就是网络早好了画面还一直转圈。
 */
export const waitForNet = (cb: NetCb) => {
  init()
  if (!isOffline()) { setTimeout(cb, 0); return }
  waiters.add(cb)
}
