import type { Ref } from 'vue'

/**
 * 代理 URL 生成
 *
 * Origin/Referer 是浏览器禁止 JS 修改的 forbidden headers，必须走服务端代理
 * （/api/proxy）注入，fetch/XHR 直接设置会被浏览器忽略。
 *
 * 说明：站点规则命中后，会把 origin/referer/manifestOnly/disguise/useProxy
 * 直接写回下面这些 ref，因此本 composable 无需感知站点规则——照常读 ref 即可。
 */
export interface VideoProxyOptions {
  requestOrigin: Ref<string>
  requestReferer: Ref<string>
  manifestOnly: Ref<boolean>
  disguiseAsDownloader: Ref<boolean>
  useProxy: Ref<boolean>
}

export function useVideoProxy(opts: VideoProxyOptions) {
  const { requestOrigin, requestReferer, manifestOnly, disguiseAsDownloader, useProxy } = opts

  // CORS 代理列表
  const corsProxies = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
  ]

  // 检测是否为 HLS
  const isHlsUrl = (url: string): boolean => {
    return url.includes('.m3u8') || url.includes('m3u8')
  }

  // 实际生效的 Referer：用户填了就用用户的，否则 origin 非空时自动补 /
  const effectiveReferer = computed(() => {
    const r = requestReferer.value.trim()
    if (r) return r
    const o = requestOrigin.value.trim()
    return o ? o.replace(/\/$/, '') + '/' : ''
  })

  const refererHelp = computed(() => {
    const o = requestOrigin.value.trim()
    const defaultVal = o ? o.replace(/\/$/, '') + '/' : 'Origin + /'
    return '注入请求头 Referer，留空时自动填 ' + defaultVal
  })

  // 获取代理 URL
  const getProxyUrl = (url: string): string => {
    if (url.includes('/api/proxy?')) return url

    // 伪装下载器：不发送 Origin/Referer，全程走代理（禁用 noseg）
    if (disguiseAsDownloader.value) {
      const params = new URLSearchParams({ url, noref: '1' })
      return '/api/proxy?' + params.toString()
    }

    const o = requestOrigin.value.trim()
    const r = effectiveReferer.value
    // 走服务端 /api/proxy 的触发条件：需要注入头(o/r) 或 勾了「仅代理 Manifest」。
    // manifestOnly 是独立触发项——即便不注入 Origin/Referer，也要把 manifest 交给代理补 CORS，分片仍直连。
    if (o || r || manifestOnly.value) {
      if (manifestOnly.value && !isHlsUrl(url)) return url

      const params = new URLSearchParams({ url })
      if (o) params.set('origin', o)
      if (r) params.set('referer', r)
      if (manifestOnly.value) params.set('noseg', '1')
      return '/api/proxy?' + params.toString()
    }

    if (useProxy.value) return corsProxies[0] + encodeURIComponent(url)
    return url
  }

  return { corsProxies, isHlsUrl, effectiveReferer, refererHelp, getProxyUrl }
}
