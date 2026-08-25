/**
 * 播放器装配层：把各模块接起来，并负责三件跨模块的事——持久化、挂载卸载、对外接口。
 *
 * 页面和子组件都通过 provide/inject 拿这个对象（见 `useMusicPlayerCtx`），
 * 所以子组件不需要一层层传 props。因此**各模块返回的键名不能重复**。
 *
 * 取址器由调用方注入（`deps.resolve`），播放器本身不认识任何站点——
 * 这就是「播放器可复用」的全部含义：给它一个 url 它就播，给不出 url 时才回头找注入的取址器。
 */
import type { InjectionKey } from 'vue'
import type { ResolvedTrack, SavedMusicState, Track } from './types'
import { toStorableTrack } from './types'
import { useMusicDownload } from './useMusicDownload'
import { useMusicEngine } from './useMusicEngine'
import { useMusicMediaState } from './useMusicMediaState'

const STORAGE_KEY = 'music-player-state'

export interface MusicPlayerOptions {
  /** 取址回调。不传 = 这个播放器只播直链 */
  resolve?: (track: Track) => Promise<ResolvedTrack>
}

export function useMusicPlayerController(options: MusicPlayerOptions = {}) {
  const media = useMusicMediaState()
  const { queue, queueIndex, repeat, shuffle, current, volume, isMuted, errorMessage, errorKind } = media

  // 引擎要「播完自动下一首」，而那是队列的判断（循环模式、随机）——
  // 走回调而不是让引擎去 import 队列，否则立刻循环依赖
  const engine = useMusicEngine(media, {
    resolve: options.resolve,
    onEnded: () => onTrackEnded(),
  })

  /*
   * 下载共用同一个取址器 —— 必须共用，不能各走各的：
   * 那个闸门是全局串行 + 退避的，两条路各持一份就等于把并发翻倍，
   * 而站点按天按 IP 限配额，多发的每一发都在啃同一份额度。
   */
  const download = useMusicDownload({ resolve: options.resolve })

  // ── 队列 ──

  /** 播队列里的第 n 首。越界自动收敛，调用方不必先判断 */
  const playAt = async (index: number) => {
    if (index < 0 || index >= queue.value.length) return
    queueIndex.value = index
    await engine.load(queue.value[index], { autoplay: true })
  }

  /**
   * 下一首要放哪个。返回 -1 表示「到此为止」。
   * `one` 不在这里处理——单曲循环走 `onTrackEnded` 的重播分支，从头播一遍比重新装载省一次取址。
   */
  const nextIndex = (): number => {
    const n = queue.value.length
    if (!n) return -1
    if (shuffle.value) {
      if (n === 1) return repeat.value === 'off' ? -1 : 0
      // 随机但不原地踏步：抽到自己就顺延一格，比 while 重抽稳定（最坏情况有界）
      let i = Math.floor(Math.random() * n)
      if (i === queueIndex.value) i = (i + 1) % n
      return i
    }
    const next = queueIndex.value + 1
    if (next < n) return next
    return repeat.value === 'all' ? 0 : -1
  }

  const onTrackEnded = () => {
    if (repeat.value === 'one') {
      engine.seekTo(0)
      void engine.attemptPlay(0)
      return
    }
    const i = nextIndex()
    if (i >= 0) void playAt(i)
  }

  const playNext = () => {
    const i = nextIndex()
    if (i >= 0) void playAt(i)
  }

  /**
   * 上一首。**播过 3 秒以上就先回到本曲开头**——这是所有音乐播放器的通行做法，
   * 用户按「上一首」多半是想重听当前这首的开头，而不是真要走到上一首去。
   */
  const playPrev = () => {
    if (media.currentTime.value > 3) { engine.seekTo(0); return }
    const n = queue.value.length
    if (!n) return
    const prev = queueIndex.value - 1
    if (prev >= 0) return void playAt(prev)
    if (repeat.value === 'all') void playAt(n - 1)
  }

  /** 整份替换队列并从第 index 首开始播（点搜索结果里的一条就是这个路径） */
  const setQueue = async (tracks: Track[], index = 0) => {
    queue.value = tracks
    await playAt(index)
  }

  /** 追加到队列末尾，不打断当前播放。已经在队列里的按 key 跳过 */
  const enqueue = (tracks: Track[]) => {
    const seen = new Set(queue.value.map(t => t.key))
    const fresh = tracks.filter(t => !seen.has(t.key))
    queue.value.push(...fresh)
    return fresh.length
  }

  const removeAt = (index: number) => {
    if (index < 0 || index >= queue.value.length) return
    queue.value.splice(index, 1)
    // 删的是当前这首前面的 → 下标要跟着往前挪，否则「正在播的是哪首」会指错
    if (index < queueIndex.value) queueIndex.value--
    else if (index === queueIndex.value) queueIndex.value = Math.min(queueIndex.value, queue.value.length - 1)
  }

  const clearQueue = () => { queue.value = []; queueIndex.value = -1 }

  const cycleRepeat = () => {
    repeat.value = repeat.value === 'off' ? 'all' : repeat.value === 'all' ? 'one' : 'off'
  }

  // ── 手粘直链 ──

  /**
   * 播一条手粘的音频地址。**这条路径不依赖任何数据源适配层**，
   * 也是播放器「可复用」的实证：给个 url 就能播。
   */
  const playDirectUrl = async (raw: string) => {
    const url = raw.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url) && !url.startsWith('blob:')) {
      errorKind.value = 'resolve'
      errorMessage.value = '请填一个 http(s) 开头的音频地址'
      return
    }
    // 直链本身就是终态，拿它当 key（不会变）；名字从路径最后一段猜一个
    let name = url
    try {
      const path = new URL(url).pathname
      name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url
    } catch { /* 拼不出就用整条地址当名字，总比空着强 */ }
    const ext = name.match(/\.(\w{2,5})$/)?.[1]?.toLowerCase()
    const track: Track = { key: url, name, url, format: ext }
    queue.value = [track]
    queueIndex.value = 0
    await engine.load(track, { autoplay: true })
  }

  // ── 持久化 ──
  // **队列里存的是剥掉 url 的占位**：24bit 的地址约 20 分钟过期，存下来下次打开必是死链，
  // 而且失败是静默的（音频元素只是不出声），比不存更难查。见 types.ts 的 toStorableTrack。

  const save = () => {
    try {
      const state: SavedMusicState = {
        volume: volume.value,
        muted: isMuted.value,
        repeat: repeat.value,
        shuffle: shuffle.value,
        queue: queue.value.map(toStorableTrack),
        queueIndex: queueIndex.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch { /* 超配额就算了，持久化是可选的 */ }
  }

  const restore = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const s = JSON.parse(raw) as SavedMusicState
      if (typeof s.volume === 'number') volume.value = s.volume
      if (typeof s.muted === 'boolean') isMuted.value = s.muted
      if (s.repeat) repeat.value = s.repeat
      if (typeof s.shuffle === 'boolean') shuffle.value = s.shuffle
      if (Array.isArray(s.queue)) {
        queue.value = s.queue
        // 只恢复列表和「停在第几首」，**不自动起播**：一进页面就出声是很粗鲁的行为
        queueIndex.value = Math.min(s.queueIndex ?? -1, s.queue.length - 1)
        if (queueIndex.value >= 0) current.value = s.queue[queueIndex.value]
      }
    } catch { /* 坏掉的存档不该拖垮整个页面 */ }
  }

  let saveTimer: ReturnType<typeof setInterval> | null = null

  const mount = () => {
    restore()
    engine.bind()
    // 队列和音量的变化很密（拖音量条一次几十下），定期存比 watch 深比较便宜
    saveTimer = setInterval(save, 5000)
  }

  const unmount = () => {
    engine.unbind()
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null }
    save()
  }

  const dismissError = () => { errorMessage.value = ''; errorKind.value = '' }

  return {
    // 全部平铺成一层：子组件里 `const { isPlaying, queue, togglePlay } = useMusicPlayerCtx()`
    // 因此**各模块返回的键名不能重复**，重了后面的会静默盖掉前面的
    ...media,
    ...engine,
    ...download,
    playAt, playNext, playPrev, setQueue, enqueue, removeAt, clearQueue, cycleRepeat,
    playDirectUrl, dismissError,
    mount, unmount, save,
  }
}

export type MusicPlayerCtx = ReturnType<typeof useMusicPlayerController>

export const MUSIC_PLAYER_KEY = Symbol('music-player') as InjectionKey<MusicPlayerCtx>

/** 子组件取上下文。页面必须先 provide，否则这里直接抛错比拿到 undefined 好排查 */
export function useMusicPlayerCtx(): MusicPlayerCtx {
  const ctx = inject(MUSIC_PLAYER_KEY)
  if (!ctx) throw new Error('useMusicPlayerCtx 必须在 /music 页面内使用')
  return ctx
}
