/**
 * 「货在手上却播不动」的自救。
 *
 * 症状（实测截图）：徽标写着**缓冲 305.7s**、0 线程、0 KB/s，画面却盖着转圈遮罩不动，
 * 控制台每秒刷 `mediaError bufferStalledError fatal: false`。三个读数放在一起就能定位：
 *   · `缓冲 305.7s` 是**有效可播**（MSE + JS 预取缓存，见 bufferMeter.getCachedAhead）——数据确实在手上；
 *   · `0 线程 / 0 KB/s` 是**正常**的：缓存已到「预加载时长」，预取按设计停了，全命中缓存自然没有网速；
 *   · 真正的问题只有一个：**MSE 在播放头那一点是空的**，hls.js 卡在一个空洞前面。
 *
 * **实测最常见的成因是「源站那一片的音视轨不对齐」**（甄嬛传 67 集 33:07，把分片抠出来 ffprobe：
 * 音轨比视轨晚 0.64s 开始、短 0.75s；而 hls.js 那边解出来的音轨只有 1.3s，
 * 现场日志 `pts(v)=1986.2~1992.2` 对 `pts(a)=1986.1~1987.4`）。
 * `video.buffered` 是音轨与视轨的**交集**，所以 MSE 到头的位置正是音轨的末尾；
 * 更要命的是 hls.js 按**视轨**记账，认定这片已缓冲 → `_doTickIdle` 每拍都算出「下一片已有」→
 * 状态停在 IDLE，**永远不再请求分片**。这是死锁不是慢，预取缓存里躺着几百秒也没用。
 *
 * 结论：这一片**喂不进去**，重取、清账、微跳几百毫秒全都白费（三轮实测都试过），
 * 唯一的出路是**整片放弃**——清掉这一片 + 把播放头挪到它后面。阶梯就是按这个结论排的：
 *   ① 洞不大（≤ HOLE_JUMP_MAX）→ 跳到洞后面那段的起点（等于临时放大 maxBufferHole，最便宜）；
 *   ② 整片放弃（清这一片 + 跳到下一片 + `startLoad` 落位）；
 *   ③ `recoverMediaError()` 重建 MediaSource；④ 停手并说清楚「换条线路」。
 *
 * **两条硬约束**（都是踩过的坑的反面）：
 *   · **播放头处 MSE 有货就一律不动手**——那时的卡顿是解码/GPU/倍速侧的事
 *     （判读看统计面板的掉帧），乱跳只会把正常播放打断；
 *   · **有冷却**（`FIX_COOLDOWN`）：hls.js 自己的 nudge 每秒都在动 currentTime，
 *     不设冷却就会两套恢复机制互相打断，表现成画面反复小跳。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/** 洞小于这个值就直接跳过去（秒）。再大就不跳了——那不像「一片没 append 上」，跳过去要丢的内容太多 */
const HOLE_JUMP_MAX = 3
/** 两次自救的最小间隔（ms）：别跟 hls.js 自己的 nudge 抢方向盘 */
const FIX_COOLDOWN_MS = 2000
/** 播放头冻住多久算真卡（ms）。心跳兜底那条用它——事件不一定每次都来 */
const FROZEN_MS = 2000
/**
 * 一次 seek 的宽限期（ms）。超过它还停在 `seeking=true` 就当成「这次跳没落地」继续升级——
 * 跳到一个永远喂不进数据的位置时 `seeked` 不会来，`seeking` 会**永远**是 true。
 */
const SEEK_GRACE_MS = 3000
/** 微跳距离（秒）：要够越过 MSE 缓冲段的末尾（否则 hls.js 不当成「跳到未缓冲处」），又不至于丢掉一句台词 */
const NUDGE_SEC = 0.5
/**
 * hls.js 的 `Events.BUFFER_FLUSHING`。写字面量而不是 import 整个 hls.js：
 * 这个模块只在卡死时跑一次，为一个常量把主包拖进来不值（hls.js 全程是动态 import 的）。
 * 事件名是 hls.js 的公开常量值，多年未变；万一改了，`try/catch` 兜住，阶梯还有后面三级。
 */
const BUFFER_FLUSHING = 'hlsBufferFlushing'

export interface StallRecoveryDeps {
  getVideoEl: () => HTMLVideoElement | undefined
  getHls: () => any
  /** MSE 前向：播放头所在那段缓冲的剩余秒数（0 = 播放头处就是空的） */
  getAheadBuffered: (v: HTMLVideoElement) => number
  /** 有效可播：MSE + JS 预取缓存。>0 说明数据在手上，卡的不是网络 */
  getCachedAhead: (v: HTMLVideoElement) => number
  /** 四级自救全部无效：把话说清楚（写 errorMessage），别让用户对着冻住的画面猜 */
  onGiveUp?: () => void
  /** fLoader 的活动记录：hls.js 最近一次跟我们要片/我们最近一次交货是什么时候 */
  getLoaderActivity?: () => { lastLoadAt: number; lastServedAt: number; lastSn: unknown; lastUrl: string }
  /** 这一片在不在 JS 预取缓存里 */
  isSegCached?: (url: string) => boolean
}

export function useStallRecovery(deps: StallRecoveryDeps) {
  let lastFixAt = 0
  let lastTime = -1
  let lastMoveAt = 0
  let step = 0            // 自救阶梯的进度，播放头一动就归零
  let seekingSince = 0    // `seeking` 从什么时候开始一直为 true（见 attempt 里的说明）

  /** 某个时间点落在哪一片上（拿不到分片表就返回 null） */
  const fragAt = (hls: any, t: number): any => {
    const level = hls?.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = hls?.levels?.[level]?.details?.fragments ?? []
    return frags.find(f => f.start <= t + 0.1 && t < f.end + 0.1) ?? null
  }

  /** 播放头后面最近一段缓冲的起点（没有就返回 null） */
  const nextBufferedStart = (v: HTMLVideoElement): number | null => {
    for (let i = 0; i < v.buffered.length; i++) {
      const s = v.buffered.start(i)
      if (s > v.currentTime + 0.1) return s
    }
    return null
  }

  /**
   * 同一招重复十次无效就该换招（实测日志：`startLoad(1987.3)` 连打 10 次，播放头一动不动）。
   * 所以按**阶梯**升级，每一级只用一次，播放头一动就整份归零：
   *   ① 跳空洞——洞小的话这一下就好了，代价最小
   *   ② `startLoad(currentTime)`——让 streamController 从播放头重排一次
   *   ③ 微跳 0.5s——跨过被 hls.js 标成 `gap` 的那一片（标了 gap 的片它不会再取，只能绕过去）
   *   ④ `recoverMediaError()`——重建 MediaSource。append 通道本身坏了时这是唯一的出路，
   *      也是最后一手：它会重新 attach，代价是画面黑一下
   * 四级都过不去就**停手并说明白**：继续原地打转只是把控制台刷满，而画面早就冻住了，
   * 用户需要的是「换条线路试试」这句话。
   */
  /**
   * 冻屏现场一次打全。**这一幕靠单个读数永远查不出来**（「缓冲 305s」既可能是 MSE 也可能全是
   * JS 缓存，「0 线程/0 KB/s」在全命中缓存时是正常的），所以把分岔口需要的量一起打出来：
   *
   *   · `askedAgoMs` 小 = hls.js 还在跟我们要片 → 卡在我们这边（取不到 / 交不出去）；
   *     很大 = **它压根没在要** → 问题在 hls.js 侧（认为缓冲够了、或那一片被记成已缓冲/gap），
   *     这时改预取毫无用处，只能逼它重排（阶梯 ①②③）。
   *   · `frag.gap` 为真 = hls.js 已经把那一片判成空洞，它**再也不会去取**，只能绕过去（阶梯 ②）。
   *   · `ranges` 为空而 `cached` 很大 = 数据全在 JS 缓存、一个字节都没进 MSE（append 通道的问题）。
   */
  /**
   * 一片的关键信息。三项都是为了分清「记账错了」和「时间轴错了」这两类完全不同的病：
   *   · `br=` 有值 = **BYTERANGE 清单**（同一个 URL 的不同字节段各算一片）。自定义 loader 不发 `Range`
   *     就会每片都取回整个文件——时间轴当场崩，而且按 URL 存的缓存会互相顶掉；
   *   · `cc=` 是不连续序号（`EXT-X-DISCONTINUITY` 计数）：源站在这儿拼接过（广告/换编码）时 PTS 会跳，
   *     靠这个标记 hls.js 才能重映射时间轴；标记丢了就会 append 到几百秒之外；
   *   · `pts=` 是 hls.js **实际解出来的**媒体时间，跟 `start~end`（清单声明的）差很远就是时间轴错乱的铁证。
   */
  const ptsBrief = (es: any): string =>
    es && Number.isFinite(es.startPTS) ? `${es.startPTS.toFixed(1)}~${Number(es.endPTS).toFixed(1)}` : '-'

  const fragBrief = (f: any, cached: boolean | null | undefined): string => {
    if (!f) return '(无)'
    const e = f.elementaryStreams ?? {}
    // **音轨和视轨分开打**：`video.buffered` 是两条 sourceBuffer 的**交集**，
    // 只要一条短一截，整体就在那儿到头——这时看合并后的读数只会以为「解出来了却没进去」，
    // 看不出是哪一条短。av = 混合轨（TS 里常见），单独一栏免得跟分轨混淆
    const pts = ` pts(v)=${ptsBrief(e.video)} pts(a)=${ptsBrief(e.audio)} pts(av)=${ptsBrief(e.audiovideo)}`
    const br = f.byteRangeEndOffset ? ` br=${f.byteRangeStartOffset}-${f.byteRangeEndOffset}` : ''
    return `sn=${f.sn} ${f.start.toFixed(1)}~${f.end.toFixed(1)} cc=${f.cc}${br}${pts}${f.gap ? ' [gap!]' : ''}`
      + ` 缓存=${cached === null || cached === undefined ? '?' : cached ? '有' : '无'}`
  }

  /**
   * 各条 sourceBuffer 各自的缓冲区间。**这是「谁短了」的唯一直接证据**：
   * `video.buffered` 只给交集，音轨少收 5 秒和视轨少收 5 秒在它上面长得一模一样。
   */
  const trackRanges = (hls: any): string => {
    const bc = hls?.bufferController
    // hls.js 各版本放法不同，都试一遍：新版是 `sourceBuffers`（`[type, sb]` 元组数组），
    // 老版是 `sourceBuffer`（按类型的 map）。取不到就说取不到，别默默显示成「空」
    const pairs: Array<[string, any]> = []
    if (Array.isArray(bc?.sourceBuffers)) {
      for (const tuple of bc.sourceBuffers) if (tuple?.[0]) pairs.push([tuple[0], tuple[1]])
    } else {
      for (const type of ['audio', 'video', 'audiovideo']) if (bc?.sourceBuffer?.[type]) pairs.push([type, bc.sourceBuffer[type]])
    }
    const out: string[] = []
    for (const [type, sb] of pairs) {
      const buf = sb?.buffered ?? sb?.sb?.buffered
      if (!buf) { out.push(`${type}[?]`); continue }
      const rs: string[] = []
      for (let i = 0; i < buf.length; i++) rs.push(`${buf.start(i).toFixed(1)}~${buf.end(i).toFixed(1)}`)
      out.push(`${type}[${rs.join(' , ') || '空'}]`)
    }
    return out.length ? out.join(' ') : '(取不到分轨)'
  }

  const snapshot = (v: HTMLVideoElement, hls: any) => {
    const ct = v.currentTime
    const ranges: string[] = []
    for (let i = 0; i < v.buffered.length; i++) ranges.push(`${v.buffered.start(i).toFixed(1)}~${v.buffered.end(i).toFixed(1)}`)
    const level = hls?.currentLevel >= 0 ? hls.currentLevel : 0
    const frags: any[] = hls?.levels?.[level]?.details?.fragments ?? []
    const curIdx = frags.findIndex(f => f.start <= ct + 0.1 && ct < f.end + 0.1)
    const cur = curIdx >= 0 ? frags[curIdx] : null
    // **下一片才是关键**：播放头这一片已经在 MSE 里（所以还有 0.x 秒），
    // 冻住的原因是它后面那一片没被 append —— 要看的是「hls.js 有没有去要它、它是不是被标了 gap」
    const nxt = curIdx >= 0 ? frags[curIdx + 1] : null
    const act = deps.getLoaderActivity?.()
    const now = Date.now()
    // 打成**一行字符串**而不是对象：控制台里对象默认折叠成 `{…}`，最要紧的几项恰好被折进去了（踩过）
    console.warn(
      `[stall] 现场 at=${ct.toFixed(2)} rate=${v.playbackRate} readyState=${v.readyState}`
      + ` mse前向=${deps.getAheadBuffered(v).toFixed(2)}s 有效可播=${deps.getCachedAhead(v).toFixed(1)}s`
      + ` | hls状态=${hls?.streamController?.state ?? '?'} 画质档=${level} 分片数=${frags.length}`
      + ` | 当前片 ${fragBrief(cur, cur ? deps.isSegCached?.(cur.url) : null)}`
      + ` | 下一片 ${fragBrief(nxt, nxt ? deps.isSegCached?.(nxt.url) : null)}`
      + ` | hls上次要片=${act?.lastLoadAt ? `${now - act.lastLoadAt}ms前 sn=${String(act.lastSn)}` : '从未'}`
      + ` 上次交货=${act?.lastServedAt ? `${now - act.lastServedAt}ms前` : '从未'}`
      + ` | MSE区间 ${ranges.length ? ranges.join(' , ') : '(全空)'}`
      + ` | 分轨 ${trackRanges(hls)}`,
    )
  }

  /**
   * 动手之后 400ms 回头看一眼**到底动没动**。
   *
   * 这一条是必须的：实测出现过「日志写着跳到 1992.3s，下一条现场还是 at=1987.22 一模一样」，
   * 光看动作日志会以为动作生效了、方向对了，其实**赋值压根没落地**
   * （被别处按着、或 seek 被浏览器/hls.js 拒了）。不验证就会拿「这招没用」当结论，
   * 继续往后面几级白走一遍——而真正该查的是「为什么 currentTime 写不进去」。
   */
  const verify = (label: string, before: number) => {
    setTimeout(() => {
      const v = deps.getVideoEl()
      if (!v) return
      const ranges: string[] = []
      for (let i = 0; i < v.buffered.length; i++) ranges.push(`${v.buffered.start(i).toFixed(1)}~${v.buffered.end(i).toFixed(1)}`)
      console.warn(
        `[stall] ${label} 之后 400ms：at=${v.currentTime.toFixed(2)}（位移 ${(v.currentTime - before).toFixed(2)}s）`
        + ` seeking=${v.seeking} paused=${v.paused} readyState=${v.readyState}`
        + ` mse前向=${deps.getAheadBuffered(v).toFixed(2)}s MSE区间 ${ranges.join(' , ') || '(全空)'}`,
      )
    }, 400)
  }

  const attempt = (reason: string) => {
    const v = deps.getVideoEl()
    const hls = deps.getHls()
    if (!v || !hls || v.paused) return
    /*
     * **`seeking` 卡在 true 本身就是一种冻死，不能无条件跳过**（踩过，这是「跳过去了却还是不动」
     * 的真正原因）：我们跳到下一片之后，那个位置若一直喂不进数据，浏览器的 `seeking` 就**永远**
     * 是 true（`seeked` 不会来）。而这里原来写的是 `v.seeking → return`，于是阶梯**再也不往下走**，
     * `recoverMediaError` 那一级一次都跑不到——日志看起来就是「跳了、位移 5.36s、然后没了」。
     * 现在只放过「刚发起的 seek」（`SEEK_GRACE_MS` 内），超时未落地就继续升级。
     */
    if (v.seeking) {
      if (!seekingSince) seekingSince = Date.now()
      if (Date.now() - seekingSince < SEEK_GRACE_MS) return
    } else {
      seekingSince = 0
    }
    // 播放头处有货 → 不是空洞问题（解码/GPU/倍速侧），绝不动手
    if (deps.getAheadBuffered(v) > 0.5) return
    // 手上一点货都没有 → 这是网络问题，交给预取/重试那套，别在这儿瞎跳
    if (deps.getCachedAhead(v) < 1) return
    if (Date.now() - lastFixAt < FIX_COOLDOWN_MS) return
    lastFixAt = Date.now()
    snapshot(v, hls)   // 动手之前先留一份现场：动过之后就分不清是谁的因果了

    const at = v.currentTime
    const next = nextBufferedStart(v)
    // ① 洞小就直接跳过去（等于临时放大 maxBufferHole）。这一级不占阶梯——它每次都值得先试
    if (next !== null && next - at <= HOLE_JUMP_MAX) {
      console.warn(`[stall] ${reason}：MSE 在 ${at.toFixed(1)}s 处有个 ${(next - at).toFixed(2)}s 的空洞，跳到 ${next.toFixed(1)}s`)
      v.currentTime = next + 0.05
      return
    }

    step++
    if (step === 1) {
      /*
       * **整片放弃：清掉这一片，同时把播放头挪到它后面。**
       *
       * 排在第一级是实测定下来的（现场日志三轮）：
       *   `pts(v)=1986.2~1992.2` 而 `pts(a)=1986.1~1987.4` —— hls.js 自己解出来的**音轨只有 1.3 秒**，
       *   `MSE区间 1980.2~1987.4` 的末尾正是音轨的末尾（`video.buffered` 是音视轨的**交集**）。
       *   源站这一片（ffprobe 证实：音轨比视轨晚 0.64s 开始、短 0.75s）就是**喂不进去**的。
       * 所以「重取」这一类动作全都白费：同一片、同样的结果。必须跨过它。
       *
       * **两件事要一起做**，缺一个都不动（都踩过）：
       *   · 光 `BUFFER_FLUSHING` 不跳 → 账清了，hls.js 重取的还是这一片，再截断一次，原地复发；
       *   · 光跳不清 → 那 0.17s 残余和 `fragmentTracker` 里「331 已缓冲」的假账都还在，
       *     hls.js 仍可能算出「已经有了」而继续空转。
       * 顺序也是先清后跳：flush 之后 hls.js 会 `tick()` 一次，那时播放头已经在新位置上，
       * 它算出的「下一片」才是我们想要的 332。
       *
       * 代价是丢掉这一片剩下的几秒（画面跳一下），但那几秒本来就播不出来。
       * `+0.3` 而不是 `+0.05`：落点要**明确落在下一片里面**，别卡在分片边界上让 hls.js 又选回这一片。
       *
       * **清的范围只给这一片（`cur.start`~`cur.end`），千万别 `endOffset: Infinity`**（踩过）：
       * 清到无穷会把播放头前方所有好数据一起扔掉，`verify` 打出来就是 `MSE区间 (全空)` ——
       * 3x 倍速下要从零重新攒够起播门槛，画面上跟没恢复毫无区别，还白扔一堆已经下好的分片。
       * 顺手 `startLoad(to)`：seek 之后再把 `nextLoadPosition` 明确设到落点，
       * 免得它按 flush 前的旧位置去挑下一片（那样又会挑回这片坏的）。
       */
      const cur = fragAt(hls, at)
      const to = cur ? cur.end + 0.3 : at + NUDGE_SEC
      console.warn(`[stall] ${reason}：${cur ? `sn=${cur.sn} 喂不进 MSE（多半音视轨不对齐），整片放弃` : '找不到当前片，微跳'}：清掉这一片并跳到 ${to.toFixed(1)}s`)
      if (cur) { try { hls.trigger(BUFFER_FLUSHING, { startOffset: cur.start, endOffset: cur.end, type: null }) } catch {} }
      v.currentTime = to
      try { hls.startLoad(to) } catch {}
      verify('整片放弃', at)
    } else if (step === 2) {
      console.warn(`[stall] ${reason}：仍然冻住，重建 MediaSource（recoverMediaError）`)
      try { hls.recoverMediaError() } catch {}
      verify('recoverMediaError', at)
    } else {
      console.error(`[stall] ${reason}：三级自救全部无效，停在 ${at.toFixed(1)}s。这一条源大概率喂不进解码器，换条线路试试`)
      deps.onGiveUp?.()
    }
  }

  /** hls.js 报了非致命 bufferStalledError（每秒复发那个）。这是最准的入口 */
  const onBufferStalled = () => attempt('hls.js 报缓冲停滞')

  /**
   * 心跳兜底：`bufferStalledError` 并非每次冻结都发（同 stallTracker 那条
   * 「事件之外还要位置采样兜底」的理由）。自己每秒比一次播放头。
   */
  const tick = () => {
    const v = deps.getVideoEl()
    if (!v || v.paused) { lastTime = -1; return }
    // **不在这里拦 `seeking`**：跳到喂不进数据的位置时它会永远是 true，拦住等于把兜底也一起关掉。
    // 该不该动手交给 `attempt` 里的 `SEEK_GRACE_MS` 判（那儿才有「卡了多久」的概念）
    if (v.seeking) { attempt('seek 一直没落地'); return }
    const now = Date.now()
    const moved = lastTime >= 0 && Math.abs(v.currentTime - lastTime) > 0.05
    if (lastTime < 0 || moved) {
      lastTime = v.currentTime
      lastMoveAt = now
      // **只有「真的往前播了」才归零阶梯**（`moved`），`lastTime < 0` 那种「刚重新开始采样」不算。
      // 踩过：每一次自救动作都会让 `seeking` 短暂为真 → 下一拍 `lastTime` 是 -1 → 阶梯被清回 0，
      // 于是永远在第 ① 级原地打转，后面几级一次都跑不到（日志里「清缓冲」连着出现两遍就是这个）
      if (moved) step = 0
      return
    }
    if (now - lastMoveAt >= FROZEN_MS) attempt('心跳发现播放头冻住')
  }

  /** 换流/切集时清掉采样，否则上一集的时间点会被当成「冻住」 */
  const reset = () => { lastTime = -1; lastFixAt = 0; step = 0 }

  return { onBufferStalled, tick, reset }
}
