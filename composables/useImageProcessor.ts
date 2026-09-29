/**
 * 图片压缩/转换流水线（从 `pages/image-compress.vue` 下沉）。
 *
 * 不认识页面的队列与 UI：由调用方注入 `updateItem` 与三个选项 ref，这里只负责
 * 「一张图 → 处理好的 blob」这段。并发调度（`processNext`/`handleFiles`）仍留在页面。
 */
import type { Ref } from 'vue'
import type { ProcessItem } from './useMediaProcess'

export interface ImageProcessorDeps {
  updateItem: (id: string, updates: Partial<ProcessItem>) => void
  quality: Ref<number>
  maxWidth: Ref<number | undefined>
  outputFormat: Ref<string>
}

export function useImageProcessor(deps: ImageProcessorDeps) {
  const { updateItem, quality, maxWidth, outputFormat } = deps
  const { isTiff, processTiff, decodeTiff } = useTiffProcessor()
  const isPdfOutput = computed(() => outputFormat.value === 'application/pdf')

  const compressPng = async (
    _canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    qualityPercent: number
  ): Promise<Blob> => {
    try {
      // @ts-ignore
      const UPNG = await import('upng-js')

      const imageData = ctx.getImageData(0, 0, width, height)
      const rgba = new Uint8Array(imageData.data.buffer)

      const targetColors = Math.max(8, Math.min(256, Math.round(qualityPercent * 2.56)))

      const pngData = UPNG.encode([rgba.buffer], width, height, targetColors)

      return new Blob([pngData], { type: 'image/png' })
    } catch (e) {
      console.error('PNG compression failed:', e)
      return new Promise<Blob>((resolve, reject) => {
        _canvas.toBlob(
          b => b ? resolve(b) : reject(new Error('PNG 压缩失败')),
          'image/png'
        )
      })
    }
  }

  const convertToPdf = async (item: ProcessItem) => {
    try {
      const { jsPDF } = await import('jspdf')

      let imgDataUrl: string
      let imgWidth: number
      let imgHeight: number

      const isLossless = quality.value === 100
      const imgFormat = isLossless ? 'image/png' : 'image/jpeg'
      const jpegQuality = quality.value / 100

      if (isTiff(item.file)) {
        const { rgba, width, height } = await decodeTiff(item.file)

        imgWidth = width
        imgHeight = height

        if (maxWidth.value && imgWidth > maxWidth.value) {
          imgHeight = Math.round((maxWidth.value / imgWidth) * imgHeight)
          imgWidth = maxWidth.value
        }

        const sourceCanvas = document.createElement('canvas')
        sourceCanvas.width = width
        sourceCanvas.height = height
        const sourceCtx = sourceCanvas.getContext('2d')!
        const imageData = sourceCtx.createImageData(width, height)
        imageData.data.set(rgba)
        sourceCtx.putImageData(imageData, 0, 0)

        const canvas = document.createElement('canvas')
        canvas.width = imgWidth
        canvas.height = imgHeight
        const ctx = canvas.getContext('2d')!
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(sourceCanvas, 0, 0, imgWidth, imgHeight)
        imgDataUrl = isLossless ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', jpegQuality)
      } else {
        const bitmap = await createImageBitmap(item.file)
        imgWidth = bitmap.width
        imgHeight = bitmap.height

        if (maxWidth.value && imgWidth > maxWidth.value) {
          imgHeight = Math.round((maxWidth.value / imgWidth) * imgHeight)
          imgWidth = maxWidth.value
        }

        const canvas = document.createElement('canvas')
        canvas.width = imgWidth
        canvas.height = imgHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0, imgWidth, imgHeight)
        imgDataUrl = isLossless ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', jpegQuality)
      }

      const originalPreviewUrl = imgDataUrl

      const orientation = imgWidth > imgHeight ? 'landscape' : 'portrait'
      const pdf = new jsPDF({
        orientation,
        unit: 'px',
        format: [imgWidth, imgHeight],
      })

      pdf.addImage(imgDataUrl, isLossless ? 'PNG' : 'JPEG', 0, 0, imgWidth, imgHeight)

      const pdfBlob = pdf.output('blob')
      const processedPreview = imgDataUrl

      updateItem(item.id, {
        processedBlob: pdfBlob,
        processedSize: pdfBlob.size,
        processedPreview,
        status: 'completed',
        progress: 100,
        meta: { originalPreviewUrl },
      })
    } catch (error) {
      updateItem(item.id, {
        status: 'error',
        error: error instanceof Error ? error.message : 'PDF 转换失败',
      })
    }
  }

  const compressTiffImage = async (item: ProcessItem) => {
    try {
      let targetFormat: 'png' | 'webp' | 'jpeg' = 'png'

      if (outputFormat.value === 'image/webp') {
        targetFormat = 'webp'
      } else if (outputFormat.value === 'image/jpeg') {
        targetFormat = 'jpeg'
      }

      const originalPreviewUrl = item.preview

      const result = await processTiff(item.file, {
        quality: quality.value,
        maxWidth: maxWidth.value,
        outputFormat: targetFormat,
      })

      const blob = result.blob
      const processedPreview = URL.createObjectURL(blob)

      updateItem(item.id, {
        processedBlob: blob,
        processedSize: blob.size,
        processedPreview,
        status: 'completed',
        progress: 100,
        meta: { originalPreviewUrl },
      })
    } catch (error) {
      updateItem(item.id, {
        status: 'error',
        error: error instanceof Error ? error.message : 'TIFF 处理失败',
      })
    }
  }

  const compressImage = async (item: ProcessItem) => {
    updateItem(item.id, { status: 'processing', progress: 0 })

    try {
      if (isPdfOutput.value) {
        await convertToPdf(item)
        return
      }

      if (isTiff(item.file)) {
        await compressTiffImage(item)
        return
      }

      const bitmap = await createImageBitmap(item.file)

      const originalWidth = bitmap.width
      const originalHeight = bitmap.height

      let width = originalWidth
      let height = originalHeight

      if (maxWidth.value && width > maxWidth.value) {
        height = Math.round((maxWidth.value / width) * height)
        width = maxWidth.value
      }

      const originalCanvas = document.createElement('canvas')
      originalCanvas.width = originalWidth
      originalCanvas.height = originalHeight
      const originalCtx = originalCanvas.getContext('2d')!
      originalCtx.drawImage(bitmap, 0, 0)
      const originalPreviewBlob = await new Promise<Blob>((resolve, reject) => {
        originalCanvas.toBlob(
          b => b ? resolve(b) : reject(new Error('生成原图预览失败')),
          'image/png'
        )
      })
      const originalPreviewUrl = URL.createObjectURL(originalPreviewBlob)

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')!

      let mimeType = outputFormat.value === 'original'
        ? (item.file.type || 'image/jpeg')
        : outputFormat.value

      if (mimeType === 'image/gif') {
        mimeType = 'image/png'
      }

      if (mimeType === 'image/jpeg') {
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, width, height)
      }

      ctx.drawImage(bitmap, 0, 0, width, height)

      const isLossless = quality.value === 100
      let blob: Blob

      if (isLossless) {
        const noResizeNeeded = width === originalWidth && height === originalHeight
        const sameFormat = item.file.type === mimeType

        if (noResizeNeeded && sameFormat) {
          blob = item.file
        } else {
          blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              b => b ? resolve(b) : reject(new Error('转换失败')),
              mimeType
            )
          })
        }
      } else if (mimeType === 'image/png') {
        blob = await compressPng(canvas, ctx, width, height, quality.value)
      } else {
        const qualityValue = quality.value / 100
        blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            b => b ? resolve(b) : reject(new Error('压缩失败')),
            mimeType,
            qualityValue
          )
        })
      }

      if (blob.size >= item.originalSize && blob !== item.file) {
        blob = item.file
      }

      const processedPreview = URL.createObjectURL(blob)

      updateItem(item.id, {
        processedBlob: blob,
        processedSize: blob.size,
        processedPreview,
        status: 'completed',
        progress: 100,
        meta: { originalPreviewUrl },
      })
    } catch (error) {
      updateItem(item.id, {
        status: 'error',
        error: error instanceof Error ? error.message : '压缩失败',
      })
    }
  }

  const getCompressionRate = (item: ProcessItem): string => {
    if (!item.processedSize) return '0%'
    const rate = ((1 - item.processedSize / item.originalSize) * 100).toFixed(0)
    return `${rate}%`
  }

  return { compressImage, getCompressionRate }
}
