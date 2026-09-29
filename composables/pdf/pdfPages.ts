import { PDFDocument, degrees } from 'pdf-lib'
import { readFileAsArrayBuffer } from './pdfIo'
import type { PdfProcessResult, PdfMergeRangeItem } from './pdfIo'

export const mergePdfs = async (files: File[]): Promise<PdfProcessResult> => {
  const mergedPdf = await PDFDocument.create()
  
  for (const file of files) {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices())
    pages.forEach(page => mergedPdf.addPage(page))
  }
  
  const pdfBytes = await mergedPdf.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  return {
    blob,
    pageCount: mergedPdf.getPageCount(),
    fileName: 'merged.pdf'
  }
}

export const mergePdfsWithRanges = async (items: PdfMergeRangeItem[]): Promise<PdfProcessResult> => {
  const mergedPdf = await PDFDocument.create()

  for (const item of items) {
    const arrayBuffer = await readFileAsArrayBuffer(item.file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    const pageCount = pdfDoc.getPageCount()

    const start = Math.max(1, Math.min(item.start, pageCount))
    const end = Math.max(start, Math.min(item.end, pageCount))
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i)

    const pages = await mergedPdf.copyPages(pdfDoc, indices)
    pages.forEach(page => mergedPdf.addPage(page))
  }

  const pdfBytes = await mergedPdf.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })

  return {
    blob,
    pageCount: mergedPdf.getPageCount(),
    fileName: 'merged.pdf'
  }
}

export const splitPdf = async (
  file: File, 
  ranges: Array<{ start: number; end: number }>
): Promise<PdfProcessResult[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const results: PdfProcessResult[] = []
  
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i]
    const newPdf = await PDFDocument.create()
    const pageIndices = Array.from(
      { length: end - start + 1 }, 
      (_, idx) => start - 1 + idx
    )
    const pages = await newPdf.copyPages(pdfDoc, pageIndices)
    pages.forEach(page => newPdf.addPage(page))
    
    const pdfBytes = await newPdf.save()
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
    const baseName = file.name.replace('.pdf', '')
    results.push({
      blob,
      pageCount: newPdf.getPageCount(),
      fileName: `${baseName}_${start}-${end}.pdf`
    })
  }
  
  return results
}

export const splitAndMergePdf = async (
  file: File, 
  ranges: Array<{ start: number; end: number }>
): Promise<PdfProcessResult> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const newPdf = await PDFDocument.create()
  
  // 收集所有范围的页面索引
  const allPageIndices: number[] = []
  for (const { start, end } of ranges) {
    for (let i = start - 1; i < end; i++) {
      if (!allPageIndices.includes(i)) {
        allPageIndices.push(i)
      }
    }
  }
  
  // 按顺序排序
  allPageIndices.sort((a, b) => a - b)
  
  // 复制页面
  const pages = await newPdf.copyPages(pdfDoc, allPageIndices)
  pages.forEach(page => newPdf.addPage(page))
  
  const pdfBytes = await newPdf.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  const baseName = file.name.replace('.pdf', '')
  const rangeStr = ranges.map(r => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join('_')
  
  return {
    blob,
    pageCount: newPdf.getPageCount(),
    fileName: `${baseName}_${rangeStr}.pdf`
  }
}

export const splitPdfToSinglePages = async (file: File): Promise<PdfProcessResult[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const pageCount = pdfDoc.getPageCount()
  const results: PdfProcessResult[] = []
  
  for (let i = 0; i < pageCount; i++) {
    const newPdf = await PDFDocument.create()
    const [page] = await newPdf.copyPages(pdfDoc, [i])
    newPdf.addPage(page)
    
    const pdfBytes = await newPdf.save()
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
    const baseName = file.name.replace('.pdf', '')
    results.push({
      blob,
      pageCount: 1,
      fileName: `${baseName}_page_${i + 1}.pdf`
    })
  }
  
  return results
}

export const compressPdf = async (file: File): Promise<PdfProcessResult> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer, {
    ignoreEncryption: true
  })
  
  const pdfBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  })
  
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  return {
    blob,
    pageCount: pdfDoc.getPageCount(),
    fileName: file.name.replace('.pdf', '_compressed.pdf')
  }
}

export const extractPages = async (
  file: File,
  pageNumbers: number[]
): Promise<PdfProcessResult> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const newPdf = await PDFDocument.create()
  
  const validIndices = pageNumbers
    .filter(n => n >= 1 && n <= pdfDoc.getPageCount())
    .map(n => n - 1)
  
  const pages = await newPdf.copyPages(pdfDoc, validIndices)
  pages.forEach(page => newPdf.addPage(page))
  
  const pdfBytes = await newPdf.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  const baseName = file.name.replace('.pdf', '')
  return {
    blob,
    pageCount: newPdf.getPageCount(),
    fileName: `${baseName}_extracted.pdf`
  }
}

export const rotatePages = async (
  file: File,
  angle: 0 | 90 | 180 | 270,
  pageNumbers?: number[]
): Promise<PdfProcessResult> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const pages = pdfDoc.getPages()
  
  const targetIndices = pageNumbers 
    ? pageNumbers.map(n => n - 1)
    : pages.map((_, i) => i)
  
  for (const idx of targetIndices) {
    if (idx >= 0 && idx < pages.length) {
      const currentRotation = pages[idx].getRotation().angle
      pages[idx].setRotation(degrees(currentRotation + angle))
    }
  }
  
  const pdfBytes = await pdfDoc.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  return {
    blob,
    pageCount: pdfDoc.getPageCount(),
    fileName: file.name.replace('.pdf', '_rotated.pdf')
  }
}

export const deletePages = async (
  file: File,
  pageNumbers: number[]
): Promise<PdfProcessResult> => {
  const arrayBuffer = await readFileAsArrayBuffer(file)
  const pdfDoc = await PDFDocument.load(arrayBuffer)
  const totalPages = pdfDoc.getPageCount()
  
  const pagesToKeep = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter(n => !pageNumbers.includes(n))
    .map(n => n - 1)
  
  const newPdf = await PDFDocument.create()
  const pages = await newPdf.copyPages(pdfDoc, pagesToKeep)
  pages.forEach(page => newPdf.addPage(page))
  
  const pdfBytes = await newPdf.save()
  const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
  
  return {
    blob,
    pageCount: newPdf.getPageCount(),
    fileName: file.name.replace('.pdf', '_edited.pdf')
  }
}
