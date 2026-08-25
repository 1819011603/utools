/**
 * 按**剧**记住倍速与片头片尾（目标倍速 / 跳过片头 / 跳过片尾 / 自动最佳倍速 / 超快倍速）。
 *
 * 治的是换剧那一下：一部剧片头 90 秒、习惯 2x，换一部片头 20 秒、只想 1.25x。
 * 这五项原来只有一份全局值（`video-player-state`），于是每次换剧都得回齿轮菜单重设一遍，
 * 忘了就是「新剧开头被跳掉 90 秒」或者「拿 3x 去播一部本来就卡的剧」。
 *
 * 两层语义，缺一不可：
 *   · **这部剧有自己的一份** → 换过去就用它；
 *   · **没有自己的 → 用「上一次」那份**（最后一次用过的值，不分哪部剧）。
 *
 * 「上一次」这一层**不在本模块里**：`saveState()` 一直在把当前值写进 `video-player-state`、
 * `hydrate()` 在 mount 时读回来，那就是天然的 last-used。所以这里只做「有记录才覆盖」，
 * 没记录时**一个字都不改**——当前值即上一次的值，fallback 不需要任何代码。
 *
 * 键与续看历史**共用 `showKeyOf`**（见 useWatchHistory）：两处各写一套归一化，
 * 迟早出现「续看记在这部剧上、设置记在另一部上」，而且只在标题多个空格这类场合才发作。
 */
import type { VideoMediaState } from './useVideoMediaState'
import type { VideoHandoff } from './useVideoHandoff'
// 显式 import 不靠自动导入：这把钥匙一旦没接上（unimport 漏掉时 tsc 照样能过）
// 表现是设置全存到空键上，看着像「随机不生效」
import { showKeyOf } from '../useWatchHistory'
import { markDirty, recordDelete } from '../cloudSyncLocal'

const KEY = 'video-show-prefs'
/** 清单 id，与 `cloudSyncSpec.ts` 里那条对应 */
const COLL = 'show-prefs'
/** 与续看历史同一个量级：200 部够用，超了淘汰最久没看的 */
const MAX_SHOWS = 200

export interface ShowPrefs {
  /** 目标倍速（`desiredRate`），不是自动最佳倍速算出来的实际值 */
  rate?: number
  skipIntro?: number
  skipOutro?: number
  autoBestRate?: boolean
  turboRate?: boolean
  /** 最后一次用到这条记录的时间，只用来做 LRU 淘汰 */
  at: number
  /**
   * 最后一次**真的改过设置**的时间。云同步的先后判断只能看它，不能看 `at`：
   * `at` 在 `applyShowPrefs` 里也会被刷（那是「最近看过」），拿它做判断就会出现
   * 「A 上改了倍速、B 上只是打开看了一眼这部剧，结果 B 的旧值赢」。旧记录没有这个字段，退回 `at`。
   */
  mt?: number
}

type Store = Record<string, ShowPrefs>

const load = (): Store => {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store } catch { return {} }
}

/**
 * `dirty = false` 是给「只是刷了一下 LRU 时间戳」那种写盘用的：
 * 那不是用户改了设置，标脏会让「有变更才同步」变成「打开播放器就同步」。
 */
const save = (s: Store, dirty = true) => {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 配额满了就算了，这是锦上添花的数据 */ }
  if (dirty) markDirty(COLL)
}

export interface ShowPrefsDeps {
  media: VideoMediaState
  handoff: VideoHandoff
}

export function useShowPrefs(deps: ShowPrefsDeps) {
  const { media, handoff } = deps
  const { desiredRate, playbackRate, skipIntro, skipOutro, autoBestRate, turboRate } = media

  /** 当前这部剧的键；空串 = 认不出是哪部剧（手工贴的地址、单个视频），那就既不记也不改 */
  const showKey = computed(() => showKeyOf({
    title: handoff.playlistTitle.value || undefined,
    pageUrl: handoff.playlistSource.value?.pageUrl,
  }))

  /** 供 UI 显示「已按《谁》记住」。没有剧名但有来源页时也算认得出，只是没名字可写 */
  const showLabel = computed(() => handoff.playlistTitle.value || '')
  /** 这部剧是否已经有自己的一份（决定齿轮菜单里那行字的措辞） */
  const hasShowPrefs = ref(false)

  const snapshot = (): Omit<ShowPrefs, 'at'> => ({
    rate: desiredRate.value,
    skipIntro: skipIntro.value,
    skipOutro: skipOutro.value,
    autoBestRate: autoBestRate.value,
    turboRate: turboRate.value,
  })

  const sameAsStored = (rec: ShowPrefs | undefined, cur: Omit<ShowPrefs, 'at'>) =>
    !!rec && (Object.keys(cur) as (keyof typeof cur)[]).every(k => rec[k] === cur[k])

  /**
   * 换剧时套用这部剧自己的那一份。
   *
   * **`flush: 'sync'` 不是随手写的**：`skipIntro` 会被引擎当起播位置用（`startPosition`），
   * 而解析那条路是「设剧名 → 紧接着 playByIndex」（useVideoPlaylistCtl 里连着几行）。
   * 用默认的 'pre' 就会晚一步——这部剧的第一集拿着上一部剧的片头秒数起播，
   * 表现成「刚点开就跳掉了一分半」，而切到第二集之后又一切正常，最难查。
   *
   * 倍速要连 `playbackRate` 一起写：自动最佳倍速关着时它才是真正生效的那个值，
   * 只改 `desiredRate` 的话画面上倍速纹丝不动（自动模式下由 autoTune 每秒重算，写了也无妨）。
   */
  const applyShowPrefs = () => {
    const key = showKey.value
    if (!key) { hasShowPrefs.value = false; return }
    const s = load()
    const rec = s[key]
    hasShowPrefs.value = !!rec
    if (!rec) return
    if (rec.rate !== undefined) {
      desiredRate.value = rec.rate
      if (!(rec.autoBestRate ?? autoBestRate.value)) playbackRate.value = rec.rate
    }
    if (rec.skipIntro !== undefined) skipIntro.value = rec.skipIntro
    if (rec.skipOutro !== undefined) skipOutro.value = rec.skipOutro
    if (rec.autoBestRate !== undefined) autoBestRate.value = rec.autoBestRate
    if (rec.turboRate !== undefined) turboRate.value = rec.turboRate
    // 用到了就算「最近看过」，LRU 才淘汰得对。这一笔不算「改过设置」，所以不标脏
    s[key] = { ...rec, at: Date.now() }
    save(s, false)
  }

  watch(showKey, () => applyShowPrefs(), { flush: 'sync' })

  /**
   * 用户改了任一项就写回这部剧。
   *
   * **不需要「正在套用」的标志位**：套用之后这里也会被触发一次，但那时值与记录里的完全一致，
   * `sameAsStored` 直接把它挡掉。同理，一部还没有记录的剧继承「上一次」的值时几个 ref 压根没变，
   * 这个 watch 不会被触发，也就不会凭空生出一条记录——只有真的动过手才落库。
   */
  watch([desiredRate, skipIntro, skipOutro, autoBestRate, turboRate], () => {
    const key = showKey.value
    if (!key) return
    const cur = snapshot()
    const s = load()
    if (sameAsStored(s[key], cur)) return
    const now = Date.now()
    s[key] = { ...cur, at: now, mt: now }
    const keys = Object.keys(s)
    if (keys.length > MAX_SHOWS) {
      keys.sort((a, b) => s[a]!.at - s[b]!.at)
      for (const dead of keys.slice(0, keys.length - MAX_SHOWS)) delete s[dead]
    }
    save(s)
    hasShowPrefs.value = true
  })

  /**
   * 「恢复默认」= 只删记录，**不动当前正在播的这几个值**：
   * 正看着突然变速、片头位置也变了，比「没清干净」更莫名。以后这部剧跟着「上一次」走。
   */
  const forgetShowPrefs = () => {
    const key = showKey.value
    if (!key) return
    const s = load()
    delete s[key]
    recordDelete(COLL, key)
    save(s)
    hasShowPrefs.value = false
  }

  return { showLabel, hasShowPrefs, forgetShowPrefs, applyShowPrefs }
}

export type VideoShowPrefs = ReturnType<typeof useShowPrefs>
