import { PDFDocument } from 'pdf-lib'
import { readFileAsArrayBuffer } from './pdfIo'
import type { PdfProcessResult } from './pdfIo'

export const wordToPdf = async (file: File): Promise<PdfProcessResult> => {
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

export const pdfToWord = async (file: File): Promise<Blob> => {
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

export const imagesToPdf = async (files: File[]): Promise<PdfProcessResult> => {
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
