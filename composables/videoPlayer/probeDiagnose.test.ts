/**
 * 探测结论判读的行为钉子（probeDiagnose）。
 *
 * 钉住 docs/player.md §代理与探测 与源码注释里最容易读反的几组情况：
 * 「三条通道全 fail」与「没测过（全 skip）」长得像却含义相反；`deadSource` 短路一切轴判断；
 * `unknown` 不等于「测过不通」；分片轴没测过不该被当成问题；两轴各有可达通道也可能凑不出组合。
 */
import { describe, it, expect } from 'vitest'
import { CHANNEL_LABEL } from './useReachabilityProbe'
import type { AxisProbe, ProbeResult } from './useReachabilityProbe'
import { diagnoseProbe, axisMeasured, describeProbe, probeMatrixRows } from './probeDiagnose'

const axis = (partial: Partial<AxisProbe> = {}): AxisProbe => ({ direct: 'skip', disguise: 'skip', headers: 'skip', ms: {}, ...partial })

const makeResult = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  at: Date.now(),
  isHls: true,
  manifest: axis(),
  segment: axis(),
  manifestChannel: null,
  segmentChannel: null,
  dualChannel: false,
  degraded: false,
  ...over,
})

describe('diagnoseProbe(null)：还没探测过', () => {
  it('severity warn / issue inconclusive / 标题「尚未探测」', () => {
    const v = diagnoseProbe(null)
    expect(v.severity).toBe('warn')
    expect(v.issue).toBe('inconclusive')
    expect(v.title).toBe('尚未探测')
  })
})

describe('axisMeasured：「没测过」与「测过全不通」是两回事', () => {
  it('四通道全 skip（master 下钻失败之类，probeAxis 压根没跑）→ false', () => {
    expect(axisMeasured(axis())).toBe(false)
  })
  it('只要有一条不是 skip（哪怕是 fail）→ true，代表这根轴真的测过', () => {
    expect(axisMeasured(axis({ direct: 'fail' }))).toBe(true)
  })
})

describe('diagnoseProbe：deadSource 短路一切轴判断', () => {
  it('deadSource=true → fatal / source-gone，不管 manifest、segment 轴内容是什么', () => {
    const r = makeResult({
      deadSource: true,
      // 特意把两轴都填成「可以播放」的样子，验证 deadSource 优先于它们生效
      manifest: axis({ direct: 'ok' }), segment: axis({ direct: 'ok' }),
      manifestChannel: 'direct', segmentChannel: 'direct',
    })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('fatal')
    expect(v.issue).toBe('source-gone')
  })
})

describe('diagnoseProbe：manifest 轴三条全部实测不可达', () => {
  it('isHls=true → fatal / manifest-unreachable，标题提「m3u8 清单」', () => {
    const r = makeResult({ manifest: axis({ direct: 'fail', disguise: 'fail', headers: 'skip' }), isHls: true })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('fatal')
    expect(v.issue).toBe('manifest-unreachable')
    expect(v.title).toContain('m3u8 清单')
  })

  it('isHls=false → fatal / manifest-unreachable，标题改说「视频地址」', () => {
    const r = makeResult({ manifest: axis({ direct: 'fail', disguise: 'fail', headers: 'skip' }), isHls: false })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('fatal')
    expect(v.issue).toBe('manifest-unreachable')
    expect(v.title).toContain('视频地址')
  })
})

describe('diagnoseProbe：manifest 轴测过但不是全部失败（含 unknown）→ 不能判死', () => {
  it('direct=unknown（超时）、其余 skip，没有一条 ok 也没有一条 fail → warn / inconclusive', () => {
    // 这里刻意不给任何 'fail'：pin 住「unknown（超时）≠ fail」在判读层也成立，不止 probeUrl 那一层
    const r = makeResult({ manifest: axis({ direct: 'unknown' }) })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('warn')
    expect(v.issue).toBe('inconclusive')
    expect(v.title).toBe('清单探测未拿到结论')
  })
})

describe('diagnoseProbe：分片轴没测过（全 skip）不算问题', () => {
  it('manifest 有可达通道、segment 全 skip → 不报 segment-unreachable / fatal', () => {
    const r = makeResult({
      manifest: axis({ direct: 'ok' }), manifestChannel: 'direct',
      segment: axis(), segmentChannel: null, // 分片轴压根没跑，segmentChannel 自然也是 null
    })
    const v = diagnoseProbe(r)
    // resolveConnConfig 需要 segmentChannel 才能给出组合，这里 segmentChannel=null 必然落到
    // combo-missing（warn），但关键断言是：它不是关于分片不可达的 fatal —— 分片没测过不是分片的错
    expect(v.issue).not.toBe('segment-unreachable')
    expect(v.severity).not.toBe('fatal')
    expect(v.issue).toBe('combo-missing')
  })
})

describe('diagnoseProbe：清单能取到，分片轴测过且全部失败', () => {
  it('fatal / segment-unreachable，标题含「清单能取到」与对应的「分片」/「视频」措辞', () => {
    const r = makeResult({
      isHls: true,
      manifest: axis({ direct: 'ok' }), manifestChannel: 'direct',
      segment: axis({ direct: 'fail', disguise: 'fail', headers: 'skip' }),
    })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('fatal')
    expect(v.issue).toBe('segment-unreachable')
    expect(v.title).toContain('清单能取到')
    expect(v.title).toContain('分片')
  })

  it('isHls=false 时同样的失败模式，措辞改成「视频」', () => {
    const r = makeResult({
      isHls: false,
      manifest: axis({ direct: 'ok' }), manifestChannel: 'direct',
      segment: axis({ direct: 'fail', disguise: 'fail', headers: 'skip' }),
    })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('fatal')
    expect(v.issue).toBe('segment-unreachable')
    expect(v.title).toContain('视频')
  })
})

describe('diagnoseProbe：两轴各有可达通道，但凑不出可用组合', () => {
  it('manifest 只能 direct、分片只能走 headers（方向相反）→ warn / combo-missing', () => {
    // 读 resolveConnConfig（useReachabilityProbe.ts）：seg!=='direct' 时只认「同一种代理」凑得齐的三种情况，
    // manifest 只有 direct ok、segment 只有 headers ok 三条判断全落空 → 返回 null
    const r = makeResult({
      manifest: axis({ direct: 'ok' }), manifestChannel: 'direct',
      segment: axis({ headers: 'ok' }), segmentChannel: 'headers',
    })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('warn')
    expect(v.issue).toBe('combo-missing')
  })
})

describe('diagnoseProbe：两轴凑得出组合的happy path', () => {
  it('manifest 与 segment 都走 direct → ok，标题以「可以播放」开头', () => {
    const r = makeResult({
      manifest: axis({ direct: 'ok' }), manifestChannel: 'direct',
      segment: axis({ direct: 'ok' }), segmentChannel: 'direct',
    })
    const v = diagnoseProbe(r)
    expect(v.severity).toBe('ok')
    expect(v.issue).toBe('ok')
    expect(v.title.startsWith('可以播放')).toBe(true)
  })
})

describe('describeProbe：一句话描述', () => {
  it('null → 空字符串', () => {
    expect(describeProbe(null)).toBe('')
  })

  it('manifestChannel/segmentChannel 任一为 null → 「探测未通」', () => {
    const r = makeResult({ manifestChannel: null, segmentChannel: 'direct' })
    expect(describeProbe(r)).toBe('探测未通')
  })

  it('两个通道都有 + isHls → 「清单X / 分片Y」', () => {
    const r = makeResult({ isHls: true, manifestChannel: 'direct', segmentChannel: 'disguise' })
    expect(describeProbe(r)).toBe(`清单${CHANNEL_LABEL.direct} / 分片${CHANNEL_LABEL.disguise}`)
  })

  it('dualChannel=true → 末尾追加「双通道」', () => {
    const r = makeResult({ isHls: true, manifestChannel: 'direct', segmentChannel: 'direct', dualChannel: true })
    expect(describeProbe(r)).toBe(`清单${CHANNEL_LABEL.direct} / 分片${CHANNEL_LABEL.direct} / 双通道`)
  })

  it('非 HLS（只有一根轴）→ 只报 segmentChannel 那一项', () => {
    const r = makeResult({ isHls: false, manifestChannel: 'direct', segmentChannel: 'direct' })
    expect(describeProbe(r)).toBe(CHANNEL_LABEL.direct)
  })
})

describe('probeMatrixRows：矩阵读数', () => {
  it('null → 空数组', () => {
    expect(probeMatrixRows(null)).toEqual([])
  })

  it('isHls=true → 两行「清单」「分片」，各 3 个格子且按 CHANNEL_ORDER 排列', () => {
    const r = makeResult({ isHls: true, manifest: axis({ direct: 'ok' }), segment: axis({ disguise: 'ok' }) })
    const rows = probeMatrixRows(r)
    expect(rows.map(row => row.name)).toEqual(['清单', '分片'])
    expect(rows[0].cells.map(c => c.channel)).toEqual(['direct', 'disguise', 'headers'])
    expect(rows[0].cells).toHaveLength(3)
    expect(rows[1].cells).toHaveLength(3)
    expect(rows[0].cells[0].reach).toBe('ok')
    expect(rows[1].cells[1].reach).toBe('ok')
  })

  it('isHls=false → 一行「视频」，读的是 segment 轴', () => {
    const r = makeResult({ isHls: false, segment: axis({ direct: 'ok' }) })
    const rows = probeMatrixRows(r)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('视频')
    expect(rows[0].cells[0].reach).toBe('ok')
  })
})
