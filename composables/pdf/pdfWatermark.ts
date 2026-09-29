import { PDFDocument, rgb } from 'pdf-lib'
import { readFileAsArrayBuffer } from './pdfIo'
import type { PdfProcessResult, WatermarkOptions } from './pdfIo'

export const createWatermarkImage = (
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

export const addWatermark = async (
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

export const removeWatermark = async (
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
