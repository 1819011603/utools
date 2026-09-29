/**
 * 播放列表「进度记忆 + 追剧续看」的行为钉子（progress.ts）。
 *
 * 钉的是 docs/player.md §切集门闩与进度 里那条踩过的坑：存进度必须认
 * 「媒体元素真装着的那一集」`playingIndex`，不能用乐观的 `currentIndex`；
 * `progressKey`（恢复用）仍按 `currentIndex`，两者互不影响。
 * 以及片尾区删记录、finishedThreshold 地板、clearAllProgress 等纯函数规则。
 *
 * 范围边界：debounce 与 `!isSwitching` 兜底不在 progress.ts 里，
 * 那是调用方 useVideoEvents.ts（5 秒节流 + `if (!playlist.isSwitching.value)`）的职责，
 * 本文件不覆盖、也不该覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

vi.mock('../../cloudSyncLocal', () => ({ onSyncApplied: vi.fn(() => vi.fn()) }))

const watchHistory = { recordWatch: vi.fn(), findWatch: vi.fn(() => null) }
vi.stubGlobal('useWatchHistory', () => watchHistory)

import { usePlaylistProgress } from './progress'
import type { PlaylistProgressDeps } from './progress'

interface Setup {
  deps: PlaylistProgressDeps
  progress: ReturnType<typeof usePlaylistProgress>
  setPlayingIndex: (i: number) => void
}

function setup(opts: {
  playlist?: string[]
  currentIndex?: number
  playingIndex?: number
  names?: Record<string, string>
} = {}): Setup {
  const playlist = ref(opts.playlist ?? ['ep0.m3u8', 'ep1.m3u8', 'ep2.m3u8', 'ep3.m3u8', 'ep4.m3u8', 'ep5.m3u8'])
  const currentIndex = ref(opts.currentIndex ?? 0)
  let playingIndex = opts.playingIndex ?? currentIndex.value

  const media = {
    videoUrl: ref(''),
    savedProgress: ref<Record<string, number>>({}),
    currentTime: ref(0),
    duration: ref(0),
    skipOutro: ref(0),
  } as unknown as PlaylistProgressDeps['media']

  const names = opts.names ?? {}
  const handoff = {
    getVideoName: vi.fn((url: string, index: number) => names[url] ?? `视频 ${index + 1}`),
    playlistSource: ref(null),
    playlistTitle: ref(''),
    playlistNames: ref({}),
    playlistCover: ref(''),
    playlistCat: ref(''),
  } as unknown as PlaylistProgressDeps['handoff']

  const deps: PlaylistProgressDeps = {
    playlist,
    currentIndex,
    getPlayingIndex: () => playingIndex,
    media,
    handoff,
    onDirty: vi.fn(),
    playByIndex: vi.fn(async () => {}),
  }

  const progress = usePlaylistProgress(deps)
  return { deps, progress, setPlayingIndex: (i: number) => { playingIndex = i } }
}

beforeEach(() => {
  watchHistory.recordWatch.mockClear()
  watchHistory.findWatch.mockClear()
  watchHistory.findWatch.mockReturnValue(null)
})

describe('存进度按 playingIndex 不按 currentIndex（踩过：手动点下一集进度还是上一集的）', () => {
  it('currentIndex 已乐观跳到目标集，但 playingIndex 还停在旧集 → 写进旧集的键', () => {
    const { deps, progress, setPlayingIndex } = setup({ currentIndex: 0 })
    deps.currentIndex.value = 5       // 乐观：以为已经切到第 5 集
    setPlayingIndex(2)                // 但媒体元素真装着的是第 2 集
    deps.media.duration.value = 100
    deps.media.currentTime.value = 10 // 远小于 finishedThreshold

    progress.saveCurrentProgress()

    expect(deps.media.savedProgress.value[deps.playlist.value[2]]).toBe(10)
    expect(deps.media.savedProgress.value[deps.playlist.value[5]]).toBeUndefined()
  })
})

describe('progressKey 仍按 currentIndex（恢复用途，与 playingKey 分开）', () => {
  it('progressKey 取 currentIndex，不受 getPlayingIndex 影响', () => {
    const { deps, progress, setPlayingIndex } = setup({ currentIndex: 3 })
    setPlayingIndex(1)
    expect(progress.progressKey()).toBe(deps.playlist.value[3])
    expect(progress.playingKey()).toBe(deps.playlist.value[1])
  })
})

describe('saveCurrentProgress：正常存 / 片尾区删记录 / 地板 5 秒 / duration<=0 永不判完成', () => {
  it('不在片尾区之外 → 正常写入并 onDirty', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    deps.media.duration.value = 100
    deps.media.skipOutro.value = 0
    deps.media.currentTime.value = 50 // threshold = 100 - max(5,0) = 95

    progress.saveCurrentProgress()

    const key = progress.playingKey()
    expect(deps.media.savedProgress.value[key]).toBe(50)
    expect(deps.onDirty).toHaveBeenCalledTimes(1)
  })

  it('越过 finishedThreshold（进了片尾区）→ 删记录而不是写入新值', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    const key = progress.playingKey()
    deps.media.savedProgress.value[key] = 42
    deps.media.duration.value = 100
    deps.media.skipOutro.value = 0
    deps.media.currentTime.value = 96 // >= threshold(95)

    progress.saveCurrentProgress()

    expect(deps.media.savedProgress.value[key]).toBeUndefined()
    expect(deps.onDirty).toHaveBeenCalledTimes(1)
  })

  it('currentTime <= 0 → 不动已有记录、不触发 onDirty（切集瞬间的窗口期兜底）', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    const key = progress.playingKey()
    deps.media.savedProgress.value[key] = 30
    deps.media.duration.value = 100
    deps.media.currentTime.value = 0

    progress.saveCurrentProgress()

    expect(deps.media.savedProgress.value[key]).toBe(30)
    expect(deps.onDirty).not.toHaveBeenCalled()
  })

  it('finishedThreshold 地板 5 秒：skipOutro=1 时门槛仍是 duration-5', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    deps.media.duration.value = 100
    deps.media.skipOutro.value = 1
    const key = progress.playingKey()

    deps.media.currentTime.value = 96 // > 100-5=95 → 判完成，删记录
    deps.media.savedProgress.value[key] = 1
    progress.saveCurrentProgress()
    expect(deps.media.savedProgress.value[key]).toBeUndefined()
  })

  it('finishedThreshold 不设地板：skipOutro=20 时门槛是 duration-20', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    deps.media.duration.value = 100
    deps.media.skipOutro.value = 20
    const key = progress.playingKey()

    // 82 < threshold(80)? 不对，82 >= 80 应判完成；换一个明确低于/高于 80 的值分别验证
    deps.media.currentTime.value = 79 // < 80 → 正常写入
    progress.saveCurrentProgress()
    expect(deps.media.savedProgress.value[key]).toBe(79)

    deps.media.currentTime.value = 81 // >= 80 → 判完成，删记录
    progress.saveCurrentProgress()
    expect(deps.media.savedProgress.value[key]).toBeUndefined()
  })

  it('duration<=0 时 finishedThreshold 视为 Infinity → 再大的 currentTime 也不判完成，正常写入', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    deps.media.duration.value = 0
    deps.media.currentTime.value = 999999
    const key = progress.playingKey()

    progress.saveCurrentProgress()

    expect(deps.media.savedProgress.value[key]).toBe(999999)
    expect(deps.onDirty).toHaveBeenCalledTimes(1)
  })
})

describe('dropSavedProgress：只在记录真实存在时才删并 onDirty', () => {
  it('键存在 → 删除并 onDirty', () => {
    const { deps, progress } = setup()
    deps.media.savedProgress.value['u1'] = 10
    progress.dropSavedProgress('u1')
    expect(deps.media.savedProgress.value['u1']).toBeUndefined()
    expect(deps.onDirty).toHaveBeenCalledTimes(1)
  })

  it('键不存在 → 什么都不做，不调用 onDirty', () => {
    const { deps, progress } = setup()
    progress.dropSavedProgress('u-missing')
    expect(deps.onDirty).not.toHaveBeenCalled()
  })
})

describe('getSavedProgress：缺省 0，存在则返回存的值', () => {
  it('未记录的 key 返回 0', () => {
    const { progress } = setup()
    expect(progress.getSavedProgress('u-missing')).toBe(0)
  })

  it('已记录的 key 返回存的秒数', () => {
    const { deps, progress } = setup()
    deps.media.savedProgress.value['u1'] = 77
    expect(progress.getSavedProgress('u1')).toBe(77)
  })
})

describe('clearAllProgress：整体清空并 onDirty', () => {
  it('savedProgress 归空对象，调用 onDirty', () => {
    const { deps, progress } = setup()
    deps.media.savedProgress.value = { u1: 1, u2: 2 }
    progress.clearAllProgress()
    expect(deps.media.savedProgress.value).toEqual({})
    expect(deps.onDirty).toHaveBeenCalledTimes(1)
  })
})

describe('currentVideoName：数字集名格式化为「第N集」，非数字原样透传', () => {
  it('纯数字集名 → 补成「第N集」', () => {
    const { deps, progress } = setup({ currentIndex: 0, names: { [defaultKeyAt(0)]: '7' } })
    expect(progress.currentVideoName.value).toBe('第7集')
  })

  it('非数字集名（如 Pilot）原样透传', () => {
    const { deps, progress } = setup({ currentIndex: 0, names: { [defaultKeyAt(0)]: 'Pilot' } })
    expect(progress.currentVideoName.value).toBe('Pilot')
  })

  it('按 progressKey（currentIndex）取名，不受 playingIndex 影响', () => {
    const { deps, progress, setPlayingIndex } = setup({
      currentIndex: 1,
      names: { [defaultKeyAt(1)]: '3', [defaultKeyAt(0)]: '9' },
    })
    setPlayingIndex(0) // 媒体还在播第 0 集，但集名显示要看 currentIndex（乐观目标）
    expect(progress.currentVideoName.value).toBe('第3集')
  })
})

describe('recordWatchProgress：单集列表不记历史', () => {
  it('playlist.length <= 1 时 saveCurrentProgress 不调用 watchHistory.recordWatch', () => {
    const { deps, progress } = setup({ playlist: ['only.m3u8'], currentIndex: 0, playingIndex: 0 })
    deps.media.duration.value = 100
    deps.media.currentTime.value = 10

    progress.saveCurrentProgress()

    expect(watchHistory.recordWatch).not.toHaveBeenCalled()
    // 单集列表不记历史，但进度本身照常存
    expect(deps.media.savedProgress.value[progress.playingKey()]).toBe(10)
  })

  it('多集列表且有剧名 → 调用 watchHistory.recordWatch', () => {
    const { deps, progress } = setup({ currentIndex: 0, playingIndex: 0 })
    deps.handoff.playlistTitle.value = '某部剧'
    deps.media.duration.value = 100
    deps.media.currentTime.value = 10

    progress.saveCurrentProgress()

    expect(watchHistory.recordWatch).toHaveBeenCalledTimes(1)
  })
})

// 默认 playlist 是 setup() 里那份 ['ep0.m3u8', ...]，取第 i 集地址给 names 当键用
function defaultKeyAt(i: number): string {
  return ['ep0.m3u8', 'ep1.m3u8', 'ep2.m3u8', 'ep3.m3u8', 'ep4.m3u8', 'ep5.m3u8'][i]!
}
