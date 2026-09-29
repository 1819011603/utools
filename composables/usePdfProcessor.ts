/**
 * PDF 工具的组合式入口。实现按操作拆到 `./pdf/` 下（原文件 700+ 行）：
 *   · pdfIo        公共类型 + 文件读取/页数
 *   · pdfPages     合并 / 拆分 / 提取 / 旋转 / 删除 / 压缩
 *   · pdfWatermark 水印（画布渲中文 → embedPng）
 *   · pdfConvert   Word↔PDF / 图片转 PDF
 * 这里只做装配，返回的对象形状与拆分前完全一致。
 */
import { readFileAsArrayBuffer, getPdfPageCount } from './pdf/pdfIo'
import {
  mergePdfs, mergePdfsWithRanges, splitPdf, splitAndMergePdf, splitPdfToSinglePages,
  compressPdf, extractPages, rotatePages, deletePages,
} from './pdf/pdfPages'
import { addWatermark, removeWatermark } from './pdf/pdfWatermark'
import { wordToPdf, pdfToWord, imagesToPdf } from './pdf/pdfConvert'

export type { PdfProcessResult, WatermarkOptions, PdfMergeRangeItem } from './pdf/pdfIo'

export function usePdfProcessor() {
  return {
    getPdfPageCount,
    mergePdfs,
    mergePdfsWithRanges,
    splitPdf,
    splitAndMergePdf,
    splitPdfToSinglePages,
    compressPdf,
    addWatermark,
    removeWatermark,
    extractPages,
    rotatePages,
    wordToPdf,
    pdfToWord,
    imagesToPdf,
    deletePages,
    readFileAsArrayBuffer,
  }
}
