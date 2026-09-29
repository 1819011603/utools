import { usePdfProcessor } from '~/composables/usePdfProcessor'
import type { PdfToolsApi } from '~/composables/usePdfTools'

export function usePdfSplit(pdfTools: PdfToolsApi) {
  const { processing, downloadResult, downloadBlob, revokePdfPreview } = pdfTools
  const { splitPdf, splitAndMergePdf, splitPdfToSinglePages, getPdfPageCount } = usePdfProcessor()

  const splitFile = ref<File | null>(null)
  const splitPageCount = ref(0)
  const splitMode = ref('single')
  const splitOutputMode = ref('separate')  // 'merge' 合并成一个, 'separate' 分成多个
  const splitRanges = ref<Array<{ start: number; end: number }>>([{ start: 1, end: 9999 }])

  const splitModeOptions = [
    { value: 'single', label: '每页单独一个文件' },
    { value: 'range', label: '按范围拆分' }
  ]

  const splitOutputOptions = [
    { value: 'separate', label: '每个范围单独一个文件 (如: 1-30.pdf, 60-90.pdf)' },
    { value: 'merge', label: '所有范围合并成一个文件' }
  ]

  const addSplitRange = () => {
    const totalPages = splitPageCount.value || 1
    const lastRange = splitRanges.value[splitRanges.value.length - 1]
    const nextStart = lastRange
      ? Math.min(totalPages, Math.max(1, Math.floor(lastRange.end) + 1))
      : 1

    splitRanges.value.push({ start: nextStart, end: totalPages })
  }

  const removeSplitRange = (index: number) => {
    if (splitRanges.value.length <= 1) return
    splitRanges.value.splice(index, 1)
  }

  const parsedRangesForPreview = computed(() => {
    const max = splitPageCount.value || Number.MAX_SAFE_INTEGER
    return splitRanges.value
      .map(r => ({
        start: Number.isFinite(r.start) ? Math.max(1, Math.min(Math.floor(r.start), max)) : 1,
        end: Number.isFinite(r.end) ? Math.max(1, Math.min(Math.floor(r.end), max)) : 1
      }))
      .filter(r => r.start <= r.end)
  })

  const parsedRangesPreview = computed(() => {
    const ranges = parsedRangesForPreview.value
    if (ranges.length === 0) return '无有效范围'
    return ranges.map(r => r.start === r.end ? `第${r.start}页` : `第${r.start}-${r.end}页`).join(' 和 ')
  })

  const parsedRangesCount = computed(() => {
    return parsedRangesForPreview.value.length
  })

  // 检查范围是否超出 PDF 页数
  const hasInvalidRanges = computed(() => {
    if (splitPageCount.value === 0) return false
    return splitRanges.value.some(r => r.start < 1 || r.end < 1 || r.start > r.end || r.end > splitPageCount.value)
  })

  const invalidRangesMessage = computed(() => {
    if (!hasInvalidRanges.value) return ''
    const invalid = splitRanges.value.filter(r => r.start < 1 || r.end < 1 || r.start > r.end || r.end > splitPageCount.value)
    return `注意：${invalid.map(r => `${r.start}-${r.end}`).join('、')} 超出 PDF 页数（共 ${splitPageCount.value} 页），将自动调整`
  })

  const handleSplitFile = async (files: File[]) => {
    const file = files.find(f => f.type === 'application/pdf')
    if (file) {
      splitFile.value = file
      splitPageCount.value = await getPdfPageCount(file)
      splitRanges.value = [{ start: 1, end: splitPageCount.value || 1 }]
    }
  }

  const clearSplitFile = () => {
    if (splitFile.value) {
      revokePdfPreview(splitFile.value)
    }
    splitFile.value = null
    splitPageCount.value = 0
  }

  const doSplit = async () => {
    if (!splitFile.value) return
    processing.value = true

    try {
      if (splitMode.value === 'single') {
        // 每页单独一个文件
        const results = await splitPdfToSinglePages(splitFile.value)

        if (results.length === 1) {
          downloadResult(results[0])
        } else {
          // 多个文件打包下载（jszip 300KB+，用到才拉）
          const JSZip = (await import('jszip')).default
          const zip = new JSZip()
          for (const result of results) {
            zip.file(result.fileName, result.blob)
          }
          const zipBlob = await zip.generateAsync({ type: 'blob' })
          downloadBlob(zipBlob, 'split_pdfs.zip')
        }
      } else {
        // 按范围拆分 - 先用宽松解析获取用户输入的范围
        const inputRanges = parsedRangesForPreview.value
        if (inputRanges.length === 0) {
          alert('请输入有效的页面范围')
          return
        }

        // 自动调整超出 PDF 页数的范围
        const maxPage = splitPageCount.value
        const adjustedRanges = inputRanges
          .map(r => ({
            start: Math.max(1, Math.min(r.start, maxPage)),
            end: Math.max(1, Math.min(r.end, maxPage))
          }))
          .filter(r => r.start <= r.end && r.start >= 1)

        if (adjustedRanges.length === 0) {
          alert('所有范围都超出了 PDF 页数范围')
          return
        }

        if (splitOutputMode.value === 'merge') {
          // 所有范围合并成一个文件
          const result = await splitAndMergePdf(splitFile.value, adjustedRanges)
          downloadResult(result)
        } else {
          // 每个范围单独一个文件
          const results = await splitPdf(splitFile.value, adjustedRanges)

          if (results.length === 1) {
            downloadResult(results[0])
          } else {
            // 多个文件打包下载（jszip 300KB+，用到才拉）
            const JSZip = (await import('jszip')).default
            const zip = new JSZip()
            for (const result of results) {
              zip.file(result.fileName, result.blob)
            }
            const zipBlob = await zip.generateAsync({ type: 'blob' })
            downloadBlob(zipBlob, 'split_pdfs.zip')
          }
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      processing.value = false
    }
  }

  return {
    splitFile,
    splitPageCount,
    splitMode,
    splitOutputMode,
    splitRanges,
    splitModeOptions,
    splitOutputOptions,
    addSplitRange,
    removeSplitRange,
    parsedRangesPreview,
    parsedRangesCount,
    hasInvalidRanges,
    invalidRangesMessage,
    handleSplitFile,
    clearSplitFile,
    doSplit
  }
}
