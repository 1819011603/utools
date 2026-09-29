/**
 * 读一个分片响应体，带「无进展看门狗」。
 *
 * 治的是「连接建立了、headers 也回了，但 body 一直不吐数据」（大小一直不变）——
 * 只靠「总时长超时」会白占一条连接 + 一个 lane 槽那么久（预取那条是 5 分钟）。
 * 这里按**字节进展**判死：`stallMs` 内一个新字节都没有 → abort 并抛 `StallError`。
 * 慢但在下的分片不受影响——每个 chunk 都会续期。
 *
 * 环境不支持流式（`res.body` 为空）时退回整体读，仍有上层的总超时兜底。
 * 内部实现模块，走显式相对 import，不进 `nuxt.config.ts` 的 `imports.dirs`。
 */

/** 无进展判死时抛这个（`name` 便于上层区分「卡死」与「真失败」） */
export class StallError extends Error {
  constructor(stallMs: number) {
    super(`no progress for ${stallMs}ms`)
    this.name = 'StallError'
  }
}

export async function fetchBodyWithStallWatch(
  ctrl: AbortController,
  url: string,
  stallMs: number,
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) return res.arrayBuffer()   // 环境不支持流式 → 退回整体读

  let lastAt = performance.now()
  let stalled = false
  const watchdog = setInterval(() => {
    if (performance.now() - lastAt >= stallMs) { stalled = true; ctrl.abort() }
  }, Math.max(500, Math.min(2000, stallMs)))

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) { chunks.push(value); total += value.byteLength; lastAt = performance.now() }
    }
  } catch (e) {
    // 看门狗主动 abort 的，报「卡死」而不是「被取消」——上层据此决定要不要换 lane
    if (stalled) throw new StallError(stallMs)
    throw e
  } finally {
    clearInterval(watchdog)
  }

  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out.buffer
}
