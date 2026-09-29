import { usePdfProcessor } from '~/composables/usePdfProcessor'
import type { PdfToolsApi } from '~/composables/usePdfTools'

export interface MergeItem {
  file: File
  pageCount: number
  start: number
  end: number
}

export function usePdfMerge(pdfTools: PdfToolsApi) {
  const { processing, downloadResult, revokePdfPreview } = pdfTools
  const { mergePdfsWithRanges, getPdfPageCount } = usePdfProcessor()

  const mergeItems = ref<MergeItem[]>([])
  let dragIndex = -1

  const mergeFilesTotalSize = computed(() => {
    return mergeItems.value.reduce((sum, f) => sum + f.file.size, 0)
  })

  const handleMergeFiles = async (files: File[]) => {
    const pdfFiles = files.filter(f => f.type === 'application/pdf')
    for (const file of pdfFiles) {
      const pageCount = await getPdfPageCount(file)
      mergeItems.value.push({
        file,
        pageCount,
        start: 1,
        end: pageCount
      })
    }
  }

  const removeMergeFile = (index: number) => {
    const item = mergeItems.value[index]
    if (item) {
      revokePdfPreview(item.file)
    }
    mergeItems.value.splice(index, 1)
  }

  const clearMergeItems = () => {
    mergeItems.value.forEach(item => revokePdfPreview(item.file))
    mergeItems.value = []
  }

  const dragStart = (index: number) => {
    dragIndex = index
  }

  const drop = (index: number) => {
    if (dragIndex === -1 || dragIndex === index) return
    const item = mergeItems.value.splice(dragIndex, 1)[0]
    mergeItems.value.splice(index, 0, item)
    dragIndex = -1
  }

  const doMerge = async () => {
    if (mergeItems.value.length < 2) return
    processing.value = true
    try {
      const validItems = mergeItems.value
        .map(item => ({
          file: item.file,
          start: Math.max(1, Math.min(item.start, item.pageCount)),
          end: Math.max(1, Math.min(item.end, item.pageCount))
        }))
        .map(item => ({
          ...item,
          start: Math.min(item.start, item.end),
          end: Math.max(item.start, item.end)
        }))

      const result = await mergePdfsWithRanges(validItems)
      downloadResult(result)
    } catch (e) {
      console.error(e)
    } finally {
      processing.value = false
    }
  }

  return {
    mergeItems,
    mergeFilesTotalSize,
    handleMergeFiles,
    removeMergeFile,
    clearMergeItems,
    dragStart,
    drop,
    doMerge
  }
}
