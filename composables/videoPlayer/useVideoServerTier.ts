/**
 * 服务器档位（好/中/差）与抗卡参数。
 *
 * 一套抗卡参数（濒卡/吃紧阈值、安全系数、并发下限、对冲延迟、跳片超时、竞速上限）打包成档位，
 * 可自动分档（classifyTier，由 useVideoEngine 的自愈环调用）或被站点规则锁定；
 * 页面「抗卡策略」区可逐项覆盖。分档结果按 host 学习并持久化，下次进同站直接从最优起步。
 *
 * 本模块只管「档位是什么、参数取多少」，不含分档决策——那要读实测带宽和真实卡顿，
 * 属于引擎的自愈环（见 useVideoEngine 的 selfHeal）。
 */
import type { SiteRule, ServerTier, TierParams } from '../videoSiteRules'

export interface VideoServerTierDeps {
  /** 当前 URL 命中的站点规则（规则可锁定档位） */
  getActiveRule: () => SiteRule | null
  /** 覆盖参数改动即持久化（实时生效，无需「应用配置」） */
  onDirty: () => void
}

export function useVideoServerTier(deps: VideoServerTierDeps) {
  const autoTier = ref<ServerTier>(DEFAULT_TIER)        // auto 模式下实测/学习得出的档位
  const tierOverrides = ref<Partial<TierParams>>({})    // 页面可调的档位参数覆盖（空=用预设）
  const guardRateCeiling = ref(Infinity)                // 抗卡降速守卫上限：PANIC 置 1，恢复置 Infinity
  const currentHost = ref('')                           // 当前视频 host（学习档案按 host 存取）

  // 生效档位名：手动规则锁定优先，否则自动实测/学习档
  const effectiveTierName = computed<ServerTier>(() => {
    const manual = deps.getActiveRule()?.serverTier
    if (manual && manual !== 'auto') return manual
    return autoTier.value
  })
  const tierIsAuto = computed(() => {
    const m = deps.getActiveRule()?.serverTier
    return !m || m === 'auto'
  })

  const tierDefaults = computed(() => SERVER_TIERS[effectiveTierName.value])
  // 生效档位参数 = 预设 + 页面覆盖（过滤掉空/非法覆盖值，避免输入框清空污染数值逻辑）
  const effectiveTierParams = computed<TierParams>(() => {
    const ov = tierOverrides.value
    const clean: Partial<TierParams> = {}
    for (const k in ov) {
      const v = (ov as any)[k]
      if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') (clean as any)[k] = v
    }
    return { ...tierDefaults.value, ...clean }
  })

  const tierLabel = computed(() => ({ good: '好', medium: '中', bad: '差' } as const)[effectiveTierName.value])
  const tierBadgeColor = computed(() => ({ good: 'green', medium: 'amber', bad: 'red' } as const)[effectiveTierName.value])
  const hasTierOverride = computed(() => Object.keys(tierOverrides.value).length > 0)
  const clearTierOverrides = () => { tierOverrides.value = {} }

  watch(tierOverrides, () => deps.onDirty(), { deep: true })

  /**
   * 新流开始：按 host 取出学到的档位起步（第二遍即最优，不再从冷启动乐观值试探），
   * 并解除上一流残留的降速守卫。返回学习档案供调用方继续读 reach 字段。
   */
  const beginHost = (host: string) => {
    currentHost.value = host
    const learned = loadLearnedProfile(host)
    autoTier.value = learned?.learnedTier ?? DEFAULT_TIER
    guardRateCeiling.value = Infinity
    return learned
  }

  return {
    autoTier, tierOverrides, guardRateCeiling, currentHost,
    effectiveTierName, tierIsAuto, tierDefaults, effectiveTierParams,
    tierLabel, tierBadgeColor, hasTierOverride, clearTierOverrides,
    beginHost,
  }
}

export type VideoServerTier = ReturnType<typeof useVideoServerTier>

/** 「站点规则」里可选的档位（保留给规则编辑界面；当前页面只显示生效档位） */
export const SERVER_TIER_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '好', value: 'good' },
  { label: '中', value: 'medium' },
  { label: '差', value: 'bad' },
]
