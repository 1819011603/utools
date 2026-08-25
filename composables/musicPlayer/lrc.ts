/**
 * LRC 歌词解析（纯函数，无状态）。
 *
 * 站点在 `itemMusic.lrc` 里原样给一段文本，格式不保证 —— 实测：
 *   · 酷我那个源（`b`）给的是长度 2 的**空占位**，压根没内容
 *   · 有内容时是常见的 `[mm:ss.xx]文本` 逐行格式
 * 所以解析器要能同时应付「空」「有时间轴」「纯文本没时间轴」三种，
 * 且任何一种都不该抛错 —— 歌词是锦上添花，解析失败不能连累播放。
 */

export interface LrcLine {
  /** 这一行开始的时间（秒）。纯文本歌词没有时间轴，统一为 -1 */
  time: number
  text: string
}

export interface ParsedLrc {
  lines: LrcLine[]
  /** 有没有时间轴。没有就只能整块显示，不能跟唱高亮 */
  synced: boolean
}

/** 一行开头可能有多个时间标签：`[00:12.00][01:30.50]同一句` —— 副歌重复时很常见 */
const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
/** 元数据标签，跳过不显示 */
const META_RE = /^\[(ti|ar|al|by|offset|re|ve|length):/i

/**
 * 把毫秒位补齐成三位。`[00:12.5]` 的 `.5` 是 **500ms 不是 5ms**，
 * 按字面取会让整首歌的时间轴偏移，越到后面越离谱。
 */
function toMs(frac?: string): number {
  if (!frac) return 0
  return Number(frac.padEnd(3, '0').slice(0, 3))
}

export function parseLrc(raw?: string): ParsedLrc {
  const text = (raw ?? '').trim()
  // 站点常给空占位（实测长度 2 的字符串），别把它当歌词
  if (text.length < 4) return { lines: [], synced: false }

  // 有的接口把换行转义成了字面的 \n，没还原的话整首歌会挤成一行
  const normalized = text.includes('\n') ? text : text.replace(/\\n/g, '\n')
  const rows = normalized.split(/\r?\n/)

  let offsetMs = 0
  const om = normalized.match(/\[offset:\s*([+-]?\d+)\s*\]/i)
  if (om) offsetMs = Number(om[1]) || 0

  const lines: LrcLine[] = []
  let sawTag = false

  for (const row of rows) {
    const line = row.trim()
    if (!line) continue
    if (META_RE.test(line)) continue

    TAG_RE.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    while ((m = TAG_RE.exec(line))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + toMs(m[3]) / 1000)
    }

    const content = line.replace(TAG_RE, '').trim()
    // 只有时间标签、没有文字的行是间奏占位，留着会在界面上闪一片空白
    if (!content) continue

    if (stamps.length) {
      sawTag = true
      // 同一句挂多个时间点时逐个展开，副歌才能各自高亮
      for (const s of stamps) lines.push({ time: Math.max(0, s + offsetMs / 1000), text: content })
    } else {
      lines.push({ time: -1, text: content })
    }
  }

  // 时间轴不保证有序（多标签展开后一定是乱的），排一次
  if (sawTag) lines.sort((a, b) => a.time - b.time)

  return { lines, synced: sawTag }
}

/**
 * 当前时间对应第几行。返回 -1 表示还没到第一句（前奏）。
 *
 * 用二分而不是 `findLastIndex`：这个函数挂在 `timeupdate` 上，一秒要跑好几次，
 * 而长的现场版歌词能有几百行。
 */
export function activeLrcIndex(lines: LrcLine[], time: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= time) { ans = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return ans
}
