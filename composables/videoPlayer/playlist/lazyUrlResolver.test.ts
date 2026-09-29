/**
 * 按需取址（lazyUrlResolver）的行为钉子。
 *
 * 钉住 docs/player.md §预热与死地址自救 里那几条最容易在改动中踩碎的规则：
 * 同集去重、预热单向让路（反过来绝对不行）、三道超时、预热缓存 TTL、
 * 「前台复用预热那一发而它失败 → 自己立刻重来」、refetchCurrentUrl 每集一次的额度。
 *
 * `resolveOneUrl` / `resolvePlaylist` 是 Nuxt 自动导入的裸标识符，源码里没有 import。
 * 用 `vi.stubGlobal` 把它们钉到 globalThis 上，模拟自动导入。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import type { LazyResolverDeps } from './lazyUrlResolver'
import { useLazyUrlResolver } from './lazyUrlResolver'

function makeDeps(overrides: Partial<{ ph: string }> = {}) {
  const media = {
    videoUrl: ref(''),
    errorMessage: ref(''),
    isResolvingUrl: ref(false),
    resolveStage: ref(''),
    isRestoringFromSaved: ref(false),
  } as any

  const handoff = {
    lazyIndexByUrl: ref<Record<string, number>>({}),
    lazyTask: ref<any>(null),
    playlistSource: ref<any>(null),
    playlistNames: ref<Record<string, string>>({}),
  } as any

  const currentPlaceholder = vi.fn(() => overrides.ph ?? '')
  const applyHints = vi.fn()
  const loadVideo = vi.fn(async () => {})

  const deps: LazyResolverDeps = { media, handoff, currentPlaceholder, applyHints, loadVideo }
  return { deps, media, handoff, currentPlaceholder, applyHints, loadVideo }
}

/** 给某个占位地址接好「按需取址」的最小地基：lazyTask 非空 + 有下标 */
function wireLazy(handoff: any, placeholder: string, idx = 0) {
  handoff.lazyTask.value = { kind: 'html-source', pageUrls: [placeholder] }
  handoff.lazyIndexByUrl.value = { ...handoff.lazyIndexByUrl.value, [placeholder]: idx }
}

let resolveOneUrl: ReturnType<typeof vi.fn>
let resolvePlaylist: ReturnType<typeof vi.fn>

beforeEach(() => {
  resolveOneUrl = vi.fn(async () => 'https://real.example/video.m3u8')
  resolvePlaylist = vi.fn(async () => ({
    result: { clientTask: { kind: 'html-source', pageUrls: ['ph'], lazy: true }, lines: [{ episodes: [] }], activeLineIndex: 0 },
    cookie: '',
  }))
  vi.stubGlobal('resolveOneUrl', resolveOneUrl)
  vi.stubGlobal('resolvePlaylist', resolvePlaylist)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('同集去重', () => {
  it('同一占位地址并发两次 fetchLazyUrl → 同一个 Promise 实例，底层只发一次请求', async () => {
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'ph1')
    const { resolveLazyUrl } = useLazyUrlResolver(deps)

    // 直接触发内部去重：用 peekLazyUrl 起一发在飞的请求，再立刻用 resolveLazyUrl 复用它
    let resolveGate!: (v: string) => void
    resolveOneUrl.mockImplementationOnce(() => new Promise(r => { resolveGate = r }))

    const p1 = resolveLazyUrl('ph1')
    // 此时还没结算，第二次调用应命中同一条在飞 promise（resolveWithUi 内部走的是同一个 fetchLazyUrl）
    const p2 = resolveLazyUrl('ph1')

    resolveGate('https://real.example/1.m3u8')
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBe('https://real.example/1.m3u8')
    expect(r2).toBe('https://real.example/1.m3u8')
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)
  })
})

describe('预热单向让路', () => {
  it('前台取址在飞时，预热（peekLazyUrl）等前台结束再真正发请求', async () => {
    vi.useFakeTimers()
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'fg')
    wireLazy(handoff, 'bg', 1)
    const { resolveLazyUrl, peekLazyUrl } = useLazyUrlResolver(deps)

    let releaseFg!: (v: string) => void
    resolveOneUrl.mockImplementationOnce(() => new Promise(r => { releaseFg = r }))

    const fg = resolveLazyUrl('fg')          // 前台占住 pending
    await vi.advanceTimersByTimeAsync(0)

    const bgPromise = peekLazyUrl('bg')       // 不同占位地址 → 预热要让路
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)   // 只有前台那一发，预热还没真正调用

    releaseFg('https://real.example/fg.m3u8')
    await fg
    await vi.advanceTimersByTimeAsync(0)
    // 前台结束 → 预热才真正发起
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)

    await bgPromise
  })

  it('让路超过 GIVE_WAY_MAX(3000ms) 也会放行，不会无限等待', async () => {
    vi.useFakeTimers()
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'fg')
    wireLazy(handoff, 'bg', 1)
    const { resolveLazyUrl, peekLazyUrl } = useLazyUrlResolver(deps)

    // 前台这一发永远不结算（模拟卡住）
    resolveOneUrl.mockImplementationOnce(() => new Promise(() => {}))

    void resolveLazyUrl('fg')
    await vi.advanceTimersByTimeAsync(0)

    void peekLazyUrl('bg')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)   // 让路中，预热还没发

    await vi.advanceTimersByTimeAsync(2999)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)   // 还没到 3000ms

    await vi.advanceTimersByTimeAsync(2)
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)   // 让路闹钟到点 → 预热自己发起
  })
})

describe('反过来不让路：前台非 giveWay 请求不等预热', () => {
  it('预热在飞时，foreground（giveWay=false）立刻发起，不排队', async () => {
    vi.useFakeTimers()
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'bg')
    wireLazy(handoff, 'fg', 1)
    const { peekLazyUrl, resolveLazyUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockImplementationOnce(() => new Promise(() => {})) // 预热卡住不结算
    void peekLazyUrl('bg')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)

    // 前台走 resolveLazyUrl → resolveWithUi → fetchLazyUrl(ph)（giveWay 默认 false）
    resolveOneUrl.mockImplementationOnce(async () => 'https://real.example/fg.m3u8')
    const fgPromise = resolveLazyUrl('fg')
    await vi.advanceTimersByTimeAsync(0)
    // 不需要等待 pending 里的预热，立刻就调用了
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)

    await fgPromise
  })
})

describe('三道超时', () => {
  it('PREWARM_TIMEOUT(12000ms) 到点即失败，预热失败只写日志、peekLazyUrl 返回空串', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'bg')
    const { peekLazyUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockImplementationOnce(() => new Promise(() => {})) // 永不结算
    const p = peekLazyUrl('bg')

    await vi.advanceTimersByTimeAsync(11999)
    // 还没到点
    await vi.advanceTimersByTimeAsync(1)
    const url = await p
    expect(url).toBe('')
    expect(warn).toHaveBeenCalled()
  })

  it('RESOLVE_TIMEOUT(30000ms) 是 fetchLazyUrl 无显式 timeoutMs 时的默认死线', async () => {
    vi.useFakeTimers()
    const { deps, handoff } = makeDeps({ ph: 'ph' })
    wireLazy(handoff, 'ph')
    const { refetchCurrentUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockImplementationOnce(() => new Promise(() => {})) // 永不结算
    // silent 路径走的是裸 fetchLazyUrl(ph)（无 timeoutMs 参数）→ 默认 RESOLVE_TIMEOUT
    const p = refetchCurrentUrl(true)

    await vi.advanceTimersByTimeAsync(29999)
    await vi.advanceTimersByTimeAsync(2)
    const ok = await p
    expect(ok).toBe(false) // 取址失败（超时）→ catch 后返回空串 → fresh 为空 → false
  })
})

describe('前台复用预热那一发而它失败 → 自己立刻重来', () => {
  it('resolveLazyUrl 复用在飞的预热请求，预热失败后立刻自己重取一次并成功', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'ph')
    const { peekLazyUrl, resolveLazyUrl } = useLazyUrlResolver(deps)

    // 第一发（预热在飞的那发）失败；第二发（前台重来）成功
    let rejectFirst!: (e: unknown) => void
    resolveOneUrl.mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej }))
    resolveOneUrl.mockImplementationOnce(async () => 'https://real.example/retry.m3u8')

    const warmPromise = peekLazyUrl('ph')   // 不 await，让它挂在 inflight 里
    await Promise.resolve()

    const fgPromise = resolveLazyUrl('ph')  // 复用同一条在飞 promise（同集去重）
    rejectFirst(new Error('nb-plt 过期'))

    const url = await fgPromise
    expect(url).toBe('https://real.example/retry.m3u8')
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalled()

    await warmPromise // 预热那条自己也落定（失败，已被吞掉写日志）
  })
})

describe('hasWarmLazyUrl / resolveLazyUrl 缓存', () => {
  it('peekLazyUrl 成功后 hasWarmLazyUrl 为真，resolveLazyUrl 直接吃缓存不再调用 resolveOneUrl，且用一次就删', async () => {
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'ph')
    const { peekLazyUrl, hasWarmLazyUrl, resolveLazyUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockResolvedValueOnce('https://real.example/warm.m3u8')
    await peekLazyUrl('ph')

    expect(hasWarmLazyUrl('ph')).toBe(true)
    resolveOneUrl.mockClear()

    const url = await resolveLazyUrl('ph')
    expect(url).toBe('https://real.example/warm.m3u8')
    expect(resolveOneUrl).not.toHaveBeenCalled()

    // 用一次就删：第二次不再命中缓存，会重新走 resolveWithUi → resolveOneUrl
    resolveOneUrl.mockResolvedValueOnce('https://real.example/second.m3u8')
    const url2 = await resolveLazyUrl('ph')
    expect(url2).toBe('https://real.example/second.m3u8')
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)
  })

  it('缓存过期（超过 LAZY_URL_TTL 90000ms）不再直接返回，落回 resolveWithUi', async () => {
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'ph')
    const { peekLazyUrl, hasWarmLazyUrl, resolveLazyUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockResolvedValueOnce('https://real.example/warm.m3u8')
    await peekLazyUrl('ph')
    expect(hasWarmLazyUrl('ph')).toBe(true)
    resolveOneUrl.mockClear()

    clock += 90_000 // 到点即过期（< 判定，正好到点算过期）
    expect(hasWarmLazyUrl('ph')).toBe(false)

    resolveOneUrl.mockResolvedValueOnce('https://real.example/fresh.m3u8')
    const url = await resolveLazyUrl('ph')
    expect(url).toBe('https://real.example/fresh.m3u8')
    expect(resolveOneUrl).toHaveBeenCalledTimes(1) // 走了真实取址，不是缓存
  })
})

describe('refetchCurrentUrl 每集只硬取一次', () => {
  it('同一占位地址第二次调用直接返回 false，不再触发取址；resetRefetchQuota 后恢复', async () => {
    const { deps, handoff, loadVideo } = makeDeps({ ph: 'ph' })
    wireLazy(handoff, 'ph')
    const { refetchCurrentUrl, resetRefetchQuota } = useLazyUrlResolver(deps)

    resolveOneUrl.mockResolvedValueOnce('https://real.example/new1.m3u8')
    const first = await refetchCurrentUrl(true)
    expect(first).toBe(true)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)
    expect(loadVideo).toHaveBeenCalledTimes(1)

    resolveOneUrl.mockClear()
    const second = await refetchCurrentUrl(true)
    expect(second).toBe(false)
    expect(resolveOneUrl).not.toHaveBeenCalled()

    resetRefetchQuota()
    resolveOneUrl.mockResolvedValueOnce('https://real.example/new2.m3u8')
    const third = await refetchCurrentUrl(true)
    expect(third).toBe(true)
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)
  })
})

describe('refetchCurrentUrl：非按需取址列表直接短路', () => {
  it('lazyTask 为空 → 立即返回 false，不碰网络', async () => {
    const { deps, handoff } = makeDeps({ ph: 'ph' })
    handoff.lazyTask.value = null
    handoff.lazyIndexByUrl.value = {}
    const { refetchCurrentUrl } = useLazyUrlResolver(deps)

    const ok = await refetchCurrentUrl(true)
    expect(ok).toBe(false)
    expect(resolveOneUrl).not.toHaveBeenCalled()
  })

  it('lazyIndexByUrl 里查不到该占位地址下标 → 立即返回 false', async () => {
    const { deps, handoff } = makeDeps({ ph: 'ph' })
    handoff.lazyTask.value = { kind: 'html-source', pageUrls: ['ph'] }
    handoff.lazyIndexByUrl.value = {} // 没有 'ph' 这个 key
    const { refetchCurrentUrl } = useLazyUrlResolver(deps)

    const ok = await refetchCurrentUrl(true)
    expect(ok).toBe(false)
    expect(resolveOneUrl).not.toHaveBeenCalled()
  })
})

describe('doFetchLazyUrl 令牌过期重试一次', () => {
  it('第一次失败且有 playlistSource → 用 resolvePlaylist 换新作业单重试一次并成功', async () => {
    const { deps, handoff } = makeDeps()
    wireLazy(handoff, 'ph')
    handoff.playlistSource.value = { pageUrl: 'https://site.example/p', line: 0 }
    handoff.playlistNames.value = { ph: '第1集' }
    const { resolveLazyUrl } = useLazyUrlResolver(deps)

    resolvePlaylist.mockResolvedValueOnce({
      result: {
        clientTask: { kind: 'html-source', pageUrls: ['ph'], lazy: true },
        lines: [{ episodes: [{ title: '第1集' }] }],
        activeLineIndex: 0,
      },
      cookie: '',
    })
    resolveOneUrl
      .mockRejectedValueOnce(new Error('令牌过期'))
      .mockResolvedValueOnce('https://real.example/retried.m3u8')

    const url = await resolveLazyUrl('ph')
    expect(url).toBe('https://real.example/retried.m3u8')
    expect(resolvePlaylist).toHaveBeenCalledTimes(1)
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)
  })

  it('重试也失败 → 错误继续往外抛，不会无限重试', async () => {
    const { deps, handoff, media } = makeDeps()
    wireLazy(handoff, 'ph')
    handoff.playlistSource.value = { pageUrl: 'https://site.example/p', line: 0 }
    const { resolveLazyUrl } = useLazyUrlResolver(deps)

    resolvePlaylist.mockResolvedValueOnce({
      result: {
        clientTask: { kind: 'html-source', pageUrls: ['ph'], lazy: true },
        lines: [{ episodes: [] }],
        activeLineIndex: 0,
      },
      cookie: '',
    })
    resolveOneUrl
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockRejectedValueOnce(new Error('第二次也失败'))

    const url = await resolveLazyUrl('ph')
    // resolveWithUi 兜底捕获所有错误 → 返回空串并写 errorMessage，不会抛出到调用方
    expect(url).toBe('')
    expect(media.errorMessage.value).toContain('第二次也失败')
    expect(resolveOneUrl).toHaveBeenCalledTimes(2)
    expect(resolvePlaylist).toHaveBeenCalledTimes(1) // 只重试一次
  })

  it('playlistSource 为空 → 不调用 resolvePlaylist，原始错误直接冒泡', async () => {
    const { deps, handoff, media } = makeDeps()
    wireLazy(handoff, 'ph')
    handoff.playlistSource.value = null
    const { resolveLazyUrl } = useLazyUrlResolver(deps)

    resolveOneUrl.mockRejectedValueOnce(new Error('没有来源页，取址失败'))

    const url = await resolveLazyUrl('ph')
    expect(url).toBe('')
    expect(media.errorMessage.value).toContain('没有来源页，取址失败')
    expect(resolvePlaylist).not.toHaveBeenCalled()
    expect(resolveOneUrl).toHaveBeenCalledTimes(1)
  })
})
