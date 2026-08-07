/**
 * 卡顿记录器：以 <video> 的真实停顿为「地面真值」，供自愈调参环反馈。
 *
 * 前面预取引擎的闭环是「按缓冲趋势*推断*卡顿」；这里直接量测真实停顿——
 * waiting/stalled（数据不够停播）进入停顿，playing / timeupdate 前进退出停顿。
 * 排除 seek 和用户 pause 引起的等待（那不是卡顿）。
 *
 * 暴露：isStalling / stallCount / stallMsTotal / lastStallAt / smoothSecs（响应式，供面板展示），
 * getSmoothSecs()（连续流畅秒数）/ stallCountInWindow(ms)（窗口内卡顿次数，供自愈判据）。
 */

/** 短于此值的停顿一律不算卡顿：肉眼基本无感，计进去反而污染自愈判据（见 endStall） */
const MIN_STALL_MS = 500

export function useStallTracker(getVideo: () => HTMLVideoElement | undefined) {
  const isStalling = ref(false)
  const stallCount = ref(0)      // 本会话累计卡顿次数
  const stallMsTotal = ref(0)    // 本会话累计卡顿时长（ms）
  const lastStallAt = ref(0)     // 上次卡顿开始时刻（performance.now）
  // 连续流畅秒数的响应式镜像：由 tick() 每秒刷新。
  // 面板不能直接调 getSmoothSecs()——它是普通函数，不进依赖收集，模板里只会显示第一次渲染时的值。
  const smoothSecs = ref(0)

  const stalls: { at: number; ms: number }[] = []  // 明细，用于窗口统计
  let stallStart = 0             // 本次停顿开始时刻
  let smoothSince = 0            // 连续流畅起点（performance.now）；卡顿时为 0
  let smoothBefore = 0           // 进入停顿前的 smoothSince，微停顿结束后原样还回去
  let lastCurrentTime = 0        // 上次记录的播放位置（timeupdate 兜底判前进）
  let bound: HTMLVideoElement | null = null

  const now = () => performance.now()

  const beginStall = () => {
    const v = getVideo()
    if (!v || v.paused || v.seeking || v.ended) return   // 暂停/跳转/播完引起的等待不算卡顿
    if (isStalling.value) return
    isStalling.value = true
    stallStart = now()
    lastStallAt.value = stallStart
    smoothBefore = smoothSince
    smoothSince = 0
  }

  const endStall = () => {
    if (isStalling.value) {
      const ms = now() - stallStart
      isStalling.value = false
      // 微停顿（< MIN_STALL_MS）不计数：一次 append/解码抖动几百毫秒，画面上几乎察觉不到，
      // 记进去只会让面板显示「卡顿 1 次 / 0.0s」这种自相矛盾的读数，还会把连续流畅清零、
      // 连带压住提速与档位判定。连续流畅也接着原来的起点算，当作没发生过。
      if (ms < MIN_STALL_MS) {
        smoothSince = smoothBefore || now()
        return
      }
      if (ms > 0) {
        stallCount.value++
        stallMsTotal.value += ms
        stalls.push({ at: stallStart, ms })
        if (stalls.length > 200) stalls.shift()
      }
    }
    smoothSince = now()   // 恢复播放 → 重新开始累计连续流畅
  }

  // seek 引起的等待不是卡顿：取消当前计时且不计数
  const cancelStall = () => {
    isStalling.value = false
    smoothSince = 0
  }

  const onWaiting = () => beginStall()
  const onStalled = () => beginStall()
  const onPlaying = () => endStall()
  const onSeeking = () => cancelStall()
  const onSeeked = () => { smoothSince = now(); lastCurrentTime = getVideo()?.currentTime ?? 0 }
  const onPause = () => { smoothSince = 0 }
  const onTimeUpdate = () => {
    const v = getVideo()
    if (!v) return
    // 播放位置在前进 → 若还标着卡顿说明已恢复（playing 可能没触发），补一次结束
    if (v.currentTime > lastCurrentTime + 0.01) {
      if (isStalling.value) endStall()
      else if (smoothSince === 0 && !v.paused) smoothSince = now()
    }
    lastCurrentTime = v.currentTime
  }

  const EVENTS: [keyof HTMLMediaElementEventMap, EventListener][] = [
    ['waiting', onWaiting as EventListener],
    ['stalled', onStalled as EventListener],
    ['playing', onPlaying as EventListener],
    ['seeking', onSeeking as EventListener],
    ['seeked', onSeeked as EventListener],
    ['pause', onPause as EventListener],
    ['timeupdate', onTimeUpdate as EventListener],
  ]

  // 幂等：同一元素重复调无副作用；元素换了（videoKey++ 重建 <video>）则自动改绑到新元素。
  // 心跳每秒调一次，不能只在起播时调一次——起播那一刻 videoEl 可能还指着上一轮被卸载的旧元素
  // （loadVideo 里 videoKey++ 要等 Vue 打补丁后 ref 才更新），绑到旧元素上等于一个事件都收不到，
  // 表现是「卡顿恒 0 次、连续流畅恒 0s」，且从统计面板完全看不出原因。
  const bind = (video?: HTMLVideoElement) => {
    const v = video ?? getVideo()
    if (!v || bound === v) return
    unbind()
    bound = v
    for (const [ev, fn] of EVENTS) v.addEventListener(ev, fn)
    smoothSince = v.paused ? 0 : now()   // 还没起播就先不计时，等 playing/timeupdate 开表
    lastCurrentTime = v.currentTime
  }

  const unbind = () => {
    if (!bound) return
    for (const [ev, fn] of EVENTS) bound.removeEventListener(ev, fn)
    bound = null
  }

  // 切换视频时清零（新流不背旧流的卡顿账）
  const reset = () => {
    isStalling.value = false
    stallCount.value = 0
    stallMsTotal.value = 0
    lastStallAt.value = 0
    stalls.length = 0
    stallStart = 0
    smoothSince = 0
    smoothBefore = 0
    smoothSecs.value = 0
    lastCurrentTime = getVideo()?.currentTime ?? 0
  }

  // 连续流畅秒数：卡顿中为 0，否则 = 距上次恢复的秒数。
  // 停顿刚开始、还没够 MIN_STALL_MS 时先按微停顿算（多数确实撑不过 0.5s），读数不清零——
  // 否则心跳正好采样在这半秒里，面板会闪一下「连续流畅 0s」再跳回七十几秒。
  const getSmoothSecs = (): number => {
    if (isStalling.value) {
      if (!smoothBefore || now() - stallStart >= MIN_STALL_MS) return 0
      return (now() - smoothBefore) / 1000
    }
    return smoothSince === 0 ? 0 : (now() - smoothSince) / 1000
  }

  /** 心跳每秒调：改绑（元素可能刚被重建）+ 刷新响应式读数 */
  const tick = () => {
    bind()
    smoothSecs.value = Math.round(getSmoothSecs())
  }

  // 最近 windowMs 内的卡顿次数（自愈判据用）
  const stallCountInWindow = (windowMs: number): number => {
    const cutoff = now() - windowMs
    let n = 0
    for (let i = stalls.length - 1; i >= 0; i--) {
      if (stalls[i].at >= cutoff) n++
      else break
    }
    return n
  }

  return {
    isStalling,
    stallCount,
    stallMsTotal,
    lastStallAt,
    smoothSecs,
    bind,
    unbind,
    reset,
    tick,
    getSmoothSecs,
    stallCountInWindow,
  }
}
