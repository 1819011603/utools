import { usePdfProcessor } from '~/composables/usePdfProcessor'
import type { PdfToolsApi } from '~/composables/usePdfTools'

export function usePdfImageToPdf(pdfTools: PdfToolsApi) {
  const { processing, downloadResult } = pdfTools
  const { imagesToPdf } = usePdfProcessor()

  const imageFiles = ref<File[]>([])
  const imagePreviews = new Map<File, string>()
  let imgDragIndex = -1

  const handleImageFiles = (files: File[]) => {
    const imgs = files.filter(f => f.type.startsWith('image/'))
    imageFiles.value.push(...imgs)
  }

  const getImagePreview = (file: File): string => {
    if (imagePreviews.has(file)) {
      return imagePreviews.get(file)!
    }
    const url = URL.createObjectURL(file)
    imagePreviews.set(file, url)
    return url
  }

  const imgDragStart = (index: number) => {
    imgDragIndex = index
  }

  const imgDrop = (index: number) => {
    if (imgDragIndex === -1 || imgDragIndex === index) return
    const item = imageFiles.value.splice(imgDragIndex, 1)[0]
    imageFiles.value.splice(index, 0, item)
    imgDragIndex = -1
  }

  const doImagesToPdf = async () => {
    if (imageFiles.value.length === 0) return
    processing.value = true

    try {
      const result = await imagesToPdf(imageFiles.value)
      downloadResult(result)
    } catch (e) {
      console.error(e)
    } finally {
      processing.value = false
    }
  }

  onUnmounted(() => {
    imagePreviews.forEach(url => URL.revokeObjectURL(url))
    imagePreviews.clear()
  })

  return {
    imageFiles,
    handleImageFiles,
    getImagePreview,
    imgDragStart,
    imgDrop,
    doImagesToPdf
  }
}
