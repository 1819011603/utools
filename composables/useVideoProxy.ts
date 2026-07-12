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
    // 走服务端 /api/proxy 的触发条件：必须注入了 Origin 或 Referer。
    // manifestOnly 只是在此基础上「只代理 manifest、分片直连」的附加选项，不能单独触发代理——
    // 否则 Origin/Referer 都为空时代理也解决不了防盗链 403，白白多绕一层。
    if (o || r) {
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

  // 「直连+代理双通道」的代理 lane：只为多占一个 origin（+ 服务器 IP）来提并发，
  // 请求内容必须与直连 lane 完全一致。直连 lane 是浏览器裸 fetch（referrerPolicy: no-referrer，
  // 且 Origin/Referer 是 forbidden headers 本就发不出去），所以这里也不能注入任何头——
  // 用 noref=1 明确禁发。若注入 Origin/Referer，两条 lane 对同一 CDN 发的就是不同请求，
  // 可能一条成一条败（甚至内容不一致），失去分流意义。双通道只在分片直连可达时启用，本就不需要头。
  const getProxyPassthroughUrl = (url: string): string => {
    if (url.includes('/api/proxy?')) return url
    return '/api/proxy?' + new URLSearchParams({ url, noref: '1' }).toString()
  }

  // 当前对该 url 是否为「直连模式」（getProxyUrl 原样返回，浏览器直接打 CDN）。
  // 只有直连可达的源才能做双通道——需要注入头/走代理的源，直连 lane 会 403/CORS 失败。
  const isDirectMode = (url: string): boolean => getProxyUrl(url) === url

  return { corsProxies, isHlsUrl, effectiveReferer, refererHelp, getProxyUrl, getProxyPassthroughUrl, isDirectMode }
}
