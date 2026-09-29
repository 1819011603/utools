/**
 * 「网络变了」唯一信号源的行为钉子（netWatch）。
 *
 * 三个信号（online/offline、connection.change、回前台）归并成「有没有网」+「刚变过没有」。
 * 模块是单例（`inited`/`lastConnSig` 是模块级），每个用例 `resetModules` + 动态 import 拿干净实例，
 * 并 stub 掉 window/document/navigator。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

function makeEnv() {
  const winH: Record<string, Function[]> = {}
  const docH: Record<string, Function[]> = {}
  const connH: Record<string, Function[]> = {}
  const nav: any = {
    onLine: true,
    connection: { type: 'wifi', effectiveType: '4g', addEventListener: (t: string, cb: Function) => { (connH[t] ||= []).push(cb) } },
  }
  const win: any = { addEventListener: (t: string, cb: Function) => { (winH[t] ||= []).push(cb) } }
  const doc: any = { visibilityState: 'visible', addEventListener: (t: string, cb: Function) => { (docH[t] ||= []).push(cb) } }
  const fire = (map: Record<string, Function[]>, t: string) => (map[t] || []).forEach(cb => cb())
  return { nav, win, doc, winH, docH, connH, fire }
}

async function load(env: ReturnType<typeof makeEnv>) {
  vi.resetModules()
  vi.stubGlobal('window', env.win)
  vi.stubGlobal('document', env.doc)
  vi.stubGlobal('navigator', env.nav)
  return await import('./netWatch')
}

let clock = 1000
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('isOffline / 信号订阅', () => {
  it('isOffline 跟着 navigator.onLine', async () => {
    const env = makeEnv()
    const nw = await load(env)
    expect(nw.isOffline()).toBe(false)
    env.nav.onLine = false
    expect(nw.isOffline()).toBe(true)
  })

  it('online 事件 → 订阅者被叫醒', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.fire(env.winH, 'online')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('退订后不再收到', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    const off = nw.onNetChange(cb)
    off()
    env.fire(env.winH, 'online')
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('connection.change：只认「真的换网」', () => {
  it('连接特征变了 → 叫醒', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.nav.connection.effectiveType = '3g'   // wifi/4g → wifi/3g
    env.fire(env.connH, 'change')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('特征没变（带宽估计抖动）→ 不叫醒', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.fire(env.connH, 'change')
    expect(cb).not.toHaveBeenCalled()
  })

  it('没网时的 change 没意义 → 不叫醒（等 online 那一发）', async () => {
    const env = makeEnv()
    env.nav.onLine = false
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.nav.connection.effectiveType = '2g'
    env.fire(env.connH, 'change')
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('回前台：后台期间 change 会被吞，靠它补', () => {
  it('可见且连接已变 → 叫醒', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.nav.connection.effectiveType = '3g'
    env.doc.visibilityState = 'visible'
    env.fire(env.docH, 'visibilitychange')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('特征没变 → 不折腾正在播的流', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.onNetChange(cb)
    env.fire(env.docH, 'visibilitychange')
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('isRecovering：短窗口', () => {
  it('刚变过 → true；过了窗口 → false', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const env = makeEnv()
    const nw = await load(env)
    nw.onNetChange(() => {})   // init 注册 window 监听
    expect(nw.isRecovering()).toBe(false)
    env.fire(env.winH, 'online')          // lastChangeAt = 1000
    expect(nw.isRecovering()).toBe(true)
    clock = 1000 + 8000                    // 窗口正好到点
    expect(nw.isRecovering()).toBe(false)
  })

  it('断网时不算「恢复中」', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const env = makeEnv()
    const nw = await load(env)
    nw.onNetChange(() => {})   // init 注册 window 监听
    env.fire(env.winH, 'online')
    env.nav.onLine = false
    expect(nw.isRecovering()).toBe(false)
  })
})

describe('waitForNet：幂等 + 一次性 + 已经有网就直接跑', () => {
  it('已经有网 → 下一拍就跑', async () => {
    const env = makeEnv()
    const nw = await load(env)
    const cb = vi.fn()
    nw.waitForNet(cb)
    await new Promise(r => setTimeout(r, 0))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('断网 → 挂起，等 online 那一发', async () => {
    const env = makeEnv()
    env.nav.onLine = false
    const nw = await load(env)
    const cb = vi.fn()
    nw.waitForNet(cb)
    await new Promise(r => setTimeout(r, 0))
    expect(cb).not.toHaveBeenCalled()
    env.nav.onLine = true
    env.fire(env.winH, 'online')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
