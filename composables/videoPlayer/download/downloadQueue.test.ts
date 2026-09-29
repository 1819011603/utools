/**
 * 下载队列（downloadQueue）的行为钉子：模块级单例、串行、状态机。
 *
 * 队列本身不关心「怎么把字节取回来」——那是 hlsEpisode 的事，已经在
 * hlsEpisode.test.ts 里钉过了。这里只测队列自己的职责：入队去重、
 * 串行调度（不会两集同时跑）、取消/完成/失败状态迁移、beforeunload 提示的
 * 生命周期、以及「已下载文件」的取回。
 *
 * 模块是**模块级单例**（`tasks`/`running`/`runtime`/`dirHandle` 都是模块作用域变量），
 * 每个用例用 `vi.resetModules()` + 动态 `import('./downloadQueue')` 拿一份干净实例，
 * 同 `netWatch.test.ts` 的做法。`window` 在 node 环境下不存在（`pump()` 里
 * `beforeunload` 监听要用），每次重新 import 前先 stub 一份假的。
 *
 * `downloadHlsEpisode` / `createSink` 用 `vi.mock` 换成可编排的假实现：
 * 真实下载逻辑不是这个文件的职责，这里只关心队列怎么调度它、怎么应对它的
 * 成功/失败/取消。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  impl: null as null | ((url: string, makeSink: any, deps: any) => Promise<any>),
  concurrentCount: 0,
  maxConcurrent: 0,
}))
vi.mock('./hlsEpisode', () => ({
  downloadHlsEpisode: async (url: string, makeSink: any, deps: any) => {
    h.concurrentCount++
    h.maxConcurrent = Math.max(h.maxConcurrent, h.concurrentCount)
    try {
      if (h.impl) return await h.impl(url, makeSink, deps)
      // 默认实现：真实 downloadHlsEpisode 会调 makeSink(ext) 来落地 task.fileName，
      // 假实现不调的话，凡是断言 fileName 的用例都测不出真实行为
      await makeSink('ts')
      return { ext: 'ts', bytes: 100, skipped: 0 }
    } finally {
      h.concurrentCount--
    }
  },
}))
vi.mock('./fileSink', () => ({
  createSink: vi.fn(async (_dir: any, _fileName: string) => ({
    write: async () => {},
    close: async () => {},
    abort: async () => {},
    checkProjected: () => '',
    patchAt: async () => {},
  })),
  // 身份函数：这个模块自己的职责只是「调 safeFileName 再拼扩展名」，
  // 洗名字规则本身（去掉非法字符等）是 fileSink.ts 的事，不在这里重复验证
  safeFileName: (name: string) => name,
}))

function makeWindowStub() {
  const handlers: Record<string, Array<(e: any) => void>> = {}
  return {
    addEventListener: vi.fn((t: string, cb: any) => { (handlers[t] ||= []).push(cb) }),
    removeEventListener: vi.fn((t: string, cb: any) => {
      const arr = handlers[t]
      if (!arr) return
      const i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    }),
    listenerCount: (t: string) => (handlers[t] || []).length,
  }
}

async function loadQueue() {
  vi.resetModules()
  return await import('./downloadQueue')
}

beforeEach(() => {
  h.impl = null
  h.concurrentCount = 0
  h.maxConcurrent = 0
})
afterEach(() => { vi.unstubAllGlobals() })

describe('enqueue：去重规则', () => {
  it('同一 placeholder 已经在队列（queued/running/done）时不重复入队', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    // resolveUrl 卡住不 resolve：让第一条任务停在 running，才测得出「running 也算重复」
    dq.setQueueRuntime({
      resolveUrl: () => new Promise(() => {}),
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))   // 让 pump 把第一条推进 running
    expect(dq.tasks[0]!.state).toBe('running')
    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    expect(dq.tasks.filter(t => t.placeholder === 'p1')).toHaveLength(1)
  })

  it('已取消/已失败的旧任务不挡新任务重新入队', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))
    expect(dq.tasks[0]!.state).toBe('failed')   // 没设 runtime，必失败
    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    expect(dq.tasks.filter(t => t.placeholder === 'p1')).toHaveLength(2)
  })
})

describe('runtime 未就绪：直接判失败，不抛出未捕获异常', () => {
  it('没有 setQueueRuntime → 任务落定为 failed，错误文案是「播放器还没就绪」', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))
    expect(dq.tasks[0]!.state).toBe('failed')
    expect(dq.tasks[0]!.error).toBe('播放器还没就绪')
  })
})

describe('串行调度：一次只跑一个任务', () => {
  it('两个任务入队，downloadHlsEpisode 同一时刻的并发数从未超过 1', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    h.impl = async () => { await new Promise(r => setTimeout(r, 10)); return { ext: 'ts', bytes: 10, skipped: 0 } }

    dq.enqueue([
      { epName: '1', fileBase: '01-剧名', placeholder: 'p1' },
      { epName: '2', fileBase: '02-剧名', placeholder: 'p2' },
    ])
    // 等两个任务都落定
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))

    expect(h.maxConcurrent).toBe(1)
    expect(dq.tasks.every(t => t.state === 'done')).toBe(true)
  })

  it('running 在有任务跑的时候是 true，队列空了之后变回 false', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    let resolveDownload: (() => void) | null = null
    h.impl = () => new Promise(resolve => {
      resolveDownload = () => resolve({ ext: 'ts', bytes: 10, skipped: 0 })
    })

    dq.enqueue([{ epName: '1', fileBase: '01-剧名', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))
    expect(dq.running.value).toBe(true)

    resolveDownload!()
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))
    expect(dq.running.value).toBe(false)
  })
})

describe('文件名：只负责 safeFileName(fileBase) + 扩展名，不做补零/拼剧名', () => {
  it('下载成功后 fileName 是 fileBase 原样加上 downloadHlsEpisode 返回的扩展名', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    h.impl = async (_url, makeSink) => { await makeSink('mp4'); return { ext: 'mp4', bytes: 10, skipped: 0 } }
    // fileBase 已经是补过零、拼过剧名的最终结果——按模块头注释，这一步在「上层」完成，
    // 队列这里只管照抄再加扩展名
    dq.enqueue([{ epName: '2', fileBase: '02-现在不是出轨的问题', placeholder: 'p1' }])
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))
    expect(dq.tasks[0]!.fileName).toBe('02-现在不是出轨的问题.mp4')
  })
})

describe('cancel：排队中的直接标记取消；正在跑的要真的中止', () => {
  it('取消一个还在排队的任务 → 立刻变成 canceled，不会被后来的 pump 跑起来', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    let resolveFirst: (() => void) | null = null
    h.impl = () => new Promise(resolve => {
      resolveFirst = () => resolve({ ext: 'ts', bytes: 1, skipped: 0 })
    })

    dq.enqueue([
      { epName: '1', fileBase: '01', placeholder: 'p1' },
      { epName: '2', fileBase: '02', placeholder: 'p2' },
    ])
    await new Promise(r => setTimeout(r, 0))   // 让第一个任务进入 running
    const second = dq.tasks.find(t => t.placeholder === 'p2')!
    dq.cancel(second.id)
    expect(second.state).toBe('canceled')

    resolveFirst!()
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))
    expect(second.state).toBe('canceled')   // pump 跳过了它，没有被后续调度覆盖状态
  })

  it('取消一个正在跑的任务 → AbortController 被 abort，downloadHlsEpisode 收到的 signal.aborted 为 true', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    let capturedSignal: AbortSignal | null = null
    let started: (() => void) | null = null
    const startedPromise = new Promise<void>(r => { started = r })
    h.impl = (_url, _makeSink, deps) => {
      capturedSignal = deps.signal
      started!()
      return new Promise((_resolve, reject) => {
        deps.signal.addEventListener('abort', () => {
          const err: any = new DOMException('已取消', 'AbortError')
          reject(err)
        })
      })
    }

    dq.enqueue([{ epName: '1', fileBase: '01', placeholder: 'p1' }])
    await startedPromise
    const task = dq.tasks[0]!
    dq.cancel(task.id)

    expect(capturedSignal!.aborted).toBe(true)
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))
    expect(task.state).toBe('canceled')
  })
})

describe('clearFinished：只清落定的任务，排队中/运行中的留着', () => {
  it('清掉 done/failed/canceled，留下 queued', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    // 不设 runtime：入队即失败，落定成 failed
    dq.enqueue([{ epName: '1', fileBase: '01', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))
    expect(dq.tasks[0]!.state).toBe('failed')

    // 手动追加一条排在队列里但不会被本轮 pump 处理的（pump 已经跑完退出了，
    // 这条不会自动被拾取，正好用来验证 clearFinished 不动 queued 状态的任务）
    dq.tasks.push({
      id: 'manual-1', epName: '2', fileBase: '02', placeholder: 'p2',
      state: 'queued', segDone: 0, segTotal: 0, bytes: 0, kbps: 0, conn: 0, skipped: 0,
      error: '', fileName: '',
    })

    dq.clearFinished()
    expect(dq.tasks).toHaveLength(1)
    expect(dq.tasks[0]!.state).toBe('queued')
  })
})

describe('pendingCount：只数 queued 和 running', () => {
  it('done/failed/canceled 不计入待处理数', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.enqueue([{ epName: '1', fileBase: '01', placeholder: 'p1' }])   // 会失败
    await new Promise(r => setTimeout(r, 0))
    expect(dq.pendingCount()).toBe(0)

    dq.tasks.push({
      id: 'manual-2', epName: '2', fileBase: '02', placeholder: 'p2',
      state: 'queued', segDone: 0, segTotal: 0, bytes: 0, kbps: 0, conn: 0, skipped: 0,
      error: '', fileName: '',
    })
    expect(dq.pendingCount()).toBe(1)
  })
})

describe('beforeunload 提示：挂在队列生命周期上，不挂在组件上', () => {
  it('有任务在跑时注册监听，队列空了之后摘掉', async () => {
    const win = makeWindowStub()
    vi.stubGlobal('window', win)
    const dq = await loadQueue()
    dq.setQueueRuntime({
      resolveUrl: async (p: string) => 'https://cdn.example.com/' + p,
      origin: () => '', referer: () => '',
      getSegBuf: () => null, concurrency: () => 16, holdReason: () => '',
      wantMp4: () => false,
    })
    let resolveDownload: (() => void) | null = null
    h.impl = () => new Promise(resolve => { resolveDownload = () => resolve({ ext: 'ts', bytes: 1, skipped: 0 }) })

    dq.enqueue([{ epName: '1', fileBase: '01', placeholder: 'p1' }])
    await new Promise(r => setTimeout(r, 0))
    expect(win.listenerCount('beforeunload')).toBe(1)

    resolveDownload!()
    while (dq.pendingCount() > 0) await new Promise(r => setTimeout(r, 5))
    expect(win.listenerCount('beforeunload')).toBe(0)
  })
})

describe('下载目录与已下载文件', () => {
  it('setDownloadDir 之后 hasDownloadDir 为 true，getDownloadedFile 能拿到文件', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    expect(dq.hasDownloadDir()).toBe(false)

    const fakeFile = { name: 'a.mp4' }
    const fakeDir = { getFileHandle: vi.fn(async (name: string) => ({ getFile: async () => ({ ...fakeFile, name }) })) }
    dq.setDownloadDir(fakeDir)
    expect(dq.hasDownloadDir()).toBe(true)

    const f = await dq.getDownloadedFile('02-剧名.mp4')
    expect(f).toEqual({ name: '02-剧名.mp4' })
  })

  it('文件已被挪走/句柄失效（getFileHandle 抛错）→ 安静返回 null', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    dq.setDownloadDir({ getFileHandle: vi.fn(async () => { throw new Error('not found') }) })
    const f = await dq.getDownloadedFile('missing.mp4')
    expect(f).toBeNull()
  })

  it('没有目录句柄时 getDownloadedFile 直接返回 null，不报错', async () => {
    vi.stubGlobal('window', makeWindowStub())
    const dq = await loadQueue()
    const f = await dq.getDownloadedFile('x.mp4')
    expect(f).toBeNull()
  })
})
