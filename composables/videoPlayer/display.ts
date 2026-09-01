/**
 * 播放器的纯展示常量与格式化函数（无状态）。
 *
 * 单独一个文件而不是塞进 useVideoMediaState：那边被当成「裸状态」用，
 * 混进常量后自动导入的扫描曾漏掉紧跟在数组常量后面的导出，排查很费时间。
 */

/** 倍速档位。既给控制栏菜单用，也给 useVideoUiControls 的 </> 快捷键当步进表 */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

/** 时钟格式（HH:MM），用于「已于 xx:xx 刷新」这类时间点提示 */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * KB/s → 可读速度。上千就换成 MB/s：高速源动辄四五位数，一串 `12480 KB/s` 得数位数才知道多快。
 * 1024 而不是 1000——上游 `perConnKBps` 就是按 1024 从 bps 折下来的，两边得同一套进制。
 */
export function formatSpeed(kbps: number): string {
  if (!isFinite(kbps) || kbps <= 0) return '0 KB/s'
  if (kbps < 1024) return `${Math.round(kbps)} KB/s`
  const mb = kbps / 1024
  return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB/s`
}

/** 秒 → mm:ss / h:mm:ss */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** 字节 → 可读体积（下载任务行上的「已下多少」）。同 formatSpeed 用 1024 进制 */
export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/**
 * 「超快倍速」开关打开后**追加**的档位（3x 以上）。默认不给，因为它有两条真实代价：
 *   · 带宽按倍数吃——3x 就要 3 倍码率的持续供给，5x 上大部分源根本喂不动，
 *     结果是「选了 5x 却一直卡」，而用户会当成播放器坏了；
 *   · 4x 往上多数浏览器**直接静音**（Chrome 的音频播放上限就是 4x），一开始只会以为是自己点错了。
 * 所以做成开关：想要的人自己打开（设置里写清楚这两句），默认那 10 档保持干净。
 *
 * 放在**文件末尾**是有意的：unimport 扫描踩过「数组常量后面紧跟的导出被静默漏掉」那个坑
 * （见文件头注释），新数组摆在所有函数之后就不会连累任何人。
 */
export const TURBO_PLAYBACK_RATES = [3.5, 4, 4.5, 5]
