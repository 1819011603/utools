import type { Ref } from 'vue'
import type { HlsSegment } from './useM3u8'

/**
 * 视频下载：HLS 分片并发拉取 + AES 解密 + ffmpeg 合并为 MP4；MP4 直接下载。
 * 依赖注入代理/命名等，内部自建 useM3u8 实例（密钥缓存随任务清空）。
 */
export interface VideoDownloadOptions {
  getProxyUrl: (url: string) => string
  isHlsUrl: (url: string) => boolean
  getVideoName: (url: string, index: number) => string
  videoUrl: Ref<string>
  playlist: Ref<string[]>
  currentIndex: Ref<number>
  errorMessage: Ref<string>
  useProxy: Ref<boolean>
  // 下载并发（来自站点规则），默认 6
  getDownloadConcurrency?: () => number
}

export function useVideoDownload(opts: VideoDownloadOptions) {
  const { getProxyUrl, isHlsUrl, getVideoName, videoUrl, playlist, currentIndex, errorMessage, useProxy } = opts

  const isDownloading = ref(false)
  const downloadProgress = ref(0)   // 下载进度 0-100
  let downloadAbortController: AbortController | null = null

  let ffmpegInstance: any | null = null
  let ffmpegUtil: {
    fetchFile: (input: Blob) => Promise<Uint8Array>
    toBlobURL: (url: string, mimeType: string) => Promise<string>
  } | null = null
  let ffmpegLoadTask: Promise<void> | null = null

  const m3u8 = useM3u8(getProxyUrl)

  const ensureFfmpegReady = async () => {
    if (ffmpegInstance && ffmpegUtil) return
    if (!ffmpegLoadTask) {
      ffmpegLoadTask = (async () => {
        const [{ FFmpeg }, utilModule] = await Promise.all([
          import('@ffmpeg/ffmpeg'),
          import('@ffmpeg/util')
        ])
        const ffmpeg = new FFmpeg()
        ffmpeg.on('progress', ({ progress }: { progress: number }) => {
          // 下载阶段占 0-90，转码阶段占 90-100
          const transcodeProgress = 90 + Math.round(Math.max(0, Math.min(1, progress)) * 10)
          if (transcodeProgress > downloadProgress.value) {
            downloadProgress.value = transcodeProgress
          }
        })
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'
        const coreURL = await utilModule.toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')
        const wasmURL = await utilModule.toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
        await ffmpeg.load({
          coreURL,
          wasmURL
        })
        ffmpegInstance = ffmpeg
        ffmpegUtil = { fetchFile: utilModule.fetchFile, toBlobURL: utilModule.toBlobURL }
      })()
    }
    try {
      await ffmpegLoadTask
    } catch (e) {
      ffmpegLoadTask = null
      ffmpegInstance = null
      ffmpegUtil = null
      throw e
    }
  }

  const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
    const totalBytes = chunks.reduce((sum, seg) => sum + seg.byteLength, 0)
    const merged = new Uint8Array(totalBytes)
    let cursor = 0
    for (const seg of chunks) {
      merged.set(seg, cursor)
      cursor += seg.byteLength
    }
    return merged
  }

  const mergeSegmentsToMp4 = async (videoSegments: Uint8Array[], audioSegments: Uint8Array[] = []): Promise<Blob> => {
    await ensureFfmpegReady()
    if (!ffmpegInstance || !ffmpegUtil) throw new Error('FFmpeg 初始化失败')

    if (!videoSegments.length) {
      throw new Error('未获取到视频分片')
    }

    const videoMerged = concatChunks(videoSegments)
    await ffmpegInstance.writeFile('video.ts', await ffmpegUtil.fetchFile(new Blob([videoMerged], { type: 'video/mp2t' })))

    if (audioSegments.length > 0) {
      const audioMerged = concatChunks(audioSegments)
      await ffmpegInstance.writeFile('audio.ts', await ffmpegUtil.fetchFile(new Blob([audioMerged], { type: 'audio/mp2t' })))
      await ffmpegInstance.exec([
        '-y',
        '-i', 'video.ts',
        '-i', 'audio.ts',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        'output.mp4'
      ])
    } else {
      await ffmpegInstance.exec([
        '-y',
        '-i', 'video.ts',
        '-c', 'copy',
        '-movflags', '+faststart',
        'output.mp4'
      ])
    }

    const outData = await ffmpegInstance.readFile('output.mp4') as Uint8Array

    try { await ffmpegInstance.deleteFile('video.ts') } catch {}
    try { await ffmpegInstance.deleteFile('audio.ts') } catch {}
    try { await ffmpegInstance.deleteFile('output.mp4') } catch {}

    return new Blob([outData], { type: 'video/mp4' })
  }

  // 触发浏览器下载
  const triggerDownload = (blob: Blob, filename: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }

  type DownloadTask = { kind: 'video' | 'audio'; idx: number } & HlsSegment

  // 拉取并解密单个分片（带重试：单分片失败不再整包中断）
  const fetchSegment = async (task: DownloadTask): Promise<Uint8Array> => {
    const MAX_RETRY = 3
    let lastErr: any
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const res = await fetch(getProxyUrl(task.url), { signal: downloadAbortController?.signal })
        if (!res.ok) throw new Error(`下载分片失败: ${res.status}`)
        const raw = await res.arrayBuffer()
        const decrypted = await m3u8.decryptHlsSegment(raw, task, downloadAbortController?.signal)
        return new Uint8Array(decrypted)
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e   // 用户取消，不重试
        lastErr = e
        if (attempt < MAX_RETRY) {
          // 指数退避 300 / 600 / 1200ms
          await new Promise(r => setTimeout(r, 300 * 2 ** attempt))
        }
      }
    }
    throw lastErr
  }

  // 下载视频（可选指定 URL，否则用当前播放的）
  const downloadVideo = async (targetUrl?: string) => {
    const url = (targetUrl || videoUrl.value)?.trim()
    if (!url || (!url.startsWith('http') && !url.startsWith('//'))) {
      errorMessage.value = '无可下载的视频地址'
      return
    }

    const normalizedUrl = url.startsWith('//') ? 'https:' + url : url
    isDownloading.value = true
    downloadProgress.value = 0
    errorMessage.value = ''
    downloadAbortController = new AbortController()

    try {
      const idx = playlist.value.indexOf(url)
      const filename = getVideoName(normalizedUrl, idx >= 0 ? idx : currentIndex.value) || `video_${Date.now()}`
      const isHlsVideo = isHlsUrl(normalizedUrl)

      if (isHlsVideo) {
        const { videoSegments, audioSegments } = await m3u8.getM3u8DownloadPlan(normalizedUrl, downloadAbortController.signal)
        const total = videoSegments.length + audioSegments.length
        if (total === 0) {
          throw new Error('M3U8 分片为空，无法下载')
        }
        const videoChunks: Uint8Array[] = new Array(videoSegments.length)
        const audioChunks: Uint8Array[] = new Array(audioSegments.length)
        const CONCURRENCY = opts.getDownloadConcurrency?.() ?? 6
        let completed = 0
        let pointer = 0
        m3u8.clearKeyCache()
        const tasks: DownloadTask[] = [
          ...videoSegments.map((seg, idx) => ({ kind: 'video' as const, idx, ...seg })),
          ...audioSegments.map((seg, idx) => ({ kind: 'audio' as const, idx, ...seg }))
        ]

        const store = (task: DownloadTask, chunk: Uint8Array) => {
          if (task.kind === 'video') videoChunks[task.idx] = chunk
          else audioChunks[task.idx] = chunk
        }

        const runWorker = async () => {
          while (pointer < total) {
            const current = pointer++
            const task = tasks[current]
            const chunk = await fetchSegment(task)
            store(task, chunk)
            completed++
            downloadProgress.value = Math.min(90, Math.round((completed / total) * 90))
          }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => runWorker())
        await Promise.all(workers)

        // 失败收尾：补抓仍缺失的分片（fetchSegment 已重试，这里兜底再抓一轮）
        const missing = tasks.filter(t => (t.kind === 'video' ? videoChunks : audioChunks)[t.idx] == null)
        for (const task of missing) {
          store(task, await fetchSegment(task))
        }

        m3u8.clearKeyCache()

        downloadProgress.value = 92
        const mp4Blob = await mergeSegmentsToMp4(videoChunks, audioChunks)
        const outName = filename.replace(/\.[^.]+$/, '') + '.mp4'
        triggerDownload(mp4Blob, outName)
        downloadProgress.value = 100
        useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
      } else {
        const res = await fetch(getProxyUrl(normalizedUrl), { signal: downloadAbortController.signal })
        if (!res.ok) throw new Error(`下载失败: ${res.status}`)
        const blob = await res.blob()
        downloadProgress.value = 100
        const outName = filename.includes('.mp4') ? filename : filename + '.mp4'
        triggerDownload(blob, outName)
        useToast().add({ title: '下载完成: ' + outName, color: 'green', timeout: 3000 })
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        useToast().add({ title: '下载已取消', color: 'amber', timeout: 2000 })
        return
      }
      console.error('下载失败:', e)
      let msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('fetch') || msg.includes('CORS') || msg.includes('403')) {
        msg += '，可在「连接策略 → 展开设置」里手动填 Origin/Referer 或开启伪装下载器重试'
      }
      errorMessage.value = '下载失败: ' + msg
    } finally {
      isDownloading.value = false
      downloadProgress.value = 0
      downloadAbortController = null
    }
  }

  // 取消下载
  const cancelDownload = () => {
    downloadAbortController?.abort()
    downloadAbortController = null
    isDownloading.value = false
    downloadProgress.value = 0
  }

  return { isDownloading, downloadProgress, downloadVideo, cancelDownload }
}
