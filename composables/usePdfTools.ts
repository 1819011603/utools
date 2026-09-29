import type { PdfProcessResult } from '~/composables/usePdfProcessor'

/**
 * PDF 工具箱的公共外壳：工具清单 / 当前工具 / 处理中状态 / 通用下载 / 外链 / 预览弹窗。
 * 合并、拆分、图片转 PDF 各自的流程见 `usePdfMerge` / `usePdfSplit` / `usePdfImageToPdf`。
 */
export function usePdfTools() {
  const tools = [
    { id: 'merge', name: 'PDF 合并', icon: 'i-heroicons-document-duplicate', bgColor: 'bg-blue-100 dark:bg-blue-900/50', iconColor: 'text-blue-600 dark:text-blue-400' },
    { id: 'split', name: 'PDF 拆分', icon: 'i-heroicons-scissors', bgColor: 'bg-purple-100 dark:bg-purple-900/50', iconColor: 'text-purple-600 dark:text-purple-400' },
    { id: 'compress', name: 'PDF压缩(在线)', icon: 'i-heroicons-arrow-down-on-square-stack', bgColor: 'bg-green-100 dark:bg-green-900/50', iconColor: 'text-green-600 dark:text-green-400' },
    { id: 'pdf2word-online', name: 'PDF转Word(在线)', icon: 'i-heroicons-document-text', bgColor: 'bg-red-100 dark:bg-red-900/50', iconColor: 'text-red-600 dark:text-red-400' },
    { id: 'word2pdf-online', name: 'Word转PDF(在线)', icon: 'i-heroicons-document-plus', bgColor: 'bg-blue-100 dark:bg-blue-900/50', iconColor: 'text-blue-600 dark:text-blue-400' },
    { id: 'watermark', name: 'PDF签名/水印(在线)', icon: 'i-heroicons-paint-brush', bgColor: 'bg-cyan-100 dark:bg-cyan-900/50', iconColor: 'text-cyan-600 dark:text-cyan-400' },
    { id: 'img2pdf', name: '图片→PDF', icon: 'i-heroicons-photo', bgColor: 'bg-orange-100 dark:bg-orange-900/50', iconColor: 'text-orange-600 dark:text-orange-400' }
  ]

  const activeTool = ref('merge')
  const processing = ref(false)

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const downloadResult = (result: PdfProcessResult) => {
    downloadBlob(result.blob, result.fileName)
  }

  const openExternal = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const pdfPreviewUrls = new Map<File, string>()
  const showPdfPreview = ref(false)
  const previewPdfTitle = ref('')
  const previewPdfUrl = ref('')

  const getPdfPreviewUrl = (file: File): string => {
    if (pdfPreviewUrls.has(file)) {
      return pdfPreviewUrls.get(file)!
    }
    const url = URL.createObjectURL(file)
    pdfPreviewUrls.set(file, url)
    return url
  }

  const openPdfPreview = (file: File, title?: string) => {
    previewPdfTitle.value = title || file.name
    previewPdfUrl.value = getPdfPreviewUrl(file)
    showPdfPreview.value = true
  }

  const revokePdfPreview = (file: File) => {
    const url = pdfPreviewUrls.get(file)
    if (url) {
      URL.revokeObjectURL(url)
      pdfPreviewUrls.delete(file)
    }
  }

  onUnmounted(() => {
    pdfPreviewUrls.forEach(url => URL.revokeObjectURL(url))
    pdfPreviewUrls.clear()
  })

  return {
    tools,
    activeTool,
    processing,
    formatSize,
    downloadBlob,
    downloadResult,
    openExternal,
    showPdfPreview,
    previewPdfTitle,
    previewPdfUrl,
    openPdfPreview,
    revokePdfPreview
  }
}

export type PdfToolsApi = ReturnType<typeof usePdfTools>
