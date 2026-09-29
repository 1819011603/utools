/**
 * 「代理 Manifest」/「双通道」的可用性判定（从 useVideoConnStrategy.ts 下沉）。
 * 纯 computed：只读探测结论与当前连接 ref，供界面禁用/提示用。
 */
import type { Ref } from 'vue'
import type { ProbeResult } from './useReachabilityProbe'
import { axisMeasured } from './probeDiagnose'

export interface ConnDualChannelDeps {
  useProxy: Ref<boolean>
  requestOrigin: Ref<string>
  requestReferer: Ref<string>
  manifestOnly: Ref<boolean>
  disguiseAsDownloader: Ref<boolean>
  dualChannel: Ref<boolean>
  probeResult: Ref<ProbeResult | null>
}

export function useConnDualChannel(deps: ConnDualChannelDeps) {
  const { useProxy, requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, dualChannel, probeResult } = deps

  // ── 「代理 Manifest」/「双通道」的可用性判定 ──

  // 「代理 Manifest」需要代理确实介入才有意义：伪装模式下它表示「代理 manifest 补 CORS + 分片直连」，
  // 注入头模式下表示「manifest 走防盗链 + 分片直连」。两者都没有时代理压根不会介入，勾了无效 → 禁用。
  const manifestOnlyDisabled = computed(() =>
    !disguiseAsDownloader.value && !requestOrigin.value.trim() && !requestReferer.value.trim())

  // 双通道需要分片「直连」和「经代理」两条路都通。有实测就用实测，否则按当前配置推断。
  const dualChannelUnavailable = computed(() => {
    // 已经开着就别再说「不可用」：那条 lane 可能是靠**迟到判定**开的（两条通道各自实测 ok，
    // 只是有一条没在预算内回来 → 矩阵里留着 'skip'）。此时按矩阵读会得出相反的结论，
    // 界面上就是「灯亮着、提示说不可用」（踩过）
    if (dualChannel.value) return false
    const r = probeResult.value
    if (r && !r.degraded && axisMeasured(r.segment)) {
      // **只把 'fail'/'unknown' 当不可用**：'skip' 是「没等到」，不是「测过不通」
      return r.segment.direct !== 'ok' || (r.segment.disguise !== 'ok' && r.segment.disguise !== 'skip')
    }
    // 无探测数据（分片轴没测到 / 走了兜底阶梯）：跟 getProxyUrl 对分片(.ts)的判定保持一致——
    // 分片走代理时直连 lane 必 403/CORS，没有分流可言。
    if (disguiseAsDownloader.value) return !manifestOnly.value
    const hasHeaders = !!requestOrigin.value.trim() || !!requestReferer.value.trim()
    if (hasHeaders) return !manifestOnly.value
    return useProxy.value
  })

  const dualChannelHint = computed(() => {
    if (!dualChannelUnavailable.value) {
      return '分片在直连 CDN 与本站代理两个 origin 间分流，把并发从 6 提到 ~12（代价：占用服务器出口流量）'
    }
    const r = probeResult.value
    if (r && !r.degraded && axisMeasured(r.segment)) {
      if (r.segment.direct !== 'ok') return '实测分片无法直连（须走代理）→ 直连通道会失败'
      if (r.segment.disguise === 'skip') return '分片的代理通道这一轮没等到结论（起播不为它多等）→ 等它回来会自动开'
      return '实测分片无法经代理获取（如源站端口非标被 CF 吞、服务器 IP 被封）→ 代理通道会失败'
    }
    return '需分片直连可达才有效：分片走代理时直连通道会 403'
  })

  return { manifestOnlyDisabled, dualChannelUnavailable, dualChannelHint }
}
