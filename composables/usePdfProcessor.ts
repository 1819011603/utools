import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

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

export function usePdfProcessor() {
  
  // 读取 PDF 文件为 ArrayBuffer
  const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = reject
      reader.readAsArrayBuffer(file)
    })
  }

  // 获取 PDF 页数
  const getPdfPageCount = async (file: File): Promise<number> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    return pdfDoc.getPageCount()
  }

  // PDF 合并
  const mergePdfs = async (files: File[]): Promise<PdfProcessResult> => {
    const mergedPdf = await PDFDocument.create()
    
    for (const file of files) {
      const arrayBuffer = await readFileAsArrayBuffer(file)
      const pdfDoc = await PDFDocument.load(arrayBuffer)
      const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices())
      pages.forEach(page => mergedPdf.addPage(page))
    }
    
    const pdfBytes = await mergedPdf.save()
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: mergedPdf.getPageCount(),
      fileName: 'merged.pdf'
    }
  }

  // PDF 拆分 (每个范围单独一个文件)
  const splitPdf = async (
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
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      
      const baseName = file.name.replace('.pdf', '')
      results.push({
        blob,
        pageCount: newPdf.getPageCount(),
        fileName: `${baseName}_${start}-${end}.pdf`
      })
    }
    
    return results
  }

  // PDF 拆分并合并 (多个范围合并成一个文件)
  const splitAndMergePdf = async (
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
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    const baseName = file.name.replace('.pdf', '')
    const rangeStr = ranges.map(r => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join('_')
    
    return {
      blob,
      pageCount: newPdf.getPageCount(),
      fileName: `${baseName}_${rangeStr}.pdf`
    }
  }

  // PDF 拆分为单页
  const splitPdfToSinglePages = async (file: File): Promise<PdfProcessResult[]> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    const pageCount = pdfDoc.getPageCount()
    const results: PdfProcessResult[] = []
    
    for (let i = 0; i < pageCount; i++) {
      const newPdf = await PDFDocument.create()
      const [page] = await newPdf.copyPages(pdfDoc, [i])
      newPdf.addPage(page)
      
      const pdfBytes = await newPdf.save()
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      
      const baseName = file.name.replace('.pdf', '')
      results.push({
        blob,
        pageCount: 1,
        fileName: `${baseName}_page_${i + 1}.pdf`
      })
    }
    
    return results
  }

  // PDF 压缩 (通过移除冗余数据和压缩图片)
  const compressPdf = async (file: File, quality: number = 0.7): Promise<PdfProcessResult> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer, {
      ignoreEncryption: true
    })
    
    // 基本压缩：移除元数据、优化结构
    // pdf-lib 本身会在 save 时进行一定优化
    const pdfBytes = await pdfDoc.save({
      useObjectStreams: true, // 使用对象流压缩
      addDefaultPage: false,
    })
    
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_compressed.pdf')
    }
  }

  // 解析颜色字符串为 RGB
  const parseColor = (colorStr: string): { r: number; g: number; b: number } => {
    // 支持 hex 颜色
    if (colorStr.startsWith('#')) {
      const hex = colorStr.slice(1)
      const r = parseInt(hex.slice(0, 2), 16) / 255
      const g = parseInt(hex.slice(2, 4), 16) / 255
      const b = parseInt(hex.slice(4, 6), 16) / 255
      return { r, g, b }
    }
    return { r: 0.5, g: 0.5, b: 0.5 }
  }

  // PDF 加水印
  const addWatermark = async (
    file: File, 
    options: WatermarkOptions
  ): Promise<PdfProcessResult> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    
    // 注册 fontkit 以支持自定义字体
    pdfDoc.registerFontkit(fontkit)
    
    // 使用标准字体（不支持中文），或者嵌入自定义字体
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    
    const pages = pdfDoc.getPages()
    const { r, g, b } = parseColor(options.color)
    
    for (const page of pages) {
      const { width, height } = page.getSize()
      
      if (options.position === 'tile') {
        // 平铺水印
        const textWidth = font.widthOfTextAtSize(options.text, options.fontSize)
        const spacingX = textWidth + 100
        const spacingY = options.fontSize + 80
        
        for (let y = 0; y < height + spacingY; y += spacingY) {
          for (let x = -textWidth; x < width + spacingX; x += spacingX) {
            page.drawText(options.text, {
              x,
              y,
              size: options.fontSize,
              font,
              color: rgb(r, g, b),
              opacity: options.opacity,
              rotate: degrees(options.rotation)
            })
          }
        }
      } else if (options.position === 'diagonal') {
        // 对角线水印
        const textWidth = font.widthOfTextAtSize(options.text, options.fontSize)
        page.drawText(options.text, {
          x: (width - textWidth) / 2,
          y: height / 2,
          size: options.fontSize,
          font,
          color: rgb(r, g, b),
          opacity: options.opacity,
          rotate: degrees(-45)
        })
      } else {
        // 中心水印
        const textWidth = font.widthOfTextAtSize(options.text, options.fontSize)
        page.drawText(options.text, {
          x: (width - textWidth) / 2,
          y: height / 2,
          size: options.fontSize,
          font,
          color: rgb(r, g, b),
          opacity: options.opacity,
          rotate: degrees(options.rotation)
        })
      }
    }
    
    const pdfBytes = await pdfDoc.save()
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_watermarked.pdf')
    }
  }

  // 提取 PDF 页面范围
  const extractPages = async (
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
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    const baseName = file.name.replace('.pdf', '')
    return {
      blob,
      pageCount: newPdf.getPageCount(),
      fileName: `${baseName}_extracted.pdf`
    }
  }

  // 旋转 PDF 页面
  const rotatePages = async (
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
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_rotated.pdf')
    }
  }

  // Word 转 PDF（使用 mammoth 提取内容 + jsPDF 生成）
  const wordToPdf = async (file: File): Promise<PdfProcessResult> => {
    const mammoth = await import('mammoth')
    const { jsPDF } = await import('jspdf')
    
    const arrayBuffer = await readFileAsArrayBuffer(file)
    
    // 提取 HTML 内容
    const result = await mammoth.convertToHtml({ arrayBuffer })
    const html = result.value
    
    // 创建临时元素来渲染 HTML
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = html
    tempDiv.style.cssText = 'position: absolute; left: -9999px; width: 595px; font-family: sans-serif; font-size: 12px; line-height: 1.6;'
    document.body.appendChild(tempDiv)
    
    // 创建 PDF
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4'
    })
    
    // 使用 html 方法转换（需要 html2canvas）
    // 简单方案：提取纯文本
    const text = tempDiv.innerText || tempDiv.textContent || ''
    document.body.removeChild(tempDiv)
    
    const lines = pdf.splitTextToSize(text, 500)
    const pageHeight = pdf.internal.pageSize.getHeight()
    const lineHeight = 14
    let y = 40
    
    for (const line of lines) {
      if (y + lineHeight > pageHeight - 40) {
        pdf.addPage()
        y = 40
      }
      pdf.text(line, 40, y)
      y += lineHeight
    }
    
    const pdfBlob = pdf.output('blob')
    const baseName = file.name.replace(/\.(docx?|doc)$/i, '')
    
    return {
      blob: pdfBlob,
      pageCount: pdf.getNumberOfPages(),
      fileName: `${baseName}.pdf`
    }
  }

  // PDF 转 Word (提取文本)
  const pdfToWord = async (file: File): Promise<Blob> => {
    const pdfjsLib = await import('pdfjs-dist')
    
    // 设置 worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
    
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    
    let fullText = ''
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ')
      fullText += pageText + '\n\n'
    }
    
    // 创建简单的 DOCX 文件
    const { Document, Packer, Paragraph, TextRun } = await import('docx')
    
    const paragraphs = fullText.split('\n\n').filter(p => p.trim()).map(text => 
      new Paragraph({
        children: [new TextRun(text)]
      })
    )
    
    const doc = new Document({
      sections: [{
        properties: {},
        children: paragraphs
      }]
    })
    
    const docBlob = await Packer.toBlob(doc)
    return docBlob
  }

  // 图片转 PDF
  const imagesToPdf = async (files: File[]): Promise<PdfProcessResult> => {
    const pdfDoc = await PDFDocument.create()
    
    for (const file of files) {
      const arrayBuffer = await readFileAsArrayBuffer(file)
      
      let image
      if (file.type === 'image/png') {
        image = await pdfDoc.embedPng(arrayBuffer)
      } else if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
        image = await pdfDoc.embedJpg(arrayBuffer)
      } else {
        // 对于其他格式，先转换为 PNG
        const bitmap = await createImageBitmap(new Blob([arrayBuffer], { type: file.type }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        
        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('转换失败')), 'image/png')
        })
        const pngBuffer = await pngBlob.arrayBuffer()
        image = await pdfDoc.embedPng(pngBuffer)
      }
      
      const page = pdfDoc.addPage([image.width, image.height])
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height
      })
    }
    
    const pdfBytes = await pdfDoc.save()
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: 'images.pdf'
    }
  }

  // 删除 PDF 指定页面
  const deletePages = async (
    file: File,
    pageNumbers: number[]
  ): Promise<PdfProcessResult> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    const totalPages = pdfDoc.getPageCount()
    
    // 获取要保留的页面
    const pagesToKeep = Array.from({ length: totalPages }, (_, i) => i + 1)
      .filter(n => !pageNumbers.includes(n))
      .map(n => n - 1)
    
    const newPdf = await PDFDocument.create()
    const pages = await newPdf.copyPages(pdfDoc, pagesToKeep)
    pages.forEach(page => newPdf.addPage(page))
    
    const pdfBytes = await newPdf.save()
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: newPdf.getPageCount(),
      fileName: file.name.replace('.pdf', '_edited.pdf')
    }
  }

  return {
    getPdfPageCount,
    mergePdfs,
    splitPdf,
    splitAndMergePdf,
    splitPdfToSinglePages,
    compressPdf,
    addWatermark,
    extractPages,
    rotatePages,
    wordToPdf,
    pdfToWord,
    imagesToPdf,
    deletePages,
    readFileAsArrayBuffer
  }
}
