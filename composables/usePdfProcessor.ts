import { PDFDocument, rgb, degrees } from 'pdf-lib'

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
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
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
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
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

  // PDF 压缩
  const compressPdf = async (file: File): Promise<PdfProcessResult> => {
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

  // 解析颜色字符串为 RGB
  const parseColor = (colorStr: string): { r: number; g: number; b: number } => {
    if (colorStr.startsWith('#')) {
      const hex = colorStr.slice(1)
      const r = parseInt(hex.slice(0, 2), 16) / 255
      const g = parseInt(hex.slice(2, 4), 16) / 255
      const b = parseInt(hex.slice(4, 6), 16) / 255
      return { r, g, b }
    }
    return { r: 0.5, g: 0.5, b: 0.5 }
  }

  // 创建水印图片（支持中文）
  const createWatermarkImage = (
    text: string,
    fontSize: number,
    color: string,
    opacity: number,
    rotation: number
  ): { dataUrl: string; width: number; height: number } => {
    const radians = (rotation * Math.PI) / 180
    const padding = 20
    
    // 测量文字大小
    const tempCanvas = document.createElement('canvas')
    const tempCtx = tempCanvas.getContext('2d')!
    tempCtx.font = `${fontSize}px "Microsoft YaHei", "SimHei", "Heiti SC", sans-serif`
    const metrics = tempCtx.measureText(text)
    const textWidth = metrics.width
    const textHeight = fontSize
    
    // 计算旋转后需要的画布大小
    const absRotation = Math.abs(radians)
    const canvasWidth = Math.ceil(textWidth * Math.cos(absRotation) + textHeight * Math.sin(absRotation)) + padding * 2
    const canvasHeight = Math.ceil(textWidth * Math.sin(absRotation) + textHeight * Math.cos(absRotation)) + padding * 2
    
    const canvas = document.createElement('canvas')
    canvas.width = canvasWidth
    canvas.height = canvasHeight
    const ctx = canvas.getContext('2d')!
    
    // 移动到中心并旋转
    ctx.translate(canvasWidth / 2, canvasHeight / 2)
    ctx.rotate(radians)
    
    // 设置文字样式
    ctx.font = `${fontSize}px "Microsoft YaHei", "SimHei", "Heiti SC", sans-serif`
    ctx.fillStyle = color
    ctx.globalAlpha = opacity
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    
    ctx.fillText(text, 0, 0)
    
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvasWidth,
      height: canvasHeight
    }
  }

  // PDF 加水印（支持中文）
  const addWatermark = async (
    file: File, 
    options: WatermarkOptions
  ): Promise<PdfProcessResult> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    
    // 根据位置创建水印图片
    const rotation = options.position === 'diagonal' ? -45 : options.rotation
    const watermarkImg = createWatermarkImage(
      options.text,
      options.fontSize,
      options.color,
      options.opacity,
      rotation
    )
    
    // 将 dataUrl 转换为 PNG 嵌入
    const watermarkImageBytes = await fetch(watermarkImg.dataUrl).then(res => res.arrayBuffer())
    const watermarkPdfImage = await pdfDoc.embedPng(watermarkImageBytes)
    
    const pages = pdfDoc.getPages()
    
    for (const page of pages) {
      const { width, height } = page.getSize()
      
      if (options.position === 'tile') {
        // 平铺水印
        const spacingX = watermarkImg.width + 80
        const spacingY = watermarkImg.height + 80
        
        for (let y = spacingY / 2; y < height; y += spacingY) {
          for (let x = spacingX / 2; x < width; x += spacingX) {
            page.drawImage(watermarkPdfImage, {
              x: x - watermarkImg.width / 2,
              y: y - watermarkImg.height / 2,
              width: watermarkImg.width,
              height: watermarkImg.height,
            })
          }
        }
      } else {
        // 居中或对角线水印
        page.drawImage(watermarkPdfImage, {
          x: (width - watermarkImg.width) / 2,
          y: (height - watermarkImg.height) / 2,
          width: watermarkImg.width,
          height: watermarkImg.height,
        })
      }
    }
    
    const pdfBytes = await pdfDoc.save()
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_watermarked.pdf')
    }
  }

  // PDF 去水印（通过覆盖白色区域）
  const removeWatermark = async (
    file: File,
    options: {
      position: 'top' | 'bottom' | 'center' | 'corners' | 'full'
      coverage: number // 0-100 覆盖范围百分比
    }
  ): Promise<PdfProcessResult> => {
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const pdfDoc = await PDFDocument.load(arrayBuffer)
    const pages = pdfDoc.getPages()
    
    for (const page of pages) {
      const { width, height } = page.getSize()
      const coverage = options.coverage / 100
      
      // 根据位置绘制白色覆盖层
      if (options.position === 'top') {
        const coverHeight = height * coverage * 0.3
        page.drawRectangle({
          x: 0,
          y: height - coverHeight,
          width: width,
          height: coverHeight,
          color: rgb(1, 1, 1),
        })
      } else if (options.position === 'bottom') {
        const coverHeight = height * coverage * 0.3
        page.drawRectangle({
          x: 0,
          y: 0,
          width: width,
          height: coverHeight,
          color: rgb(1, 1, 1),
        })
      } else if (options.position === 'center') {
        const coverWidth = width * coverage * 0.5
        const coverHeight = height * coverage * 0.3
        page.drawRectangle({
          x: (width - coverWidth) / 2,
          y: (height - coverHeight) / 2,
          width: coverWidth,
          height: coverHeight,
          color: rgb(1, 1, 1),
        })
      } else if (options.position === 'corners') {
        const cornerSize = Math.min(width, height) * coverage * 0.15
        // 四个角
        page.drawRectangle({ x: 0, y: height - cornerSize, width: cornerSize, height: cornerSize, color: rgb(1, 1, 1) })
        page.drawRectangle({ x: width - cornerSize, y: height - cornerSize, width: cornerSize, height: cornerSize, color: rgb(1, 1, 1) })
        page.drawRectangle({ x: 0, y: 0, width: cornerSize, height: cornerSize, color: rgb(1, 1, 1) })
        page.drawRectangle({ x: width - cornerSize, y: 0, width: cornerSize, height: cornerSize, color: rgb(1, 1, 1) })
      } else if (options.position === 'full') {
        // 全页半透明白色覆盖（降低水印可见度）
        page.drawRectangle({
          x: 0,
          y: 0,
          width: width,
          height: height,
          color: rgb(1, 1, 1),
          opacity: coverage * 0.5,
        })
      }
    }
    
    const pdfBytes = await pdfDoc.save()
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_no_watermark.pdf')
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
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
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
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
    return {
      blob,
      pageCount: pdfDoc.getPageCount(),
      fileName: file.name.replace('.pdf', '_rotated.pdf')
    }
  }

  // Word 转 PDF（使用 mammoth 提取 HTML + Canvas 渲染）
  const wordToPdf = async (file: File): Promise<PdfProcessResult> => {
    const mammoth = await import('mammoth')
    
    const arrayBuffer = await readFileAsArrayBuffer(file)
    const result = await mammoth.convertToHtml({ arrayBuffer })
    const html = result.value
    
    // 创建临时元素渲染 HTML
    const container = document.createElement('div')
    container.innerHTML = html
    container.style.cssText = `
      position: fixed;
      left: -9999px;
      top: 0;
      width: 550px;
      padding: 40px;
      font-family: "Microsoft YaHei", "SimHei", "PingFang SC", sans-serif;
      font-size: 14px;
      line-height: 1.8;
      background: white;
      color: black;
    `
    document.body.appendChild(container)
    
    // 等待渲染
    await new Promise(resolve => setTimeout(resolve, 100))
    
    const pdfDoc = await PDFDocument.create()
    const pageWidth = 595
    const pageHeight = 842
    const margin = 50
    const contentWidth = pageWidth - margin * 2
    const fontSize = 12
    const lineHeight = fontSize * 1.8
    
    // 获取文本内容
    const text = container.innerText || ''
    document.body.removeChild(container)
    
    if (!text.trim()) {
      // 空文档
      pdfDoc.addPage([pageWidth, pageHeight])
      const pdfBytes = await pdfDoc.save()
      const baseName = file.name.replace(/\.(docx?|doc)$/i, '')
      return {
        blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
        pageCount: 1,
        fileName: `${baseName}.pdf`
      }
    }
    
    // 分割文本为行
    const allLines: string[] = []
    const paragraphs = text.split('\n')
    
    for (const para of paragraphs) {
      if (!para.trim()) {
        allLines.push('')
        continue
      }
      
      // 按字符宽度分行
      const charsPerLine = Math.floor(contentWidth / (fontSize * 0.55))
      let remaining = para
      
      while (remaining.length > 0) {
        if (remaining.length <= charsPerLine) {
          allLines.push(remaining)
          break
        }
        allLines.push(remaining.slice(0, charsPerLine))
        remaining = remaining.slice(charsPerLine)
      }
    }
    
    // 每页行数
    const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight)
    
    // 分页渲染
    for (let pageStart = 0; pageStart < allLines.length; pageStart += linesPerPage) {
      const pageLines = allLines.slice(pageStart, pageStart + linesPerPage)
      
      // 创建 Canvas 渲染文字
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = pageWidth * scale
      canvas.height = pageHeight * scale
      const ctx = canvas.getContext('2d')!
      
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      
      ctx.scale(scale, scale)
      ctx.fillStyle = 'black'
      ctx.font = `${fontSize}px "Microsoft YaHei", "SimHei", sans-serif`
      ctx.textBaseline = 'top'
      
      let y = margin
      for (const line of pageLines) {
        if (line) {
          ctx.fillText(line, margin, y)
        }
        y += lineHeight
      }
      
      // 嵌入图片到 PDF
      const imgData = canvas.toDataURL('image/png')
      const imgBytes = await fetch(imgData).then(r => r.arrayBuffer())
      const img = await pdfDoc.embedPng(imgBytes)
      
      const page = pdfDoc.addPage([pageWidth, pageHeight])
      page.drawImage(img, { x: 0, y: 0, width: pageWidth, height: pageHeight })
    }
    
    if (pdfDoc.getPageCount() === 0) {
      pdfDoc.addPage([pageWidth, pageHeight])
    }
    
    const pdfBytes = await pdfDoc.save()
    const baseName = file.name.replace(/\.(docx?|doc)$/i, '')
    
    return {
      blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
      pageCount: pdfDoc.getPageCount(),
      fileName: `${baseName}.pdf`
    }
  }

  // PDF 转 Word (提取文本) - 使用 pdf.js 配置 worker
  const pdfToWord = async (file: File): Promise<Blob> => {
    const pdfjsLib = await import('pdfjs-dist')
    
    // 使用 CDN worker，指定兼容版本
    const version = pdfjsLib.version
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`
    
    const arrayBuffer = await readFileAsArrayBuffer(file)
    
    let fullText = ''
    
    try {
      const pdf = await pdfjsLib.getDocument({ 
        data: arrayBuffer,
      }).promise
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const textContent = await page.getTextContent()
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(' ')
        fullText += pageText + '\n\n'
      }
    } catch (e) {
      console.error('PDF 解析失败:', e)
      // 如果 PDF 解析失败，返回空文档
      fullText = '(PDF 文本提取失败，请尝试其他方式)'
    }
    
    // 创建 DOCX 文件
    const { Document, Packer, Paragraph, TextRun } = await import('docx')
    
    const paragraphs = fullText.split('\n\n').filter(p => p.trim()).map(text => 
      new Paragraph({
        children: [new TextRun(text)]
      })
    )
    
    if (paragraphs.length === 0) {
      paragraphs.push(new Paragraph({
        children: [new TextRun('(文档内容为空或无法提取)')]
      }))
    }
    
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
        // 其他格式转换为 PNG
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
    const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
    
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

  return {
    getPdfPageCount,
    mergePdfs,
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
    readFileAsArrayBuffer
  }
}
