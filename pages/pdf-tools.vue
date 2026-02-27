<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">PDF 工具箱</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">PDF 合并、拆分、压缩、加水印、格式转换等</p>
      </div>
    </div>

    <!-- 功能选择 -->
    <UCard>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <button
          v-for="tool in tools"
          :key="tool.id"
          class="flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all hover:shadow-md"
          :class="[
            activeTool === tool.id 
              ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' 
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
          ]"
          @click="activeTool = tool.id"
        >
          <div class="p-2 rounded-lg" :class="tool.bgColor">
            <UIcon :name="tool.icon" class="w-6 h-6" :class="tool.iconColor" />
          </div>
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ tool.name }}</span>
        </button>
      </div>
    </UCard>

    <!-- PDF 合并 -->
    <UCard v-if="activeTool === 'merge'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-document-duplicate" class="w-5 h-5 text-blue-500" />
          <span class="font-semibold">PDF 合并</span>
          <UBadge color="blue" variant="soft" size="xs">多个 PDF 合成一个</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <FileUpload
          accept=".pdf,application/pdf"
          accept-text="PDF 文件"
          icon="i-heroicons-document"
          @files="handleMergeFiles"
        />

        <div v-if="mergeFiles.length > 0" class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-500">拖拽调整顺序</span>
            <UButton size="xs" variant="ghost" color="red" @click="mergeFiles = []">清空</UButton>
          </div>
          
          <div class="space-y-2">
            <div
              v-for="(file, index) in mergeFiles"
              :key="file.name + index"
              draggable="true"
              class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg cursor-move hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              @dragstart="dragStart(index)"
              @dragover.prevent
              @drop="drop(index)"
            >
              <UIcon name="i-heroicons-bars-3" class="w-4 h-4 text-gray-400" />
              <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
              <div class="flex items-center justify-center w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900 text-primary-600 dark:text-primary-400 text-xs font-medium">
                {{ index + 1 }}
              </div>
              <span class="flex-1 text-sm truncate">{{ file.name }}</span>
              <UBadge color="gray" variant="soft" size="xs">{{ formatSize(file.size) }}</UBadge>
              <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="removeMergeFile(index)" />
            </div>
          </div>

          <!-- 合并预览 -->
          <div class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div class="flex items-start gap-2">
              <UIcon name="i-heroicons-eye" class="w-5 h-5 text-blue-500 mt-0.5" />
              <div class="flex-1 text-sm">
                <div class="font-medium text-blue-700 dark:text-blue-300 mb-1">预览</div>
                <div class="text-blue-600 dark:text-blue-400">
                  将按顺序合并 {{ mergeFiles.length }} 个 PDF 文件为 1 个文件
                </div>
                <div class="text-blue-500 dark:text-blue-500 text-xs mt-1">
                  合并顺序：{{ mergeFiles.map((f, i) => `${i + 1}. ${f.name}`).join(' → ') }}
                </div>
                <div class="text-blue-500 dark:text-blue-500 text-xs">
                  预计大小：约 {{ formatSize(mergeFilesTotalSize) }}
                </div>
              </div>
            </div>
          </div>

          <UButton 
            color="primary" 
            :loading="processing" 
            :disabled="mergeFiles.length < 2"
            @click="doMerge"
          >
            <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-1" />
            合并并下载 ({{ mergeFiles.length }} 个文件)
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- PDF 拆分 -->
    <UCard v-if="activeTool === 'split'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-scissors" class="w-5 h-5 text-purple-500" />
          <span class="font-semibold">PDF 拆分</span>
          <UBadge color="purple" variant="soft" size="xs">按页拆分 PDF</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <FileUpload
          accept=".pdf,application/pdf"
          accept-text="PDF 文件"
          icon="i-heroicons-document"
          :multiple="false"
          @files="handleSplitFile"
        />

        <div v-if="splitFile" class="space-y-4">
          <div class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
            <span class="flex-1 text-sm truncate">{{ splitFile.name }}</span>
            <UBadge color="gray" variant="soft">{{ splitPageCount }} 页</UBadge>
            <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="splitFile = null" />
          </div>

          <UFormGroup label="拆分方式">
            <URadioGroup v-model="splitMode" :options="splitModeOptions" />
          </UFormGroup>

          <div v-if="splitMode === 'range'" class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">页面范围</span>
              <UButton size="xs" variant="soft" @click="addSplitRange">
                <UIcon name="i-heroicons-plus" class="w-3 h-3 mr-1" />
                新增范围
              </UButton>
            </div>
            <div
              v-for="(range, index) in splitRanges"
              :key="`split-range-${index}`"
              class="p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/60 space-y-2"
            >
              <div class="flex items-center justify-between text-sm">
                <span>Range {{ index + 1 }}</span>
                <UButton
                  v-if="splitRanges.length > 1"
                  size="2xs"
                  color="red"
                  variant="ghost"
                  icon="i-heroicons-trash"
                  @click="removeSplitRange(index)"
                />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <UFormGroup label="from page">
                  <UInput v-model.number="range.start" type="number" :min="1" :max="splitPageCount || 1" />
                </UFormGroup>
                <UFormGroup label="to">
                  <UInput v-model.number="range.end" type="number" :min="1" :max="splitPageCount || 1" />
                </UFormGroup>
              </div>
            </div>
          </div>

          <UFormGroup v-if="splitMode === 'range'" label="输出方式">
            <URadioGroup v-model="splitOutputMode" :options="splitOutputOptions" />
          </UFormGroup>

          <!-- 拆分预览 -->
          <div v-if="splitMode === 'range' && parsedRangesCount > 0" class="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
            <div class="flex items-start gap-2">
              <UIcon name="i-heroicons-eye" class="w-5 h-5 text-purple-500 mt-0.5" />
              <div class="flex-1 text-sm">
                <div class="font-medium text-purple-700 dark:text-purple-300 mb-1">预览</div>
                <div v-if="splitOutputMode === 'merge'" class="text-purple-600 dark:text-purple-400">
                  将提取 <span class="font-medium">{{ parsedRangesPreview }}</span>，合并为 1 个 PDF 文件
                </div>
                <div v-else class="text-purple-600 dark:text-purple-400">
                  将拆分为 <span class="font-medium">{{ parsedRangesCount }}</span> 个独立 PDF 文件
                  <div class="text-purple-500 text-xs mt-1">
                    {{ parsedRangesPreview }}，每个范围单独保存
                  </div>
                </div>
                <!-- 超出范围警告 -->
                <div v-if="hasInvalidRanges" class="mt-2 text-yellow-600 dark:text-yellow-400 text-xs flex items-center gap-1">
                  <UIcon name="i-heroicons-exclamation-triangle" class="w-4 h-4" />
                  {{ invalidRangesMessage }}
                </div>
              </div>
            </div>
          </div>
          
          <!-- 每页拆分预览 -->
          <div v-if="splitMode === 'single'" class="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
            <div class="flex items-start gap-2">
              <UIcon name="i-heroicons-eye" class="w-5 h-5 text-purple-500 mt-0.5" />
              <div class="flex-1 text-sm">
                <div class="font-medium text-purple-700 dark:text-purple-300 mb-1">预览</div>
                <div class="text-purple-600 dark:text-purple-400">
                  将拆分为 <span class="font-medium">{{ splitPageCount }}</span> 个独立 PDF 文件，每页一个文件
                </div>
              </div>
            </div>
          </div>

          <UButton 
            color="primary" 
            :loading="processing"
            @click="doSplit"
          >
            <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-1" />
            拆分并下载
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- PDF 压缩（跳转 iLovePDF） -->
    <UCard v-if="activeTool === 'compress'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-down-on-square-stack" class="w-5 h-5 text-green-500" />
          <span class="font-semibold">PDF 压缩（在线）</span>
          <UBadge color="green" variant="soft" size="xs">减小文件大小</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <UAlert
          color="blue"
          variant="soft"
          icon="i-heroicons-link"
          title="使用 iLovePDF 压缩"
          description="压缩改为使用更稳定的在线方案，不再走本地压缩。"
        />
        <UButton color="primary" @click="openExternal('https://www.ilovepdf.com/compress_pdf')">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-4 h-4 mr-1" />
          打开 iLovePDF 压缩
        </UButton>
      </div>
    </UCard>

    <!-- PDF 加水印（跳转 iLovePDF） -->
    <UCard v-if="activeTool === 'watermark'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-paint-brush" class="w-5 h-5 text-cyan-500" />
          <span class="font-semibold">PDF 签名/水印（在线）</span>
          <UBadge color="cyan" variant="soft" size="xs">iLovePDF Sign</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <UAlert
          color="cyan"
          variant="soft"
          icon="i-heroicons-link"
          title="使用 iLovePDF Sign"
          description="加水印/签名改为在线方案，兼容性更好。"
        />
        <UButton color="primary" @click="openExternal('https://www.ilovepdf.com/sign-pdf')">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-4 h-4 mr-1" />
          打开 iLovePDF Sign
        </UButton>
      </div>
    </UCard>

    <!-- PDF 转 Word（在线） -->
    <UCard v-if="activeTool === 'pdf2word-online'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-5 h-5 text-red-500" />
          <span class="font-semibold">PDF 转 Word（在线）</span>
        </div>
      </template>
      <div class="space-y-4">
        <UAlert
          color="red"
          variant="soft"
          icon="i-heroicons-information-circle"
          title="跳转 iLovePDF"
          description="使用 iLovePDF 的在线转换能力，支持更完整格式。"
        />
        <UButton color="primary" @click="openExternal('https://www.ilovepdf.com/pdf_to_word')">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-4 h-4 mr-1" />
          打开 PDF 转 Word
        </UButton>
      </div>
    </UCard>

    <!-- Word 转 PDF（在线） -->
    <UCard v-if="activeTool === 'word2pdf-online'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-5 h-5 text-blue-500" />
          <span class="font-semibold">Word 转 PDF（在线）</span>
        </div>
      </template>
      <div class="space-y-4">
        <UAlert
          color="blue"
          variant="soft"
          icon="i-heroicons-information-circle"
          title="跳转 iLovePDF"
          description="使用 iLovePDF 在线转换，稳定性高于浏览器端本地转换。"
        />
        <UButton color="primary" @click="openExternal('https://www.ilovepdf.com/word_to_pdf')">
          <UIcon name="i-heroicons-arrow-top-right-on-square" class="w-4 h-4 mr-1" />
          打开 Word 转 PDF
        </UButton>
      </div>
    </UCard>

    <!-- 图片转 PDF -->
    <UCard v-if="activeTool === 'img2pdf'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-photo" class="w-5 h-5 text-orange-500" />
          <span class="font-semibold">图片转 PDF</span>
          <UBadge color="orange" variant="soft" size="xs">多张图片合成 PDF</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <FileUpload
          accept="image/*"
          accept-text="图片文件 (PNG, JPG, WebP)"
          icon="i-heroicons-photo"
          @files="handleImageFiles"
        />

        <div v-if="imageFiles.length > 0" class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-500">拖拽调整顺序</span>
            <UButton size="xs" variant="ghost" color="red" @click="imageFiles = []">清空</UButton>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <div
              v-for="(file, index) in imageFiles"
              :key="file.name + index"
              draggable="true"
              class="relative aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 cursor-move group"
              @dragstart="imgDragStart(index)"
              @dragover.prevent
              @drop="imgDrop(index)"
            >
              <img :src="getImagePreview(file)" class="w-full h-full object-cover" />
              <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <UButton size="xs" color="red" variant="solid" icon="i-heroicons-x-mark" @click="imageFiles.splice(index, 1)" />
              </div>
              <div class="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 text-white text-xs rounded">
                {{ index + 1 }}
              </div>
            </div>
          </div>

          <UButton 
            color="primary" 
            :loading="processing"
            @click="doImagesToPdf"
          >
            <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-1" />
            生成 PDF ({{ imageFiles.length }} 张图片)
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import JSZip from 'jszip'
import type { PdfProcessResult } from '~/composables/usePdfProcessor'

const { 
  mergePdfs, 
  splitPdf,
  splitAndMergePdf,
  splitPdfToSinglePages,
  imagesToPdf,
  getPdfPageCount 
} = usePdfProcessor()

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

// ========== 通用 ==========
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

// ========== PDF 合并 ==========
const mergeFiles = ref<File[]>([])
let dragIndex = -1

// 合并文件总大小
const mergeFilesTotalSize = computed(() => {
  return mergeFiles.value.reduce((sum, f) => sum + f.size, 0)
})

const handleMergeFiles = (files: File[]) => {
  mergeFiles.value.push(...files.filter(f => f.type === 'application/pdf'))
}

const removeMergeFile = (index: number) => {
  mergeFiles.value.splice(index, 1)
}

const dragStart = (index: number) => {
  dragIndex = index
}

const drop = (index: number) => {
  if (dragIndex === -1 || dragIndex === index) return
  const item = mergeFiles.value.splice(dragIndex, 1)[0]
  mergeFiles.value.splice(index, 0, item)
  dragIndex = -1
}

const doMerge = async () => {
  if (mergeFiles.value.length < 2) return
  processing.value = true
  try {
    const result = await mergePdfs(mergeFiles.value)
    downloadResult(result)
  } catch (e) {
    console.error(e)
  } finally {
    processing.value = false
  }
}

// ========== PDF 拆分 ==========
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
        // 多个文件打包下载
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
          // 多个文件打包下载
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

// ========== 图片转 PDF ==========
const imageFiles = ref<File[]>([])
const imagePreviews = new Map<File, string>()
let imgDragIndex = -1

const handleImageFiles = (files: File[]) => {
  const imgs = files.filter(f => f.type.startsWith('image/'))
  imageFiles.value.push(...imgs)
}

const getImagePreview = (file: File): string => {
  if (imagePreviews.has(file)) {
    return imagePreviews.get(file)!
  }
  const url = URL.createObjectURL(file)
  imagePreviews.set(file, url)
  return url
}

const imgDragStart = (index: number) => {
  imgDragIndex = index
}

const imgDrop = (index: number) => {
  if (imgDragIndex === -1 || imgDragIndex === index) return
  const item = imageFiles.value.splice(imgDragIndex, 1)[0]
  imageFiles.value.splice(index, 0, item)
  imgDragIndex = -1
}

const doImagesToPdf = async () => {
  if (imageFiles.value.length === 0) return
  processing.value = true
  
  try {
    const result = await imagesToPdf(imageFiles.value)
    downloadResult(result)
  } catch (e) {
    console.error(e)
  } finally {
    processing.value = false
  }
}

// 清理
onUnmounted(() => {
  imagePreviews.forEach(url => URL.revokeObjectURL(url))
  imagePreviews.clear()
})
</script>
