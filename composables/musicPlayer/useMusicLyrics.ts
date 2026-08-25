/**
 * 歌词获取：按优先级从三个来源拿一份 LRC。
 *
 *   ① 用户手动贴的（localStorage）—— 最高优先级，因为那是他亲自确认过的
 *   ② 曲目自带的（取址时顺带拿到）—— 实测音乐站两个源都不给，基本是空的
 *   ③ 在线查询（`/api/music/lyrics`，按歌名+歌手匹配）
 *
 * ## 为什么手动那条不是可有可无的
 *
 * 在线查询依赖的搜索接口在**版权下架的歌**上只会返回翻唱/AI 版
 * （实测搜「晴天 周杰伦」8 条候选里没有一条是原唱），匹配得越严就越查不到。
 * 对这类歌，用户自己贴一份才是唯一可靠的路径。
 *
 * ## 查询结果一定要缓存
 *
 * 每次切歌、每次重播都去查一遍，既慢又容易把上游惹毛。歌词是几 KB 的文本，
 * 按曲目存 localStorage 完全够用（音频那种几十 MB 的才需要 IndexedDB）。
 * **查不到的结果也要缓存**（存空串），否则每次播到这首都要白等一次网络往返。
 *
 * ## 模块级单例
 *
 * 播放条上的滚动歌词和下面的歌词面板是两个组件、各调一次本 composable。
 * 各持一份状态的话，一次切歌要查两遍网络（面板收起时还会两份不同步），
 * 所以状态提到模块级（同 `useMusicFavorites`）。**取词只由播放条驱动一处**
 * ——它是常驻的，而面板可以被收起来；两处都 watch 就会重复取。
 */
import { parseLrc } from './lrc'

const MANUAL_KEY = 'music-lyrics-manual'
/**
 * ⚠️ **键名带版本号，换查询实现时必须跟着 +1。**
 *
 * `v1` 那批缓存是在「网易云老接口已经回垃圾」期间攒下的，里面**几乎全是空结果**，
 * 而空结果一样占着 7 天有效期 —— 服务端修好了，老用户还得盯着「暂无歌词」等一周，
 * 且这种「代码明明改对了却没效果」最难归因。换个键 = 那批结论当场作废。
 */
const CACHE_KEY = 'music-lyrics-cache-v2'
/** 查到的词的有效期。歌词本身不会变，存久一点纯赚 */
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000
/**
 * 「查不到」的有效期短得多：上游会补录、我们这边的匹配策略也会改，
 * 拿一个月前的「没有」当结论，等于把每一次改进都推迟一个月才生效。
 */
const MISS_TTL = 12 * 60 * 60 * 1000
/** 缓存条数上限。一条几 KB，几百条也才一两 MB */
const MAX_ENTRIES = 300

interface LyricsEntry {
  lrc: string
  /** 匹配到的来源，界面上要标出来让用户判断可信度（下架歌常匹配到翻唱版） */
  from?: { name: string; artist: string }
  /**
   * 这条结论是**在知道时长是多少的情况下**得出的（0 = 当时还不知道）。
   * 只对「没查到」有意义：时长是匹配里最硬的判据，起播前查空过一次、
   * 播起来知道时长了就值得再查一次，而不是抱着那次「没有」等 12 小时。
   */
  d?: number
  at: number
}

function readMap<T>(key: string): Record<string, T> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Record<string, T>
  } catch {
    return {}
  }
}

function writeMap(key: string, map: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch { /* 超配额就算了，歌词是锦上添花 */ }
}

/** 当前曲目的歌词文本。空串 = 没有 */
const lyrics = ref('')
/** 来源标注。手动贴的为 null，在线匹配到的带歌名歌手 */
const source = ref<{ name: string; artist: string } | null>(null)
const loading = ref(false)
/** 这一首是不是用户手动贴的 */
const isManual = ref(false)
/** 解析结果。放这里而不是各组件各算一遍：播放条每次 timeupdate 都要读它 */
const parsed = computed(() => parseLrc(lyrics.value))

/** 本轮请求的序号：切歌快时旧的那轮回来要能认出自己过时了 */
let seq = 0

export function useMusicLyrics() {
  const manualOf = (key: string): string => readMap<string>(MANUAL_KEY)[key] || ''

  /** 手动贴一份。存下来之后这首歌永远优先用它 */
  const saveManual = (key: string, text: string) => {
    const map = readMap<string>(MANUAL_KEY)
    const v = text.trim()
    if (v) map[key] = v
    else delete map[key]
    writeMap(MANUAL_KEY, map)
    lyrics.value = v
    isManual.value = !!v
    source.value = null
  }

  const clearManual = (key: string) => saveManual(key, '')

  /**
   * 取这首歌的词。**永远不抛错**：歌词是附加信息，查失败只该表现为「没有词」，
   * 绝不能让播放界面弹出一个错误。
   */
  const fetchFor = async (track: { key: string; name: string; artist?: string; lrc?: string; duration?: number }) => {
    const mine = ++seq
    lyrics.value = ''
    source.value = null
    isManual.value = false
    loading.value = false

    // ① 手动贴的最优先
    const manual = manualOf(track.key)
    if (manual) {
      lyrics.value = manual
      isManual.value = true
      return
    }

    // ② 曲目自带（音乐站实测给的是空占位，长度 2 那种，所以要判够长）
    if (track.lrc && track.lrc.trim().length > 4) {
      lyrics.value = track.lrc
      return
    }

    // ③ 查缓存（含「查不到」的空结果，避免每次播到都白等一次往返；空结果的有效期短得多）
    const cache = readMap<LyricsEntry>(CACHE_KEY)
    const hit = cache[track.key]
    if (hit && Date.now() - hit.at < (hit.lrc ? CACHE_TTL : MISS_TTL)) {
      lyrics.value = hit.lrc
      source.value = hit.from ?? null
      return
    }

    // ④ 在线查
    loading.value = true
    try {
      const res = await $fetch<{ lrc?: string; matched?: { name: string; artist: string } | null }>(
        '/api/music/lyrics',
        {
          query: {
            name: track.name,
            artist: track.artist || '',
            /*
             * 时长能带就带：同名翻唱一大片时，「和这个文件一样长」是最硬的判据
             * （服务端拿它加权，见 lyrics.ts 的 scoreOf）。
             * 播过之后 `loadedmetadata` 会回填它，fangpi 更是取址时就给了。
             */
            duration: track.duration ? Math.round(track.duration) : '',
          },
        },
      )
      if (mine !== seq) return                      // 已经切歌了，这轮结果作废

      const lrc = res?.lrc || ''
      const from = res?.matched ?? undefined
      lyrics.value = lrc
      source.value = from ?? null

      cache[track.key] = { lrc, from, at: Date.now() }
      // 超量就把最旧的丢掉
      const keys = Object.keys(cache)
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach(k => delete cache[k])
      }
      writeMap(CACHE_KEY, cache)
    } catch {
      if (mine === seq) lyrics.value = ''
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  return { lyrics, parsed, source, loading, isManual, fetchFor, saveManual, clearManual, manualOf }
}
