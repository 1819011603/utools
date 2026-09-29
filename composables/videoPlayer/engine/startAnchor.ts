/**
 * 起播锚点：刷新 / 恢复进度 / 切集起播时，播放头还停在 0、但要起播的位置在 `pendingStartPos`。
 *
 * 从 `useVideoEngine` 拆出来：这几个标量在装载路径与预取锚点之间来回读写，
 * 收成一个独立状态对象，读写点集中，免得散在引擎里各改一处。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
export function useStartAnchor() {
  /**
   * 预取锚点：预取以此为起点（见 useHlsPrefetch 的 getStartPosition）——起播即在正确位置
   * 全力并行预取，既不浪费带宽下开头，也不会退化成「只有 hls.js 串行下 1 片」。
   * 到位/用户跳转后清 0。
   */
  let pendingStartPos = 0
  let startAnchorActive = false
  const clearStartAnchor = () => { startAnchorActive = false; pendingStartPos = 0 }
  const isArrivingAtStart = (ct: number) => startAnchorActive && Math.abs(ct - pendingStartPos) < 3
  /**
   * 本次交给 hls.js `startPosition` 的位置。与 pendingStartPos 分开存：后者是预取锚点、
   * 到位就被 clearStartAnchor 清 0，而 useVideoEvents 在 loadedmetadata 里要知道
   * 「引擎到底把起播位置定在哪」才能判断还要不要补一次 seek（见那里的片尾区兜底）。
   */
  let appliedStartPos = 0
  const getAppliedStartPos = () => appliedStartPos

  /**
   * 本次起播是不是「定位类」（切集 / 重载 / 拖进度），供 useVideoEvents 选起播门槛：
   * 定位类只要「够播 2 秒」就出画面，首次冷启动仍要攒够 6 秒（两档都 × 倍速，
   * 见 useVideoEvents.autoPlayTarget）。
   *
   * 区别在于用户的预期：冷启动时他刚点开、还在看页面，多等两秒攒厚一点划算；
   * 而切集/拖进度时画面是停着的，每多一秒都在盯着转圈——那时「先出画面、边播边补」明显更好。
   */
  let isRelocating = false
  const isRelocatingStart = () => isRelocating
  const clearRelocating = () => { isRelocating = false }

  /** 交给预取的「从哪往后预取」：定位未到位前用 pendingStartPos，到位后用真实播放头（0） */
  const getStartPosition = () => (startAnchorActive ? pendingStartPos : 0)
  /** 起播装载时确定本次锚点（`startPos <= 0` = 从头播，锚点不激活） */
  const beginAnchor = (startPos: number) => {
    pendingStartPos = startPos
    appliedStartPos = startPos
    startAnchorActive = startPos > 0
  }
  const setAppliedStartPos = (n: number) => { appliedStartPos = n }
  const setRelocating = (v: boolean) => { isRelocating = v }

  return {
    clearStartAnchor, isArrivingAtStart, getAppliedStartPos, isRelocatingStart, clearRelocating,
    getStartPosition, beginAnchor, setAppliedStartPos, setRelocating,
  }
}

export type StartAnchor = ReturnType<typeof useStartAnchor>
