/**
 * 音乐播放器的纯展示常量与格式化（无状态）。
 *
 * 单独一个文件而不是塞进 useMusicMediaState：那边被当「裸状态」用，
 * 而 unimport 的扫描踩过「数组常量后面紧跟的导出被静默漏掉」那个坑
 * （tsc 能过、自动导入查无此名，排查很费时间）。同 videoPlayer/display.ts 的处置。
 */

/**
 * 秒 → mm:ss / h:mm:ss。一首歌基本用不到小时位，但现场录音的长版本会超过一小时。
 *
 * **不叫 `formatTime`**：`composables/videoPlayer/display.ts` 里已经有一个同名导出，
 * 而自动导入是**全局扁平**的 —— 两个同名导出会互相覆盖（构建日志里是一句
 * `Duplicated imports "formatTime" … has been ignored`），后登记的那个会静默接管
 * 视频播放器的时间显示。同 CLAUDE.md 里「各模块返回的键名不能重复」那条，
 * 只是这里作用在自动导入的函数名上。
 */
export function formatTrackTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** 字节 → 可读体积。下载进度用，站点给的 sizeText 只是展示、不参与计算 */
export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/**
 * 拼下载文件名。**必须自己拼，不能用 CDN 给的**：
 * 实测 24bit 的分片响应是 `content-disposition: inline` + `content-type: audio/mpeg`，
 * 而内容其实是 flac —— 跟着它走会得到一个扩展名错误、名字是一串 hash 的文件。
 *
 * 扩展名只信 `Track.format`（站点自报，实测准）；连它都没有时退回 mp3
 * ——比留一个没有扩展名的文件强，用户至少能双击打开。
 */
export function buildFileName(name: string, artist?: string, format?: string): string {
  const ext = (format || 'mp3').replace(/^\./, '').toLowerCase()
  const base = artist ? `${name} - ${artist}` : name
  return `${sanitizeFileName(base)}.${ext}`
}

/**
 * 洗掉文件名里的非法字符。Windows 的禁用集最严（`\ / : * ? " < > |`），按它来就够跨平台。
 * 顺带压掉连续空白：歌手字段里常有 `A & B` 这种带空格的拼接，多个歌手连起来会很长。
 */
export function sanitizeFileName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)   // 文件名总长有上限，留出扩展名和路径的余量
}

/** 音量档位：键盘上下键的步进 */
export const VOLUME_STEP = 0.05

/** 进度快进/快退的步进（秒）。歌曲比视频短，5 秒比视频那边的 10 秒更合适 */
export const SEEK_STEP = 5
