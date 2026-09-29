/**
 * 加载超时两档闹钟的行为钉子（loadTimeout）。
 *
 * 第一档 10s 静默重新取址，第二档 15s 报错；`markDataReceived` 一到两档全消；
 * `isLoading()===false` 时两档都不动手；断网期间顺延（2s 复查一次）；
 * 换网恢复窗口内每档只顺延一次（`RECOVER_DEFER_MS`），别让死链一直拖着不报。
 * `isOffline` / `isRecovering` 来自 netWatch，mock 掉以便控制。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ offline: false, recovering: false }))
vi.mock('./netWatch', () => ({
  isOffline: () => h.offline,
  isRecovering: () => h.recovering,
}))

import { useLoadTimeout } from './loadTimeout'

function setup(isLoading = () => true) {
  const refetchUrl = vi.fn()
  const onTimeout = vi.fn()
  const timeout = useLoadTimeout({ isLoading, refetchUrl, onTimeout })
  return { timeout, refetchUrl, onTimeout }
}

beforeEach(() => { vi.useFakeTimers(); h.offline = false; h.recovering = false })
afterEach(() => { vi.useRealTimers() })

describe('两档准时触发', () => {
  it('10s 一个字节都没来 → 静默重新取址；15s 仍没来 → 报错销毁', () => {
    const { timeout, refetchUrl, onTimeout } = setup()
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(9999)
    expect(refetchUrl).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refetchUrl).toHaveBeenCalledTimes(1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4999)   // 累计 14999ms
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)      // 累计 15000ms
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})

describe('markDataReceived：收到数据后两档全部作废', () => {
  it('收到数据后清掉两个计时器，之后不再触发', () => {
    const { timeout, refetchUrl, onTimeout } = setup()
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(5000)
    timeout.markDataReceived()
    vi.advanceTimersByTime(20000)
    expect(refetchUrl).not.toHaveBeenCalled()
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

describe('isLoading() 为 false：两档都不动手', () => {
  it('已经不在加载中，到点也不触发', () => {
    const { timeout, refetchUrl, onTimeout } = setup(() => false)
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(20000)
    expect(refetchUrl).not.toHaveBeenCalled()
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

describe('断网期间顺延，每 2s 复查一次', () => {
  it('断网时到点不触发，只顺延；网络恢复后才真正触发', () => {
    h.offline = true
    const { timeout, refetchUrl } = setup()
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(10000)   // 到第一档，但断网 → 顺延
    expect(refetchUrl).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)    // 复查一次，仍断网
    expect(refetchUrl).not.toHaveBeenCalled()
    h.offline = false
    vi.advanceTimersByTime(2000)    // 复查时网络已回来
    expect(refetchUrl).toHaveBeenCalledTimes(1)
  })
})

describe('换网恢复窗口：每档只顺延一次', () => {
  it('第一档在恢复窗口内只让路一次（RECOVER_DEFER_MS=5000），之后即使还在窗口内也照常触发', () => {
    h.recovering = true
    const { timeout, refetchUrl } = setup()
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(10000)   // 到第一档，恢复窗口内 → 顺延 5s（只这一次）
    expect(refetchUrl).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)    // 顺延到点，仍在恢复窗口内，但已经让过一次路了 → 照常触发
    expect(refetchUrl).toHaveBeenCalledTimes(1)
  })

  it('第二档同理：只顺延一次，不会被恢复窗口一直拖着不报', () => {
    h.recovering = true
    const { timeout, onTimeout } = setup()
    timeout.startLoadTimeout()
    vi.advanceTimersByTime(15000)   // 到第二档，恢复窗口内 → 顺延 5s
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})
