/**
 * 站点策略注册表。
 *
 * 匹配优先级：用户自定义规则 > 代码型站点 > 内置规则。
 * 用户规则排最前是为了让人能就地覆盖内置行为。
 *
 * 接新站的两条路：
 *   · 地址明文在页面里 → 在 composables/videoParseRules.ts 的 BUILTIN_PARSE_RULES 加一条规则，不用碰这里
 *   · 需要写代码       → 在 sites/ 加一个 .ts 导出 SiteParser，在 CODED_PARSERS 登记，
 *                        同时在 CODED_PARSE_SITES 登记 pattern（前端要用它判断支持与否）
 */
import { BUILTIN_PARSE_RULES } from '../../composables/videoParseRules'
import type { ParseRule } from '../../composables/videoParseRules'
import type { SiteParser } from './types'
import { createHtmlParser } from './htmlRule'
import { hostOf, patternMatches } from './utils'
import { nbmovieParser } from './sites/nbmovie'

const CODED_PARSERS: SiteParser[] = [nbmovieParser]

/** extraRules 是前端随请求带上来的用户规则（Nitro 里没有 localStorage） */
export function matchParser(url: string, extraRules: ParseRule[] = []): SiteParser | null {
  const host = hostOf(url)
  if (!host) return null

  for (const rule of extraRules) {
    if (patternMatches(rule.pattern, url, host)) return createHtmlParser(rule)
  }
  for (const parser of CODED_PARSERS) {
    if (patternMatches(parser.pattern, url, host)) return parser
  }
  for (const rule of BUILTIN_PARSE_RULES) {
    if (patternMatches(rule.pattern, url, host)) return createHtmlParser(rule)
  }
  return null
}

export type { ParserContext, SiteParser } from './types'
