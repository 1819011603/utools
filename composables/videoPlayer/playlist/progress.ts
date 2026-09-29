/**
 * 播放列表的「进度记忆 + 追剧续看」这一块（从 useVideoPlaylistCtl.ts 下沉）。
 *
 * 只吃裸状态与回调，不认识切集/取址：`playlist`/`currentIndex` 是调用方的 ref，
 * `playingIndex` 由调用方通过 getter 提供（它是「媒体元素当前真装着的那一集」，见 useVideoPlaylistCtl）。
 */
import type { Ref } from 'vue'
import { ref, computed, watch, onScopeDispose } from 'vue'
import type { VideoMediaState } from '../useVideoMediaState'
import type { VideoHandoff } from '../useVideoHandoff'
import { onSyncApplied } from '../../cloudSyncLocal'

export interface PlaylistProgressDeps {
  playlist: Ref<string[]>
  currentIndex: Ref<number>
  /** 媒体元素当前真装着的那一集（存进度按它，不是乐观的 currentIndex） */
  getPlayingIndex: () => number
  media: VideoMediaState
  handoff: VideoHandoff
  onDirty: () => void
  playByIndex: (index: number) => Promise<void>
}

export function usePlaylistProgress(deps: PlaylistProgressDeps) {
  const { playlist, currentIndex, getPlayingIndex, media, handoff } = deps
  const { videoUrl, savedProgress } = media

  /**
   * 进度存取用的键。
   *
   * 普通列表里 playlist[currentIndex] 就等于 videoUrl，取哪个都一样；
   * 但按需取址的站点每次现取到的真实地址都不同（带时效签名），拿它当键等于每次都查不到，
   * 所以一律用播放列表里那个稳定的占位地址。没有播放列表时（直接贴地址播）退回 videoUrl。
   */
  const progressKey = (): string => playlist.value[currentIndex.value] || videoUrl.value

  /**
   * 媒体元素**当前真装着**的那一集，存进度一律按它。
   *
   * `currentIndex` 是乐观的：切集一开始就指向目标集，而取址 + 建流要好几秒。这几秒里旧 `<video>`
   * 还在原地播、`timeupdate` 照常每秒来四次，而「每 5 秒存一次进度」正挂在它上面——若不分开，
   * **上一集的秒数**会被写进**下一集的**键里：下次进这一集就从上一集的位置起播，用户看到的就是
   * 「手动点下一集，进度还是上一集的」；自动下一集时更会被那个位置当场判成片尾再弹走，看着像
   * 「切换不了下一集」。`playingIndex` 只在媒体真正换流的前一刻更新（见 useVideoPlaylistCtl.doPlayByIndex）。
   */
  const playingKey = (): string => playlist.value[getPlayingIndex()] || videoUrl.value

  /**
   * 当前这一集的显示名。理由与 progressKey 完全相同——集名也是按「列表里那条地址」存的，
   * 而按需取址时 videoUrl 是现取的真实地址（每次都不同），拿它去查 playlistNames 必然落空，
   * 退化成显示 `ec54d9af…m3u8` 这种文件名，可播放列表里同一集却好端端写着「1」（踩过）。
   */
  const currentVideoName = computed(() => {
    const name = handoff.getVideoName(progressKey(), currentIndex.value)
    // 站点给的集名多半就是个纯数字（「1」「10」），标题栏上孤零零一个「1」看不出是什么。
    // 只在这里补成「第N集」：播放列表格子窄、一屏要摆几十个，那边保持纯数字。
    return /^\d{1,4}$/.test(name) ? `第${name}集` : name
  })

  /**
   * 「这集算看完了」的位置：片尾区的起点（至少留 5 秒，`skipOutro` 关着时就是结尾附近）。
   * 越过它就不该再记进度——记下来下次进这集会从片尾恢复，一恢复就又落进「跳过片尾」的判据里，
   * 当场被弹到下一集，**这集永远看不成**（踩过：看到 22 集后回头点 21 集，播完自动进 22 集又被弹走）。
   */
  const finishedThreshold = (): number => {
    const dur = media.duration.value
    return dur > 0 ? dur - Math.max(5, media.skipOutro.value) : Infinity
  }

  const watchHistory = useWatchHistory()

  /**
   * 「这部剧看到第几集」——按剧记一条，供解析页显示「继续观看」（见 useWatchHistory）。
   *
   * 挂在进度保存这条路上而不是切集处：切集只在换集那一下发生，而用户看完第 10 集就关页面时
   * 压根不会再切集，那一集就记不下来。进度保存是周期性的，覆盖「看到哪就记到哪」。
   * 单集列表不记：那不是「剧」，记了只会把续看列表塞满一堆一次性视频。
   */
  const recordWatchProgress = (finished = false) => {
    if (playlist.value.length <= 1) return
    const src = handoff.playlistSource.value
    const title = handoff.playlistTitle.value || ''
    if (!title && !src?.pageUrl) return      // 既没剧名也没来源页 → 无从归属到某部剧
    watchHistory.recordWatch({
      title,
      pageUrl: src?.pageUrl,
      line: src?.line,
      lineName: src?.lineName,
      index: getPlayingIndex(),
      epName: handoff.getVideoName(playlist.value[getPlayingIndex()] || '', getPlayingIndex()),
      total: playlist.value.length,
      cover: handoff.playlistCover.value || undefined,
      cat: handoff.playlistCat.value || undefined,
      // 秒数一并记进这份**按剧**的记录里：按 URL 存的 savedProgress 不上云（键是带签名的地址），
      // 换台设备打开时只有这两个数字能把人送回「第 10 集 12:34」。
      //
      // **这一集已经看到片尾区时记 0**，理由与 savedProgress 那边删记录完全相同：
      // 记下来的话，从侧边栏点这条会恢复到片尾，一恢复就落进「跳过片尾」的判据里当场被弹走，
      // 这集永远看不成（CLAUDE.md 里那条踩过的坑，只是这次的入口换成了播放历史）
      time: finished ? 0 : media.currentTime.value,
      duration: media.duration.value || undefined,
    })
  }

  /**
   * 「上次看到第 N 集」——**播放器自己也要提**，不能只在解析页提。
   *
   * 解析页那条提示只覆盖「重新搜一遍再解析」这一条路；而用户也可能直接点「播放全部」、
   * 或者拿着分享链接进来，那时播放器照旧从第 1 集起播，续看记录白记了一场。
   *
   * 只在**没指定集数**（`currentIndex === 0`）时提：深链带了 `index`/`ep` 就是明确要看那一集，
   * 这时候插嘴纯属干扰。也不自动跳过去——用户可能就是想重看第 1 集，跳了他还得自己找回来。
   */
  const resumeHint = ref<{ index: number; epName?: string; total?: number } | null>(null)
  /** 用户自己动过集数之后就永久闭嘴（见下面那个 watch(currentIndex)） */
  let resumeSettled = false

  const findResumeHint = () => {
    // 用户已经自己动过集数 → 这条提示本次会话不再出现（见下面那个 watch）
    if (resumeSettled) { resumeHint.value = null; return }
    if (playlist.value.length <= 1 || currentIndex.value !== 0) { resumeHint.value = null; return }
    const rec = watchHistory.findWatch({
      title: handoff.playlistTitle.value || undefined,
      pageUrl: handoff.playlistSource.value?.pageUrl,
    })
    if (!rec) { resumeHint.value = null; return }
    // 落点先按集名认再退回序号（源站会往中间加塞，几天前的序号可能已经指到别人身上）
    const byName = rec.epName
      ? playlist.value.findIndex((u, i) => handoff.getVideoName(u, i) === rec.epName)
      : -1
    const index = byName >= 0 ? byName : (rec.index < playlist.value.length ? rec.index : -1)
    // **落点就是正在播的这一集时一个字都不说**：那条提示等于「点我跳到你已经在看的地方」，
    // 纯噪音。（`index > 0` 已经隐含了这一条，但把它写出来——将来若允许在非第 1 集时也提示，
    // 漏了这一句就会冒出「上次看到第 12 集」而画面上正播着第 12 集）
    resumeHint.value = index > 0 && index !== currentIndex.value
      ? { index, epName: rec.epName, total: rec.total }
      : null
  }

  const resumeToHint = async () => {
    const r = resumeHint.value
    resumeHint.value = null
    if (r) await deps.playByIndex(r.index)
  }
  const dismissResumeHint = () => { resumeHint.value = null }

  // 列表换了（解析出新的一份 / 从 savedState 恢复 / 手工贴一批）就重算一次
  watch([playlist, () => handoff.playlistTitle.value], () => findResumeHint(), { flush: 'post' })

  /**
   * **云端的追剧进度到货了也要重算**：页面打开那一发同步是异步的，多半比起播晚。
   * 不重算的话，另一台设备上追到的集数拉回来了、界面上却还是本机那份旧值
   * ——用户看到的就是「两台机器对不上」。`findResumeHint` 自己带着那几条闭嘴规则
   *（用户动过集数就永久不提），所以这里无条件调是安全的。
   */
  const offWatchSync = onSyncApplied('video-watch', () => findResumeHint())
  onScopeDispose(() => offWatchSync())

  /**
   * **用户一旦自己动过集数，这条提示就永久闭嘴**（本次会话内）。
   *
   * 「正常切上一集/下一集」时再冒出「上次看到第 N 集」是纯噪音：他显然已经知道自己在哪、
   * 也已经在按自己的意思走了。判据用「集数离开了第 1 集」而不是去各处调用点埋钩子——
   * 选集面板、全屏抽屉、上下集按钮、快捷键、播完自动下一集全都汇到这里，一处就够。
   * 起播那一下（停在第 1 集）不算动过，所以提示照旧出得来。
   */
  watch(currentIndex, i => {
    if (i === 0) return
    resumeSettled = true
    resumeHint.value = null
  })

  const saveCurrentProgress = () => {
    const key = playingKey()
    if (!key || media.currentTime.value <= 0) return   // 还没播就别动已有记录（切集时会经过这里）
    const finished = media.currentTime.value >= finishedThreshold()
    recordWatchProgress(finished)
    if (finished) {
      // 看完了：清掉记录，下次从头开始
      if (savedProgress.value[key] !== undefined) {
        delete savedProgress.value[key]
        deps.onDirty()
      }
      return
    }
    savedProgress.value[key] = media.currentTime.value
    deps.onDirty()
  }

  /** 起播后发现存的位置已经在片尾区（老版本留下的记录）时，就地作废 */
  const dropSavedProgress = (url: string) => {
    if (savedProgress.value[url] === undefined) return
    delete savedProgress.value[url]
    deps.onDirty()
  }

  const getSavedProgress = (url: string): number => savedProgress.value[url] || 0

  const clearAllProgress = () => {
    savedProgress.value = {}
    deps.onDirty()
  }

  return {
    progressKey, playingKey, currentVideoName,
    saveCurrentProgress, dropSavedProgress, getSavedProgress, clearAllProgress,
    resumeHint, resumeToHint, dismissResumeHint,
  }
}
