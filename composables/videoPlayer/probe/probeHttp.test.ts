/**
 * 探测底层 IO 的行为钉子（probeHttp）。
 *
 * 钉住 docs/player.md §代理与探测 里最容易被悄悄改坏的几条：mixed content 短路、
 * 绝不加 Range 头（与真实请求同形）、`unknown`（超时）≠ `fail`、判定恒按 CHANNEL_ORDER、
 * 两根轴等待器的「预算」与「对冲窗口不收工」语义、以及那组超时/预算常量本身。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AxisProbe } from '../useReachabilityProbe'
import { CHANNEL_ORDER } from '../useReachabilityProbe'
import {
  probeUrl, pickChannel, needsHeadersChannel, isMixedContent, makeAxisWaiter,
  PRIORITY_BUDGET, HEDGE_DELAY, DEFAULT_TIMEOUT, OVERALL_TIMEOUT,
} from './probeHttp'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const axis = (partial: Partial<AxisProbe> = {}): AxisProbe => ({ direct: 'skip', disguise: 'skip', headers: 'skip', ms: {}, ...partial })

describe('probeUrl：mixed content 短路', () => {
  it('https 页面探 http:// 地址 → 直接判 fail，连 fetch 都不发', async () => {
    vi.stubGlobal('location', { protocol: 'https:' } as any)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await probeUrl('http://foo.com/a.ts', 1000)
    expect(r).toEqual({ reach: 'fail', ms: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('http 页面探 http:// 地址（不构成 mixed content）→ 照常发 fetch', async () => {
    vi.stubGlobal('location', { protocol: 'http:' } as any)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, body: undefined })))
    const r = await probeUrl('http://foo.com/a.ts', 1000)
    expect(r.reach).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('probeUrl：只要响应头，拿到就取消 body', () => {
  it('res.ok → reach ok，记录 status，且调用 res.body.cancel() 取消下载', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, body: { cancel } })))
    const r = await probeUrl('https://foo.com/a.ts', 1000)
    expect(r.reach).toBe('ok')
    expect(r.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('probeUrl：unknown（超时）≠ fail', () => {
  it('内部超时触发 abort → reach unknown，不是 fail', async () => {
    vi.useFakeTimers()
    // fetch 永不自行落定，只在收到 abort 信号时才拒绝——模拟「请求还没回来，是我们自己的计时器判的超时」
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: any) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const p = probeUrl('https://foo.com/a.ts', 100)
    await vi.advanceTimersByTimeAsync(100)
    const r = await p
    expect(r.reach).toBe('unknown')
  })

  it('fetch 直接拒绝（非我们的超时）→ reach fail', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    const r = await probeUrl('https://foo.com/a.ts', 1000)
    expect(r.reach).toBe('fail')
  })
})

describe('probeUrl：绝不能加 Range 头或任何自定义头', () => {
  it('fetch 调用只传 signal 与 referrerPolicy，不带 headers 键', async () => {
    const fetchSpy = vi.fn((_url: string, _opts: RequestInit) => Promise.resolve({ ok: true, status: 200, body: undefined }))
    vi.stubGlobal('fetch', fetchSpy)
    await probeUrl('https://foo.com/a.ts', 1000)
    const [, opts] = fetchSpy.mock.calls[0]
    expect(Object.keys(opts).sort()).toEqual(['referrerPolicy', 'signal'])
    expect(opts).not.toHaveProperty('headers')
  })
})

describe('pickChannel：恒按 CHANNEL_ORDER 优先级取，不按到达顺序 / 对象键序', () => {
  // 曾是 bug：CHANNEL_ORDER 定义在上层、这里靠自动导入当全局用，离开 Nuxt 编译即 ReferenceError（已下沉到 probeHttp）
  it('disguise ok、direct fail → 选 disguise（唯一可达的）', () => {
    expect(pickChannel(axis({ direct: 'fail', disguise: 'ok', headers: 'skip' }))).toBe('disguise')
  })

  it('direct 与 disguise 都 ok → 选优先级更高的 direct，不是随便一个', () => {
    expect(pickChannel(axis({ direct: 'ok', disguise: 'ok', headers: 'ok' }))).toBe('direct')
  })

  it('全 unknown / skip（没有一条实测 ok）→ null，unknown 不算可达', () => {
    expect(pickChannel(axis({ direct: 'unknown', disguise: 'skip', headers: 'unknown' }))).toBeNull()
  })
})

describe('needsHeadersChannel：只有 direct 和 disguise 都没通才值得补第三路', () => {
  it('direct fail、disguise fail → true', () => {
    expect(needsHeadersChannel(axis({ direct: 'fail', disguise: 'fail' }))).toBe(true)
  })
  it('direct ok → false（哪怕 disguise 没测）', () => {
    expect(needsHeadersChannel(axis({ direct: 'ok', disguise: 'skip' }))).toBe(false)
  })
  it('disguise ok → false（哪怕 direct 没测）', () => {
    expect(needsHeadersChannel(axis({ direct: 'skip', disguise: 'ok' }))).toBe(false)
  })
  it('direct unknown、disguise unknown（都没通）→ true', () => {
    expect(needsHeadersChannel(axis({ direct: 'unknown', disguise: 'unknown' }))).toBe(true)
  })
})

describe('isMixedContent：非浏览器环境（location 未定义）一律判 false', () => {
  it('不 stub location（node 下本就没有该全局）→ false，即便是 http:// 地址', () => {
    expect(typeof location).toBe('undefined')
    expect(isMixedContent('http://foo.com/a.ts')).toBe(false)
  })
})

describe('makeAxisWaiter：优先级预算——有可达通道 + 预算烧完才收工', () => {
  it('budgetMs=0（清单轴）→ 首个可达通道一到就立刻收工', async () => {
    vi.useFakeTimers()
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const w = makeAxisWaiter(() => false, 0)
    const never = new Promise(() => {})
    const p = w.wait(never, Infinity)
    w.noteOk()
    // 下一个 GRACE_TICK（50ms）轮询就该看到 hasOk 且预算(0)已烧完
    clock += 50
    await vi.advanceTimersByTimeAsync(50)
    await p
    expect(w.st.settled).toBe(true)
  })

  it('budgetMs>0 → 预算没烧完之前不收工，烧完之后才收工（不能提前）', async () => {
    vi.useFakeTimers()
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const w = makeAxisWaiter(() => false, 400)
    const never = new Promise(() => {})
    const p = w.wait(never, Infinity)
    w.noteOk()
    // 预算烧到一半：还不该收工
    clock += 200
    await vi.advanceTimersByTimeAsync(200)
    expect(w.st.settled).toBe(false)
    // 预算烧完：现在该收工了
    clock += 250
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(w.st.settled).toBe(true)
  })
})

describe('makeAxisWaiter：对冲窗口（maxWait）到点只返回，不收工', () => {
  it('maxWait 到了但从未 noteOk → wait() 照常返回，但 settled 仍是 false，留给调用方去补下一条通道', async () => {
    vi.useFakeTimers()
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const w = makeAxisWaiter(() => false, 1000)
    const never = new Promise(() => {})
    const p = w.wait(never, HEDGE_DELAY)
    for (let i = 0; i < 6; i++) { // 6 * 50ms = 300ms > HEDGE_DELAY(250)
      clock += 50
      await vi.advanceTimersByTimeAsync(50)
    }
    await p // 不因未收工而挂住——maxWait 到了就必须返回
    expect(w.st.settled).toBe(false)
  })
})

describe('makeAxisWaiter：reopen 重新开闸', () => {
  it('已收工的等待器 reopen 后不再是 settled，须重新等满预算才会再次收工', async () => {
    vi.useFakeTimers()
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const w = makeAxisWaiter(() => false, 400)
    const never = new Promise(() => {})

    // 第一轮：烧满预算，收工
    const p1 = w.wait(never, Infinity)
    w.noteOk()
    clock += 400
    await vi.advanceTimersByTimeAsync(400)
    await p1
    expect(w.st.settled).toBe(true)

    // reopen：settled/hasOk 复位，since 从这一刻重新起算
    w.reopen()
    expect(w.st.settled).toBe(false)
    expect(w.st.hasOk).toBe(false)

    // 补测：noteOk 之后，预算还没从 reopen 点烧满之前不能收工
    const p2 = w.wait(never, Infinity)
    w.noteOk()
    clock += 200
    await vi.advanceTimersByTimeAsync(200)
    expect(w.st.settled).toBe(false)

    // 从 reopen 点算满 400ms 才收工——不是复用上一轮已经烧掉的额度
    clock += 250
    await vi.advanceTimersByTimeAsync(250)
    await p2
    expect(w.st.settled).toBe(true)
  })
})

describe('sanity：两级超时与预算常量', () => {
  it('PRIORITY_BUDGET=400, HEDGE_DELAY=250, DEFAULT_TIMEOUT=8000, OVERALL_TIMEOUT=12000', () => {
    expect(PRIORITY_BUDGET).toBe(400)
    expect(HEDGE_DELAY).toBe(250)
    expect(DEFAULT_TIMEOUT).toBe(8000)
    expect(OVERALL_TIMEOUT).toBe(12000)
  })
})

// CHANNEL_ORDER 只在这里被拿来构造用例期望值，防止上面几组用例的假设（direct 优先于 disguise/headers）本身跑偏
describe('sanity：CHANNEL_ORDER 顺序即 pickChannel 的判定顺序', () => {
  it('direct、disguise、headers 三档，顺序不能变', () => {
    expect(CHANNEL_ORDER).toEqual(['direct', 'disguise', 'headers'])
  })
})
