/**
 * cdndefend 工作量证明求解器（浏览器侧）
 *
 * 站点首访返回一个挑战页：给定常量 c，要求暴力找出最小整数 nonce，
 * 使 SHA1(c + nonce) 的第 n1、n1+1 字节等于目标值（实测 0xB0 0x0B），
 * 然后带着 cookie `cdndefend_js_cookie = c + nonce` 重新请求。
 *
 * 为什么放在前端算：
 *   期望迭代约 65536 次（命中 2 个指定字节），实测 ~250ms CPU。
 *   CF Workers 免费版每请求仅 10ms CPU，服务端硬算必超；而挑战是纯 SHA1、
 *   不依赖 DOM 或浏览器指纹，放前端算完全等价。
 *
 * 为什么不用 crypto.subtle.digest：
 *   它是异步的，6.5 万次 await 的微任务调度开销比哈希本身大一个量级。
 *   这里内置同步 SHA1，配合分块让出主线程，既快又不冻界面。
 */

// 输入恒为「40 位十六进制常量 + 十进制 nonce」，长度 40~48 字节，
// 永远落在单个 512 位分组内（≤55 字节），所以这里只实现单块 SHA1。
const MAX_SINGLE_BLOCK = 55

const w = new Int32Array(80)

/** 单块 SHA1，返回 5 个 32 位字（大端）。仅接受 ASCII 且长度 ≤ 55。 */
function sha1SingleBlock(ascii: string): [number, number, number, number, number] {
  const len = ascii.length
  w.fill(0, 0, 16)
  for (let i = 0; i < len; i++) {
    w[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << (24 - (i & 3) * 8)
  }
  w[len >> 2] |= 0x80 << (24 - (len & 3) * 8)
  w[15] = len * 8   // 长度 < 2^29 位，高 32 位恒为 0

  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
    w[i] = (x << 1) | (x >>> 31)
  }

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476, e = 0xc3d2e1f0
  for (let i = 0; i < 80; i++) {
    let f: number, k: number
    if (i < 20)      { f = (b & c) | (~b & d);          k = 0x5a827999 }
    else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ed9eba1 }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
    else             { f = b ^ c ^ d;                   k = 0xca62c1d6 }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
  }

  return [
    (0x67452301 + a) | 0,
    (0xefcdab89 + b) | 0,
    (0x98badcfe + c) | 0,
    (0x10325476 + d) | 0,
    (0xc3d2e1f0 + e) | 0,
  ]
}

/** 从 5 个字里取第 idx 个字节（0-19） */
function byteAt(words: [number, number, number, number, number], idx: number): number {
  return (words[idx >> 2] >>> (24 - (idx & 3) * 8)) & 0xff
}

export interface PowOptions {
  /** 每完成一批回调一次，用于显示进度 */
  onProgress?: (tried: number) => void
  /** 让出主线程的批大小。太小会被 setTimeout 的 4ms 钳制拖慢 */
  chunk?: number
  /** 硬上限，防止站点改规则后无限空转 */
  maxTries?: number
}

export interface PowResult {
  nonce: number
  cookie: string   // c + nonce，直接作为 cdndefend_js_cookie 的值
  tried: number
  ms: number
}

export async function solvePow(
  c: string,
  n1: number,
  target: [number, number],
  opts: PowOptions = {},
): Promise<PowResult> {
  const { onProgress, chunk = 20000, maxTries = 5_000_000 } = opts

  if (!c || !/^[0-9A-Fa-f]{40}$/.test(c)) throw new Error('挑战常量格式异常：' + c)
  if (!Number.isFinite(n1) || n1 < 0 || n1 > 18) throw new Error('校验偏移异常：' + n1)

  const started = Date.now()
  const [t0, t1] = target
  let i = 0

  while (i < maxTries) {
    const stop = Math.min(i + chunk, maxTries)
    for (; i < stop; i++) {
      const s = c + i
      // 理论上不会发生（40+8=48），但规则若变长要立刻暴露而不是算出错值
      if (s.length > MAX_SINGLE_BLOCK) throw new Error('挑战输入超出单块 SHA1 上限')
      const h = sha1SingleBlock(s)
      if (byteAt(h, n1) === t0 && byteAt(h, n1 + 1) === t1) {
        return { nonce: i, cookie: c + i, tried: i + 1, ms: Date.now() - started }
      }
    }
    onProgress?.(i)
    // 让出主线程，避免解析时页面卡死
    await new Promise(r => setTimeout(r, 0))
  }

  throw new Error(`工作量证明超过 ${maxTries} 次仍未命中，站点规则可能已变更`)
}

/** 自测用：已知 c/n1 的基准值应算出 nonce=115961 */
export function powSelfTest(): boolean {
  const c = '660B90B9446FA672F41C14B27BC383739AD5F9F1'
  const h = sha1SingleBlock(c + 115961)
  return byteAt(h, 6) === 0xb0 && byteAt(h, 7) === 0x0b
}
