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

    const frames: GifFrame[] = []

    for (let i = 0; i < totalFrames; i++) {
      const time = startTime + (i / fps)
      if (time > endTime) break

      await seekVideo(video, time)
      
      ctx.drawImage(video, 0, 0, width, height)
      const imageData = ctx.getImageData(0, 0, width, height)
      
      frames.push({ imageData, delay: frameDelay })
      onProgress?.(i + 1, totalFrames)
    }

    return frames
  }

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
        delay: frame.delay,
        transparent: options.transparent ? 0x00FF00 : null
      })
    }

    gif.on('progress', (p: number) => {
      onProgress?.(p)
    })

    return new Promise<Blob>((resolve, reject) => {
      gif.on('finished', (blob: Blob) => resolve(blob))
      gif.on('error', (err: Error) => reject(err))
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
    }
  ): Promise<Blob> => {
    isEncoding.value = true
    
    try {
      progress.value = {
        phase: 'extracting',
        progress: 0,
        currentFrame: 0,
        totalFrames: Math.ceil((options.endTime - options.startTime) * options.fps),
        message: '提取帧中...'
      }

      const frames = await extractFramesFromVideo(video, {
        startTime: options.startTime,
        endTime: options.endTime,
        fps: options.fps,
        width: options.width,
        height: options.height,
        onProgress: (current, total) => {
          progress.value = {
            phase: 'extracting',
            progress: Math.round((current / total) * 50),
            currentFrame: current,
            totalFrames: total,
            message: `提取帧 (${current}/${total})`
          }
        }
      })

      progress.value = {
        phase: 'encoding',
        progress: 50,
        message: `生成 GIF (${options.workers} 线程)...`
      }

      const blob = await encodeGif(frames, {
        width: options.width,
        height: options.height,
        quality: options.quality,
        workers: options.workers,
        dither: options.dither,
        repeat: options.repeat,
        transparent: options.transparent
      }, (p) => {
        progress.value = {
          phase: 'encoding',
          progress: 50 + Math.round(p * 50),
          message: `编码中 ${Math.round(p * 100)}%`
        }
      })

      progress.value = {
        phase: 'done',
        progress: 100,
        message: '完成!'
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
    const bytesPerFrame = pixels * 0.4 * colorFactor * qualityFactor
    return Math.round(frames * bytesPerFrame)
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
