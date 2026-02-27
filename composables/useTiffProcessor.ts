import * as UTIF from 'utif2'

export interface TiffProcessOptions {
  quality?: number
  maxWidth?: number
  outputFormat?: 'png' | 'webp' | 'jpeg'
}

export interface TiffProcessResult {
  blob: Blob
  width: number
  height: number
}

export function useTiffProcessor() {
  const isTiff = (file: File): boolean => {
    const ext = file.name.toLowerCase()
    return ext.endsWith('.tiff') || ext.endsWith('.tif') || file.type === 'image/tiff'
  }

  const decodeTiff = async (file: File): Promise<{ rgba: Uint8Array; width: number; height: number }> => {
    const buffer = await file.arrayBuffer()
    const ifds = UTIF.decode(buffer)
    
    if (ifds.length === 0) {
      throw new Error('无法解析 TIFF 文件')
    }

    const firstPage = ifds[0]
    UTIF.decodeImage(buffer, firstPage)
    const rgba = UTIF.toRGBA8(firstPage)

    return {
      rgba: new Uint8Array(rgba),
      width: firstPage.width,
      height: firstPage.height
    }
  }

  const createCanvasFromRgba = (
    rgba: Uint8Array,
    width: number,
    height: number,
    targetWidth?: number,
    targetHeight?: number
  ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; finalWidth: number; finalHeight: number } => {
    let finalWidth = targetWidth || width
    let finalHeight = targetHeight || height

    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = width
    sourceCanvas.height = height
    const sourceCtx = sourceCanvas.getContext('2d')!
    
    const imageData = sourceCtx.createImageData(width, height)
    imageData.data.set(rgba)
    sourceCtx.putImageData(imageData, 0, 0)

    const canvas = document.createElement('canvas')
    canvas.width = finalWidth
    canvas.height = finalHeight
    const ctx = canvas.getContext('2d')!
    
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(sourceCanvas, 0, 0, finalWidth, finalHeight)

    return { canvas, ctx, finalWidth, finalHeight }
  }

  const processTiff = async (
    file: File,
    options: TiffProcessOptions = {}
  ): Promise<TiffProcessResult> => {
    const { quality = 90, maxWidth, outputFormat = 'png' } = options

    const { rgba, width, height } = await decodeTiff(file)
    
    let finalWidth = width
    let finalHeight = height
    
    if (maxWidth && width > maxWidth) {
      finalHeight = Math.round((maxWidth / width) * height)
      finalWidth = maxWidth
    }

    const { canvas, ctx } = createCanvasFromRgba(rgba, width, height, finalWidth, finalHeight)

    let blob: Blob
    const isLossless = quality === 100

    if (outputFormat === 'png') {
      if (isLossless) {
        blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            b => b ? resolve(b) : reject(new Error('PNG 编码失败')),
            'image/png'
          )
        })
      } else {
        blob = await compressToPng(ctx, finalWidth, finalHeight, quality)
      }
    } else if (outputFormat === 'webp') {
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          b => b ? resolve(b) : reject(new Error('WebP 编码失败')),
          'image/webp',
          isLossless ? 1 : quality / 100
        )
      })
    } else {
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = finalWidth
      tempCanvas.height = finalHeight
      const tempCtx = tempCanvas.getContext('2d')!
      tempCtx.fillStyle = '#FFFFFF'
      tempCtx.fillRect(0, 0, finalWidth, finalHeight)
      tempCtx.drawImage(canvas, 0, 0)
      
      blob = await new Promise<Blob>((resolve, reject) => {
        tempCanvas.toBlob(
          b => b ? resolve(b) : reject(new Error('JPEG 编码失败')),
          'image/jpeg',
          isLossless ? 1 : quality / 100
        )
      })
    }

    return { blob, width: finalWidth, height: finalHeight }
  }

  const compressToPng = async (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    quality: number
  ): Promise<Blob> => {
    try {
      // @ts-ignore
      const UPNG = await import('upng-js')
      const imageData = ctx.getImageData(0, 0, width, height)
      const rgba = new Uint8Array(imageData.data.buffer)
      const targetColors = Math.max(32, Math.min(256, Math.round(quality * 2.56)))
      const pngData = UPNG.encode([rgba.buffer], width, height, targetColors)
      return new Blob([pngData], { type: 'image/png' })
    } catch {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const newCtx = canvas.getContext('2d')!
      newCtx.putImageData(ctx.getImageData(0, 0, width, height), 0, 0)
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          b => b ? resolve(b) : reject(new Error('PNG 编码失败')),
          'image/png'
        )
      })
    }
  }

  const createTiffPreview = async (file: File): Promise<string> => {
    const { rgba, width, height } = await decodeTiff(file)
    
    const previewMaxSize = 800
    let previewWidth = width
    let previewHeight = height
    
    if (width > previewMaxSize || height > previewMaxSize) {
      const ratio = Math.min(previewMaxSize / width, previewMaxSize / height)
      previewWidth = Math.round(width * ratio)
      previewHeight = Math.round(height * ratio)
    }

    const { canvas } = createCanvasFromRgba(rgba, width, height, previewWidth, previewHeight)
    
    return canvas.toDataURL('image/png')
  }

  return {
    isTiff,
    decodeTiff,
    processTiff,
    createTiffPreview
  }
}
