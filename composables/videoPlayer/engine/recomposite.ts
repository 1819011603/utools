/**
 * 「切走再回来」这一档的两件事：强制重新合成 `<video>`，以及回前台时的追赶。
 *
 * 两者都跟 hls.js 的生命周期无关，只是挂在同一个 visibilitychange 上，
 * 所以从 useVideoEngine 拆出来（那边超了 500 行）。内部实现模块，走显式相对 import。
 */
export interface RecompositeDeps {
  /** 有没有在播（没有 hls 实例时整套都不用做） */
  isActive: () => boolean
  /** 切走前把已播分片吐掉，别带着几百 MB 进后台 */
  purgePlayed: () => void
  /** 回前台要立刻补跑的那几件事（作废卡顿采样 → 跑一拍闭环 → 拉起并发 → 刷读数） */
  catchUp: () => void
}

export function useRecomposite(deps: RecompositeDeps) {
  /**
   * `<video>` 的 transform。**初值为空**——不打扰绝大多数设备：空 transform 时浏览器才可能
   * 把视频交给硬件 overlay 平面（省电、解码路径最短）。只有真需要重新合成时（见 forceRecomposite）
   * 才置上并从此常驻，代价是那一路视频改走纹理合成。
   * 走响应式绑定而不是直改 DOM：换集时 `videoKey++` 会重建元素，直改的样式会跟着丢。
   */
  const videoTransform = ref('')

  /**
   * 强制重新合成一次 `<video>`。
   *
   * 治的是浏览器侧的**残影**：Chrome 把视频画在独立的硬件 overlay 平面上，该平面在
   * 「标签页切走切回」「播放停下」之后可能停在没画完的一帧（画面被静止图挡住、错开成两块、
   * 或整块黑屏），而音频和 currentTime 一切正常——**播放本身没问题，只是那一层没被重画**。
   * 用户的自救方式「再切一次标签页」正是逼它重新合成，这里把这一步替他做了。
   *
   * 手法是**在两个视觉等价的 transform 之间切换**（Z 轴 0.01px，看不出位移）。
   * 早先是「设 translateZ(0) → 下一帧撤销」，那样元素会在 overlay 平面和普通合成层之间
   * 来回搬两次，**每次搬家在屏幕上都看得见**，表现是每次暂停都「闪一下，最后画面才对」（踩过）。
   *
   * 所以第一次调用之后 transform 就不再撤销，元素常驻合成层，此后切换值只重画不搬家。
   * 只有这**第一下**还会闪一次——按需而不是一上来就常驻，是为了不打扰没这毛病的设备：
   * 空 transform 时视频才可能走硬件 overlay（省电、解码路径最短）。
   *
   * 用 `transform` 而不是 `display:none`：后者会让 `<video>` 卸掉解码器再重建，真的会黑一下。
   */
  const forceRecomposite = () => {
    videoTransform.value = videoTransform.value === 'translateZ(0px)'
      ? 'translateZ(0.01px)'
      : 'translateZ(0px)'
  }

  /**
   * 回到前台时的追赶。**整个预取引擎都挂在上面那个 1 秒心跳上**，而浏览器会节流后台标签页的
   * 定时器（切走久了拉长到几十秒一拍）。于是后台期间：播放照常消耗预取缓存，补片却几乎停了，
   * 前方缓存被吃空。切回来的一瞬间 hls.js 要的分片不在缓存里 → 走网络 → 就是那「卡一下」。
   * 而并发是每拍 +1 慢慢爬的，等它自己恢复要好几秒；期间再切走切回来，缓存已经填回去了，
   * 所以第二次「就好了」——这正是这个 bug 的特征现象。
   * 全屏时没事也对得上：全屏的标签页始终是前台，压根没被节流过。
   *
   * 这里不等下一拍，立刻把该做的都做一遍：作废卡顿采样基准（见 resetSampler，
   * 否则后台那几十秒会被回填成一次假卡顿）→ 跑一拍闭环 → primePrefetch 直接把并发拉起来。
   */
  const onVisibilityChange = () => {
    if (!deps.isActive()) return
    // 切走时立刻把已播分片吐掉。后台标签页是浏览器做内存回收/压缩的首选对象，
    // 而这份缓存可能有几百 MB 的 ArrayBuffer——留着它进后台，回来时要把这一大坨重新换页进来，
    // 表现就是「整个浏览器像卡死一样」。已播的那部分反正也用不上了，走之前先扔
    if (document.visibilityState === 'hidden') {
      deps.purgePlayed()
      return
    }
    if (document.visibilityState !== 'visible') return
    forceRecomposite()
    deps.catchUp()
  }

  return { videoTransform, forceRecomposite, onVisibilityChange }
}
