import GIF from 'gif.js'

export interface GifEncoderOptions {
  width: number
  height: number
  quality: number
  workers: number
  dither: DitherType
  repeat: number
  transparent?: string | null
}

export type DitherType = false | 'FloydSteinberg' | 'FalseFloydSteinberg' | 'Stucki' | 'Atkinson'

export interface GifFrame {
  imageData: ImageData
  delay: number
}

export interface EncodingProgress {
  phase: 'extracting' | 'encoding' | 'done' | 'error'
  progress: number
  currentFrame?: number
  totalFrames?: number
  message: string
}

export const DITHER_OPTIONS = [
  { label: '无抖动 (最清晰)', value: false as const },
  { label: 'Floyd-Steinberg (平滑过渡)', value: 'FloydSteinberg' as const },
  { label: 'Atkinson (复古风格)', value: 'Atkinson' as const }
]

export const QUALITY_OPTIONS = [
  { label: '最高清晰度 (推荐)', value: 1 },
  { label: '高清晰度', value: 5 },
  { label: '中等清晰度', value: 10 },
  { label: '较低清晰度 (文件小)', value: 20 }
]

export const COLOR_OPTIONS = [
  { label: '256 色 (最清晰)', value: 256 },
  { label: '128 色', value: 128 },
  { label: '64 色 (较小文件)', value: 64 }
]

export const REPEAT_OPTIONS = [
  { label: '无限循环', value: 0 },
  { label: '播放 1 次', value: 1 },
  { label: '播放 2 次', value: 2 },
  { label: '播放 3 次', value: 3 }
]

export function useGifEncoder() {
  const isEncoding = ref(false)
  const progress = ref<EncodingProgress>({
    phase: 'done',
    progress: 0,
    message: ''
  })

  const seekVideo = (video: HTMLVideoElement, time: number): Promise<void> => {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        resolve()
      }
      video.addEventListener('seeked', onSeeked)
      video.currentTime = time
    })
  }

  const isSimilarFrame = (
    a: Uint8ClampedArray,
    b: Uint8ClampedArray,
    stride = 10,
    thresholdPercent = 5
  ): boolean => {
    let diff = 0, count = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i += 4 * stride) {
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      count++
    }
    const max = count * 3 * 255
    return count > 0 ? ((diff / max) * 100) < thresholdPercent : false
  }

  const pickTargetColors = (w: number, h: number, quality: number, dither: DitherType): number => {
    const px = w * h
    let base = px <= 300 * 300 ? 160 : 192
    if (dither === false) base = Math.min(256, base + 32)
    if (quality <= 5) base = Math.min(256, base + 16)
    return Math.max(64, Math.min(256, base))
  }

  const ensureQuantize = async (): Promise<any | null> => {
    try {
      // @ts-ignore
      const mod = await import('quantize')
      return (mod as any).default || mod
    } catch {
      return null
    }
  }

  const buildGlobalPalette = async (
    video: HTMLVideoElement,
    opts: { start: number; end: number; samples: number; width: number; height: number; targetColors: number }
  ): Promise<number[] | undefined> => {
    const quantize = await ensureQuantize()
    if (!quantize) return undefined

    const { start, end, samples, width, height, targetColors } = opts
    const dur = Math.max(0.01, end - start)
    const step = dur / samples

    const sampleW = Math.min(120, width)
    const sampleH = Math.round(sampleW * (height / width))

    const canvas = document.createElement('canvas')
    canvas.width = sampleW
    canvas.height = sampleH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const pixels: number[][] = []
    for (let i = 0; i < samples; i++) {
      const t = start + i * step
      await seekVideo(video, t)
      ctx.drawImage(video, 0, 0, sampleW, sampleH)
      const data = ctx.getImageData(0, 0, sampleW, sampleH).data
      for (let p = 0; p < data.length; p += 4 * 6) {
        if (data[p + 3] < 128) continue
        pixels.push([data[p], data[p + 1], data[p + 2]])
      }
    }

    const cmap = quantize(pixels, Math.min(256, Math.max(2, targetColors)))
    const pal = cmap ? cmap.palette() : null
    if (!pal) return undefined

    const flat: number[] = []
    for (const [r, g, b] of pal) flat.push(r, g, b)
    return flat
  }

  const extractFramesFromVideo = async (
    video: HTMLVideoElement,
    options: {
      startTime: number
      endTime: number
      fps: number
      width: number
      height: number
      onProgress?: (current: number, total: number) => void
    }
  ): Promise<GifFrame[]> => {
    const { startTime, endTime, fps, width, height, onProgress } = options
    const duration = endTime - startTime
    const totalFrames = Math.ceil(duration * fps)
    const frameDelay = Math.round(1000 / fps)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) {
      (ctx as any).imageSmoothingQuality = 'high'
    }

    const frames: GifFrame[] = []

    for (let i = 0; i < totalFrames; i++) {
      const time = startTime + (i / fps)
      if (time > endTime) break

      await seekVideo(video, time)

      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(video, 0, 0, width, height)
      const imageData = ctx.getImageData(0, 0, width, height)

      frames.push({ imageData, delay: frameDelay })
      onProgress?.(i + 1, totalFrames)
    }

    return frames
  }

  const encodeGif = async (
    frames: GifFrame[],
    options: GifEncoderOptions,
    onProgress?: (p: number) => void
  ): Promise<Blob> => {
    const gif = new GIF({
      workers: options.workers,
      quality: options.quality,
      width: options.width,
      height: options.height,
      workerScript: '/gif.worker.js',
      dither: options.dither,
      repeat: options.repeat,
      transparent: options.transparent
    })

    for (const frame of frames) {
      gif.addFrame(frame.imageData, {
        delay: frame.delay
      })
    }

    gif.on('progress', (p: number) => {
      onProgress?.(p)
    })

    return new Promise<Blob>((resolve, reject) => {
      gif.on('finished', (blob: Blob) => resolve(blob))
      ;(gif as any).on('error', (err: Error) => reject(err))
      gif.render()
    })
  }

  const convertVideoToGif = async (
    video: HTMLVideoElement,
    options: {
      startTime: number
      endTime: number
      fps: number
      width: number
      height: number
      quality: number
      workers: number
      dither: DitherType
      repeat: number
      transparent?: string | null
      skipSimilar?: boolean
    }
  ): Promise<Blob> => {
    isEncoding.value = true

    try {
      const duration = Math.max(0, options.endTime - options.startTime)
      const totalFrames = Math.ceil(duration * options.fps)
      const frameDelay = Math.round(1000 / options.fps)
      const skipSimilar = options.skipSimilar !== false

      const canvas = document.createElement('canvas')
      canvas.width = options.width
      canvas.height = options.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.imageSmoothingEnabled = true
      if ('imageSmoothingQuality' in ctx) {
        (ctx as any).imageSmoothingQuality = 'high'
      }

      const thumbW = 48
      const thumbH = Math.round(thumbW * (options.height / options.width))
      const thumbCanvas = document.createElement('canvas')
      thumbCanvas.width = thumbW
      thumbCanvas.height = thumbH
      const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!

      progress.value = {
        phase: 'extracting',
        progress: 0,
        currentFrame: 0,
        totalFrames,
        message: '构建调色板...'
      }

      const targetColors = pickTargetColors(options.width, options.height, options.quality, options.dither)
      let globalPalette: number[] | undefined
      try {
        globalPalette = await buildGlobalPalette(video, {
          start: options.startTime,
          end: options.endTime,
          samples: Math.min(12, Math.max(6, Math.ceil(totalFrames / 5))),
          width: options.width,
          height: options.height,
          targetColors
        })
      } catch {}

      const gif = new (GIF as any)({
        workers: options.workers,
        quality: options.quality,
        width: options.width,
        height: options.height,
        workerScript: '/gif.worker.js',
        dither: options.dither,
        repeat: options.repeat,
        globalPalette
      })

      let lastThumb: Uint8ClampedArray | null = null
      let accDelay = 0
      let pushedFrames = 0

      for (let i = 0; i < totalFrames; i++) {
        const time = options.startTime + (i / options.fps)
        if (time > options.endTime) break

        await seekVideo(video, time)

        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        thumbCtx.drawImage(video, 0, 0, thumbW, thumbH)
        const currThumb = thumbCtx.getImageData(0, 0, thumbW, thumbH).data

        const isLast = i === totalFrames - 1
        const similar = skipSimilar && lastThumb && isSimilarFrame(currThumb, lastThumb, 8, 4)

        if (similar && !isLast) {
          accDelay += frameDelay
        } else {
          gif.addFrame(ctx, {
            copy: true,
            delay: frameDelay + accDelay,
            dispose: 2
          })
          accDelay = 0
          pushedFrames++
          lastThumb = new Uint8ClampedArray(currThumb)
        }

        const pct = Math.round(((i + 1) / totalFrames) * 50)
        progress.value = {
          phase: 'extracting',
          progress: pct,
          currentFrame: i + 1,
          totalFrames,
          message: `提取帧 (${i + 1}/${totalFrames})${skipSimilar ? ` - 已优化 ${totalFrames - pushedFrames} 帧` : ''}`
        }
      }

      if (pushedFrames === 0) {
        gif.addFrame(ctx, { copy: true, delay: frameDelay, dispose: 2 })
      }

      progress.value = {
        phase: 'encoding',
        progress: 50,
        message: `生成 GIF (${options.workers} 线程, ${pushedFrames} 帧)...`
      }

      gif.on('progress', (p: number) => {
        progress.value = {
          phase: 'encoding',
          progress: 50 + Math.round(p * 50),
          message: `编码中 ${Math.round(p * 100)}%`
        }
      })

      const blob = await new Promise<Blob>((resolve, reject) => {
        gif.on('finished', (blob: Blob) => resolve(blob))
        gif.on('error', (err: Error) => reject(err))
        gif.render()
      })

      progress.value = {
        phase: 'done',
        progress: 100,
        message: `完成! (${pushedFrames}/${totalFrames} 帧)`
      }

      return blob
    } catch (error) {
      progress.value = {
        phase: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : '转换失败'
      }
      throw error
    } finally {
      isEncoding.value = false
    }
  }

  const captureFrame = (
    video: HTMLVideoElement,
    width: number,
    height: number
  ): string => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) {
      (ctx as any).imageSmoothingQuality = 'high'
    }
    ctx.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/png')
  }

  const estimateGifSize = (
    frames: number,
    width: number,
    height: number,
    colors: number,
    quality: number
  ): number => {
    const pixels = width * height
    const colorFactor = colors / 256
    const qualityFactor = (40 - quality) / 40
    const bytesPerFrame = pixels * 0.35 * colorFactor * qualityFactor
    return Math.round(frames * bytesPerFrame * 0.7)
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  const formatTime = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '0:00.0'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    const ms = Math.floor((seconds % 1) * 10)
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`
  }

  return {
    isEncoding: readonly(isEncoding),
    progress: readonly(progress),
    convertVideoToGif,
    extractFramesFromVideo,
    encodeGif,
    captureFrame,
    estimateGifSize,
    formatFileSize,
    formatTime
  }
}
