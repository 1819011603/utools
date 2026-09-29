/**
 * PDF 公共类型 + 文件读取。从 usePdfProcessor.ts 拆出（原文件 700+ 行）。
 */
import { PDFDocument } from 'pdf-lib'

export interface PdfProcessResult {
  blob: Blob
  pageCount: number
  fileName: string
}

export interface WatermarkOptions {
  text: string
  fontSize: number
  opacity: number
  color: string
  rotation: number
  position: 'center' | 'diagonal' | 'tile'
}

export interface PdfMergeRangeItem {
  file: File
  start: number
  end: number
}

export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

export const getPdfPageCount = async (file: File): Promise<number> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  return pdfDoc.getPageCount()
}
