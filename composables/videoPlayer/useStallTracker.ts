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

/**
 * 停顿中「往前跳不超过这么多秒」判定为恢复性微跳，不是用户跳转（见 onSeeking）。
 * hls.js 的 gap controller 卡住时会 nudge（currentTime += 0.1），
 * useVideoEvents.onWaiting 还会主动跳过 <3s 的缓冲空洞，两者都走 seeking 事件。
 */
const NUDGE_MAX_SEC = 3.5

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
  let stallPos = 0               // 本次停顿时的播放位置（用于分辨恢复性微跳 vs 用户跳转）
  let smoothSince = 0            // 连续流畅起点（performance.now）；卡顿时为 0
  let smoothBefore = 0           // 进入停顿前的 smoothSince，微停顿结束后原样还回去
  let pausedAt = 0               // 手动暂停时刻（0=没在暂停）；恢复时把这段时长平移掉而非清零
  let lastCurrentTime = 0        // 上次记录的播放位置（timeupdate 兜底判前进）
  let nudging = false            // 正在处理一次恢复性微跳，随之而来的那个 timeupdate 不算恢复
  let tickPos = -1               // 上一拍的播放位置（-1=没有可用基准），位置采样兜底用
  let tickAt = 0                 // 上一拍的时刻，停顿起点回填用
  let bound: HTMLVideoElement | null = null

  const now = () => performance.now()

  // at：停顿起点。位置采样兜底发现的停顿其实从上一拍就开始了，要回填而不是记成现在（见 detectByPosition）
  const beginStall = (at = now()) => {
    const v = getVideo()
    if (!v || v.paused || v.seeking || v.ended) return   // 暂停/跳转/播完引起的等待不算卡顿
    if (isStalling.value) return
    isStalling.value = true
    stallStart = at
    stallPos = v.currentTime
    lastStallAt.value = at
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
        pausedAt = 0
        return
      }
      if (ms > 0) {
        stallCount.value++
        stallMsTotal.value += ms
        stalls.push({ at: stallStart, ms })
        if (stalls.length > 200) stalls.shift()
      }
      smoothSince = now()   // 真卡顿过 → 重新开表
      pausedAt = 0
      return
    }
    // 不是从卡顿恢复，那就是从暂停恢复：把暂停占掉的这段平移出去，计时接着走。
    // 暂停不是卡顿——缓冲期间还在涨，清零重来等于让用户每按一次暂停就要重新攒够 20s 才敢提速。
    if (pausedAt) {
      if (smoothSince) smoothSince += now() - pausedAt
      pausedAt = 0
    }
    if (!smoothSince) smoothSince = now()   // 首次起播：开表
  }

  // seek 引起的等待不是卡顿：取消当前计时且不计数
  const cancelStall = () => {
    isStalling.value = false
    smoothSince = 0
    pausedAt = 0
    tickPos = -1
    nudging = false
  }

  const onWaiting = () => beginStall()
  const onStalled = () => beginStall()
  const onPlaying = () => endStall()
  // 停顿中的「往前微跳」是**恢复动作**而非用户跳转：hls.js 卡住时会 nudge 播放头，
  // useVideoEvents.onWaiting 还会主动跳过缓冲空洞。一律按 seek 取消的话，正在发生的这次卡顿
  // 会被整段抹掉——实测卡到肉眼可见，面板仍是「0 次 / 0.0s」。这种跳不结束停顿，
  // 等真正播起来（playing / timeupdate 前进）才收尾，长停顿也不会被切成好几次。
  const onSeeking = () => {
    const v = getVideo()
    if (isStalling.value && v) {
      const delta = v.currentTime - stallPos
      if (delta >= 0 && delta <= NUDGE_MAX_SEC) { tickPos = -1; nudging = true; return }
    }
    cancelStall()
  }
  const onSeeked = () => {
    const v = getVideo()
    lastCurrentTime = v?.currentTime ?? 0
    tickPos = -1                       // 位置跳了，下一拍重新取基准
    nudging = false
    if (isStalling.value) return       // 恢复性微跳：停顿还没结束，别把连续流畅的表打开
    smoothSince = now()
    pausedAt = v?.paused ? now() : 0   // 暂停中拖进度条：开了表但立刻冻住
  }
  // 暂停只是把表冻住，不清零（清零的话每按一次暂停就白攒一遍连续流畅）
  const onPause = () => { if (smoothSince && !pausedAt) pausedAt = now() }
  const onTimeUpdate = () => {
    const v = getVideo()
    if (!v) return
    // 恢复性微跳自己会带出一个 timeupdate（规范里 timeupdate 先于 seeked 触发），
    // 位置确实前进了 0.1s，但画面并没有播起来。放过去会把一次长卡顿从中间截断，
    // 切成若干段不到 0.5s 的碎片，再被 MIN_STALL_MS 逐个滤掉——面板又回到「0 次」。
    if (nudging) { nudging = false; lastCurrentTime = v.currentTime; return }
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
    pausedAt = 0
    nudging = false
    tickPos = -1                         // 换了元素，位置基准作废
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
    stallPos = 0
    smoothSince = 0
    smoothBefore = 0
    pausedAt = 0
    nudging = false
    tickPos = -1
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
    if (!smoothSince) return 0
    // 暂停期间读数冻在按下暂停的那一刻：既不清零（暂停不是卡顿），也不能继续涨
    //（干坐着不播算不上「流畅播放」，让它涨就等于给提速门槛开后门）
    return ((pausedAt || now()) - smoothSince) / 1000
  }

  // ── 位置采样兜底 ──
  // 只认 waiting/stalled 事件是不够的：空洞、解码停顿、事件在换流前后丢失都会让停顿无人发现，
  // 而用户眼里的卡顿就是「画面不动」。每拍比一次播放头，一秒没前进就按卡顿记。
  // 暂停/跳转/播完/倍速 0 全部排除——那些不是卡顿（手动暂停照旧不计，见 onPause）。
  const detectByPosition = () => {
    const v = getVideo()
    const t = now()
    if (!v || v.paused || v.seeking || v.ended || v.playbackRate <= 0 || !v.duration) {
      tickPos = -1
      tickAt = t
      return
    }
    if (tickPos >= 0) {
      if (v.currentTime > tickPos + 0.01) {
        if (isStalling.value) endStall()
      } else {
        beginStall(tickAt)   // 停顿从上一拍就开始了，起点回填，否则每次都少记 1 秒
      }
    }
    tickPos = v.currentTime
    tickAt = t
  }

  /**
   * 丢掉位置采样的基准，下一拍重新建立。
   *
   * 标签页切到后台时心跳会被浏览器节流（拉长到几十秒一拍），回到前台的第一拍里
   * `tickAt` 还是切走之前那个时刻。此时若播放头恰好没前进，`beginStall(tickAt)` 会把
   * **整段后台时间**回填成一次卡顿——面板凭空多出几十秒，自愈环还会据此把倍速压回 1x。
   * 所以回前台先调这个，把基准作废。
   */
  const resetSampler = () => {
    tickPos = -1
    tickAt = now()
  }

  /** 心跳每秒调：改绑（元素可能刚被重建）+ 位置采样兜底 + 刷新响应式读数 */
  const tick = () => {
    bind()
    detectByPosition()
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
    resetSampler,
    getSmoothSecs,
    stallCountInWindow,
  }
}
