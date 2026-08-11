/**
 * 窄屏（手机竖屏，<640px）判定。
 *
 * 用 `matchMedia` 而不是 Tailwind 的 `hidden sm:block`：这几处控制的是 **`v-if`**
 * ——控制栏里的音量整组/画中画、画面上的锁定按钮，它们要么整个不渲染
 * （窄屏控制栏一 `flex-wrap` 就摞成两排，把进度条顶到画面中间），
 * 要么位置会压在别的东西上（锁定键左侧垂直居中，小窗里正好压住中央播放键）。
 *
 * 独立成一个 composable 是因为**已经有两个组件要用它**（ControlBar / Stage），
 * 而 Stage 那边曾经直接写了 `!isNarrow` 却没声明——模板里读不存在的属性只是一条
 * Vue warn，取值恒 `undefined`（= 假），于是「窄屏才隐藏」悄悄变成「任何尺寸都显示」，
 * 界面上看不出错。各写一份 `matchMedia` 也会漂移（断点改一处漏一处），所以收在这里。
 *
 * **不进 `useVideoPlayerCtx`**：它跟播放逻辑无关，进了 ctx 还要跟各模块抢键名
 * （「各模块返回的键名不能重复」那条约束）。
 */
export function useNarrowScreen(query = '(max-width: 639px)') {
  const isNarrow = ref(false)
  let mq: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => { isNarrow.value = e.matches }

  onMounted(() => {
    mq = window.matchMedia(query)
    isNarrow.value = mq.matches
    mq.addEventListener('change', onChange)
  })
  // 组件卸载要摘掉监听：播放器整块会随 videoKey 重建，不摘就一直往上叠
  onUnmounted(() => mq?.removeEventListener('change', onChange))

  return isNarrow
}
