import { Parser as M3u8Parser } from 'm3u8-parser'

// 分片元数据（含加密信息）
export interface HlsSegment {
  url: string
  sn: number             // 媒体序列号，用于推导 AES IV
  keyUri?: string        // 密钥地址（undefined = 未加密）
  keyIv?: Uint8Array | null  // 显式 IV（null = 用 sn 推导）
}

/**
 * M3U8 解析 + AES-128 解密
 *
 * 纯逻辑，通过注入的 getProxyUrl 走服务端代理（注入 Origin/Referer）。
 * hlsKeyCache 为每次下载任务内复用的密钥缓存，通过 clearKeyCache() 在任务前后清空。
 */
export function useM3u8(getProxyUrl: (url: string) => string) {
  // 解析 URL（相对路径转绝对路径）
  const resolveUrl = (base: string, relative: string): string => {
    if (relative.startsWith('http://') || relative.startsWith('https://')) return relative
    try {
      return new URL(relative, base).href
    } catch {
      return relative
    }
  }

  const fetchM3u8Manifest = async (m3u8Url: string, signal?: AbortSignal): Promise<{ manifest: any; baseUrl: string }> => {
    const proxyUrl = m3u8Url.startsWith('/api/proxy') ? m3u8Url : getProxyUrl(m3u8Url)
    const res = await fetch(proxyUrl, { signal })
    if (!res.ok) throw new Error(`获取 M3U8 失败: ${res.status}`)
    const text = await res.text()

    const actualUrl = res.url || proxyUrl
    let baseUrl: string
    try {
      const u = new URL(actualUrl, window.location.href)
      baseUrl = u.origin + u.pathname.replace(/\/[^/]*$/, '/')
    } catch {
      baseUrl = actualUrl.replace(/\/[^/]*$/, '/')
    }

    const parser = new M3u8Parser()
    parser.push(text)
    parser.end()
    return { manifest: parser.manifest as any, baseUrl }
  }

  const pickBestVariant = (manifest: any): any | null => {
    if (!Array.isArray(manifest?.playlists) || manifest.playlists.length === 0) return null
    return [...manifest.playlists].sort((a: any, b: any) => {
      const ab = a?.attributes?.BANDWIDTH ?? 0
      const bb = b?.attributes?.BANDWIDTH ?? 0
      return bb - ab
    })[0]
  }

  const pickAudioPlaylistUrl = (manifest: any, baseUrl: string, preferredGroupId?: string): string | null => {
    const audioGroups = manifest?.mediaGroups?.AUDIO
    if (!audioGroups || typeof audioGroups !== 'object') return null

    const candidateGroupId = preferredGroupId && audioGroups[preferredGroupId]
      ? preferredGroupId
      : Object.keys(audioGroups)[0]
    if (!candidateGroupId) return null

    const group = audioGroups[candidateGroupId]
    if (!group || typeof group !== 'object') return null

    const renditions = Object.values(group) as any[]
    const picked = renditions.find(r => r?.default && r?.uri)
      || renditions.find(r => r?.autoselect && r?.uri)
      || renditions.find(r => r?.uri)
    if (!picked?.uri) return null
    return resolveUrl(baseUrl, picked.uri)
  }

  // 提取分片列表（含加密元数据）
  const extractMediaSegmentsWithMeta = (manifest: any, baseUrl: string): HlsSegment[] => {
    const segments = manifest.segments as Array<any> | undefined
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('M3U8 解析失败，未找到分片')
    }
    const mediaSequence: number = manifest.mediaSequence ?? 0
    const result: HlsSegment[] = []
    const addedMap = new Set<string>()

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const sn = mediaSequence + i
      const mapUri = seg?.map?.uri
      if (mapUri) {
        const mapUrl = resolveUrl(baseUrl, mapUri)
        if (!addedMap.has(mapUrl)) {
          result.push({ url: mapUrl, sn: 0 })
          addedMap.add(mapUrl)
        }
      }
      if (!seg?.uri) continue

      const isEncrypted = seg.key?.method === 'AES-128'
      let keyIv: Uint8Array | null = null
      if (isEncrypted && seg.key?.iv) {
        // m3u8-parser 可能返回数组或十六进制字符串
        const ivSrc = seg.key.iv
        const ivHex = Array.isArray(ivSrc)
          ? (ivSrc as number[]).map(b => b.toString(16).padStart(2, '0')).join('')
          : String(ivSrc).replace(/^0x/i, '').padStart(32, '0')
        keyIv = new Uint8Array(ivHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
      }

      result.push({
        url: resolveUrl(baseUrl, seg.uri),
        sn,
        keyUri: isEncrypted && seg.key?.uri ? resolveUrl(baseUrl, seg.key.uri) : undefined,
        keyIv: isEncrypted ? keyIv : null,
      })
    }
    return result
  }

  // 递归解析到媒体播放列表，返回带加密信息的分片列表
  const getM3u8SegmentsWithMeta = async (m3u8Url: string, signal?: AbortSignal): Promise<HlsSegment[]> => {
    const { manifest, baseUrl } = await fetchM3u8Manifest(m3u8Url, signal)
    const best = pickBestVariant(manifest)
    if (best?.uri) return getM3u8SegmentsWithMeta(resolveUrl(baseUrl, best.uri), signal)
    return extractMediaSegmentsWithMeta(manifest, baseUrl)
  }

  // 下载计划：同时解析视频轨和独立音频轨（若存在），携带加密元数据
  const getM3u8DownloadPlan = async (
    m3u8Url: string,
    signal?: AbortSignal
  ): Promise<{ videoSegments: HlsSegment[]; audioSegments: HlsSegment[] }> => {
    const { manifest, baseUrl } = await fetchM3u8Manifest(m3u8Url, signal)
    const best = pickBestVariant(manifest)
    if (!best?.uri) {
      return { videoSegments: extractMediaSegmentsWithMeta(manifest, baseUrl), audioSegments: [] }
    }
    const videoPlaylistUrl = resolveUrl(baseUrl, best.uri)
    const audioPlaylistUrl = pickAudioPlaylistUrl(manifest, baseUrl, best?.attributes?.AUDIO)
    const [videoSegments, audioSegments] = await Promise.all([
      getM3u8SegmentsWithMeta(videoPlaylistUrl, signal),
      audioPlaylistUrl ? getM3u8SegmentsWithMeta(audioPlaylistUrl, signal) : Promise.resolve([])
    ])
    return { videoSegments, audioSegments }
  }

  // AES-128 密钥缓存（每次下载任务内复用）
  const hlsKeyCache = new Map<string, CryptoKey>()
  const clearKeyCache = () => hlsKeyCache.clear()

  const fetchHlsKey = async (keyUri: string, signal?: AbortSignal): Promise<CryptoKey> => {
    if (hlsKeyCache.has(keyUri)) return hlsKeyCache.get(keyUri)!
    const res = await fetch(getProxyUrl(keyUri), { signal })
    if (!res.ok) throw new Error(`获取解密密钥失败: ${res.status}`)
    const raw = await res.arrayBuffer()
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])
    hlsKeyCache.set(keyUri, key)
    return key
  }

  // AES-128-CBC 解密单个分片（未加密直接返回原数据）
  const decryptHlsSegment = async (data: ArrayBuffer, seg: HlsSegment, signal?: AbortSignal): Promise<ArrayBuffer> => {
    if (!seg.keyUri) return data
    const key = await fetchHlsKey(seg.keyUri, signal)
    let iv: ArrayBuffer
    if (seg.keyIv && seg.keyIv.byteLength === 16) {
      iv = seg.keyIv.buffer.slice(seg.keyIv.byteOffset, seg.keyIv.byteOffset + 16)
    } else {
      // 无显式 IV：用序列号填充 16 字节大端整数
      const ivBytes = new Uint8Array(16)
      const sn = seg.sn
      ivBytes[12] = (sn >>> 24) & 0xff
      ivBytes[13] = (sn >>> 16) & 0xff
      ivBytes[14] = (sn >>> 8) & 0xff
      ivBytes[15] = sn & 0xff
      iv = ivBytes.buffer
    }
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data)
  }

  return {
    resolveUrl,
    fetchM3u8Manifest,
    pickBestVariant,
    pickAudioPlaylistUrl,
    extractMediaSegmentsWithMeta,
    getM3u8SegmentsWithMeta,
    getM3u8DownloadPlan,
    clearKeyCache,
    decryptHlsSegment,
  }
}
