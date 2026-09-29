/**
 * 「当前画质档的分片表」的唯一取法。
 *
 * 这段（`currentLevel >= 0 ? currentLevel : 0` + `levels[level].details.fragments`）原来在
 * stallRecovery（两处）、bufferMeter、scheduler 各手写一遍，改动时容易漏掉某处。
 * 收成一个函数：拿不到（无 hls / 无详情）返回 null，调用方按需取 `frags` / `details`。
 *
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */
import type HlsType from 'hls.js'

export interface CurrentFrags {
  frags: any[]
  /** 清单详情（`targetduration` 等在这里） */
  details: any
  /** 实际取用的画质档下标（`currentLevel` 未落定时为 0） */
  level: number
}

/** 当前画质档的分片表与清单详情；拿不到返回 null。 */
export function currentFrags(hls: HlsType | null | undefined): CurrentFrags | null {
  if (!hls) return null
  const level = hls.currentLevel >= 0 ? hls.currentLevel : 0
  const details = (hls as any).levels?.[level]?.details
  if (!details) return null
  return { frags: details.fragments ?? [], details, level }
}

/** 只要分片表时用这个（拿不到返回空数组）。 */
export function currentFragList(hls: HlsType | null | undefined): any[] {
  return currentFrags(hls)?.frags ?? []
}
