/**
 * 探测结论判读 + 矩阵读数（从 useReachabilityProbe.ts 下沉）。
 *
 * 同一份矩阵有三个读者：播放器起播前的提醒、折叠区的探测矩阵、解析页的「可达性检测」。
 * 判读独立成函数、各写一遍必然漂移——尤其「三条通道全 fail」与「没测过（全 skip）」长得像却含义相反。
 */
import { CHANNEL_ORDER, CHANNEL_LABEL, resolveConnConfig } from './useReachabilityProbe'
import type { AxisProbe, Channel, Reach, ProbeResult } from './useReachabilityProbe'

// ── 结论判读（播放器与解析页共用）──
//
// 判读独立成函数而不是散在各调用点：同一份矩阵有三个读者（播放器起播前的提醒、
// 折叠区的探测矩阵、解析页的「可达性检测」按钮），各写一遍必然漂移——
// 尤其「三条通道全 fail」和「没测过（全 skip）」这两种长得像但含义相反的情况（见 axisMeasured）。

const axisAnyOk = (a: AxisProbe): boolean => CHANNEL_ORDER.some(c => a[c] === 'ok')

/**
 * 这根轴到底测过没有。清单通了但没解析出分片时（master 下钻失败 / 空列表）probeAxis 压根不会跑，
 * 四个通道全留在 'skip'——那是「没测」不是「测过不通」，拿它当证据会把结论说反（踩过）。
 */
export const axisMeasured = (a: AxisProbe): boolean => CHANNEL_ORDER.some(c => (a[c] ?? 'skip') !== 'skip')

/** 测过、且每一条测过的通道都实测失败（没有 ok、也没有 unknown 可以指望）→ 已被证伪，重试无意义 */
const axisAllFailed = (a: AxisProbe): boolean =>
  axisMeasured(a)
  && CHANNEL_ORDER.some(c => a[c] === 'fail')
  && CHANNEL_ORDER.every(c => a[c] === 'fail' || (a[c] ?? 'skip') === 'skip')

export type ProbeIssue =
  'ok' | 'source-gone' | 'manifest-unreachable' | 'segment-unreachable' | 'combo-missing' | 'inconclusive'

export interface ProbeVerdict {
  /** fatal = 实测证伪，再等/再试都没用，值得立刻告诉用户；warn = 没结论，照常尝试 */
  severity: 'ok' | 'warn' | 'fatal'
  issue: ProbeIssue
  title: string
  detail: string
}

const INCONCLUSIVE: Omit<ProbeVerdict, 'title'> = {
  severity: 'warn', issue: 'inconclusive',
  detail: '有通道到超时都没响应（慢源常见，慢 ≠ 不可达），播放器会照常加载并在失败时逐级降级。',
}

/**
 * 矩阵 → 一句结论 + 一段原因。
 *
 * 关键是把 `fatal` 摘出来：清单能取到、分片三条通道全 403 这种情况在探测结束的那一刻
 * 就已经注定播不了，而后面还要跑 5 级线性阶梯盲试、每级一次 15s 加载超时——
 * 用户盯着转圈一分多钟才看到一句「加载超时」。结论早就有了，就该早说。
 */
export function diagnoseProbe(r: ProbeResult | null): ProbeVerdict {
  if (!r) return { ...INCONCLUSIVE, title: '尚未探测' }
  const segName = r.isHls ? '分片' : '视频'
  const advice = '多为地址已过期、源站换了防盗链规则，或 CDN 拒了我们的出口 IP。换一条线路或重新解析即可。'

  // 已经确知原因就别说「不可达」这种废话——用户问的是「为什么播不了」，
  // 而这一条的答案是「跟连接方式无关，这个源被下线了」
  if (r.deadSource) {
    return {
      severity: 'fatal', issue: 'source-gone',
      title: '这个源已被 Cloudflare 以违反服务条款下线',
      detail: '源站内容被整个换成了一张「This content has been restricted」的占位图（我们照原样播只会一直闪），'
        + '换通道、改 Origin/Referer 都没有用。只能换一条线路或换个片源。',
    }
  }

  if (!axisAnyOk(r.manifest)) {
    if (axisAllFailed(r.manifest)) {
      return {
        severity: 'fatal', issue: 'manifest-unreachable',
        title: r.isHls ? 'm3u8 清单三条通道全部不可达' : '视频地址三条通道全部不可达',
        detail: `直连与代理（伪装 / 防盗链）全部失败，这条地址取不下来。${advice}`,
      }
    }
    return { ...INCONCLUSIVE, title: r.isHls ? '清单探测未拿到结论' : '探测未拿到结论' }
  }

  // 分片轴没测过（全 skip）= 让分片跟随清单通道，不是问题，别报
  if (axisMeasured(r.segment) && !axisAnyOk(r.segment)) {
    if (axisAllFailed(r.segment)) {
      return {
        severity: 'fatal', issue: 'segment-unreachable',
        title: `清单能取到，但${segName}三条通道全部不可达`,
        detail: `第一个${segName}在直连和代理（伪装 / 防盗链）上全部失败，播进去只会一直转圈。${advice}`,
      }
    }
    return { ...INCONCLUSIVE, title: `${segName}探测未拿到结论` }
  }

  // 两轴各自都有可达通道，却凑不出一种「清单与分片同时可达」的组合（见 resolveConnConfig 的归一化）
  if (!resolveConnConfig(r, '')) {
    return {
      severity: 'warn', issue: 'combo-missing',
      title: '清单与分片的可达通道凑不出组合',
      detail: '典型是「清单只能直连、分片只能走代理」这类方向相反的不对称要求，无法同时满足，播放器会退回线性阶梯盲试。',
    }
  }

  return { severity: 'ok', issue: 'ok', title: '可以播放 · ' + describeProbe(r), detail: '' }
}

export interface ProbeMatrixRow {
  name: string
  cells: Array<{ channel: Channel; label: string; reach: Reach; ms?: number }>
}

/** 矩阵读数（两轴 × 四通道），供 `<ProbeMatrix>` 渲染 */
export function probeMatrixRows(r: ProbeResult | null): ProbeMatrixRow[] {
  if (!r) return []
  const axes: Array<{ name: string; axis: AxisProbe }> = r.isHls
    ? [{ name: '清单', axis: r.manifest }, { name: '分片', axis: r.segment }]
    : [{ name: '视频', axis: r.segment }]
  return axes.map(({ name, axis }) => ({
    name,
    // axis[c] 兜 'skip'：加通道之前写进 localStorage 的旧探测结果没有新字段，
    // 直接渲染 undefined 会得到一个没有底色、也没有 title 的空格子
    cells: CHANNEL_ORDER.map(c => ({ channel: c, label: CHANNEL_LABEL[c], reach: axis[c] ?? 'skip', ms: axis.ms[c] })),
  }))
}

// 探测结论的一句话描述，供 UI 展示
export function describeProbe(r: ProbeResult | null): string {
  if (!r) return ''
  if (!r.manifestChannel || !r.segmentChannel) return '探测未通'
  const parts = r.isHls
    ? [`清单${CHANNEL_LABEL[r.manifestChannel]}`, `分片${CHANNEL_LABEL[r.segmentChannel]}`]
    : [CHANNEL_LABEL[r.segmentChannel]]
  if (r.dualChannel) parts.push('双通道')
  return parts.join(' / ')
}
