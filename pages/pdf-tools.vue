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
              <span class="flex-1 text-sm truncate">{{ file.name }}</span>
              <UBadge color="gray" variant="soft" size="xs">{{ formatSize(file.size) }}</UBadge>
              <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="removeMergeFile(index)" />
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

          <UFormGroup v-if="splitMode === 'range'" label="页面范围" hint="支持中英文逗号/分号分隔，如：1-30, 60-90">
            <UInput v-model="splitRangeInput" placeholder="1-30, 60-90 或 1-30；60-90" />
          </UFormGroup>

          <UFormGroup v-if="splitMode === 'range'" label="输出方式">
            <URadioGroup v-model="splitOutputMode" :options="splitOutputOptions" />
          </UFormGroup>

          <div v-if="splitMode === 'range' && splitRangeInput" class="text-sm text-gray-500 dark:text-gray-400">
            <span>预览：</span>
            <span v-if="splitOutputMode === 'merge'">
              将提取 {{ parsedRangesPreview }} 合并为 1 个 PDF 文件
            </span>
            <span v-else>
              将拆分为 {{ parsedRangesCount }} 个独立 PDF 文件
            </span>
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

    <!-- PDF 压缩 -->
    <UCard v-if="activeTool === 'compress'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-arrow-down-on-square-stack" class="w-5 h-5 text-green-500" />
          <span class="font-semibold">PDF 压缩</span>
          <UBadge color="green" variant="soft" size="xs">减小文件大小</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <FileUpload
          accept=".pdf,application/pdf"
          accept-text="PDF 文件"
          icon="i-heroicons-document"
          @files="handleCompressFiles"
        />

        <div v-if="compressFiles.length > 0" class="space-y-3">
          <div 
            v-for="(item, index) in compressFiles" 
            :key="item.file.name + index"
            class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
            <div class="flex-1 min-w-0">
              <p class="text-sm truncate">{{ item.file.name }}</p>
              <div class="flex items-center gap-2 text-xs text-gray-500">
                <span>原始: {{ formatSize(item.file.size) }}</span>
                <template v-if="item.result">
                  <UIcon name="i-heroicons-arrow-right" class="w-3 h-3" />
                  <span :class="item.result.blob.size < item.file.size ? 'text-green-500' : 'text-gray-500'">
                    压缩后: {{ formatSize(item.result.blob.size) }}
                    <span v-if="item.result.blob.size < item.file.size">
                      (-{{ Math.round((1 - item.result.blob.size / item.file.size) * 100) }}%)
                    </span>
                  </span>
                </template>
              </div>
            </div>
            <template v-if="item.status === 'completed'">
              <UBadge color="green" variant="soft">完成</UBadge>
              <UButton size="xs" @click="downloadResult(item.result!)">下载</UButton>
            </template>
            <template v-else-if="item.status === 'processing'">
              <UBadge color="yellow" variant="soft">压缩中...</UBadge>
            </template>
            <template v-else>
              <UBadge color="gray" variant="soft">等待中</UBadge>
            </template>
            <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="compressFiles.splice(index, 1)" />
          </div>

          <div class="flex gap-3">
            <UButton 
              color="primary" 
              :loading="processing"
              :disabled="compressFiles.every(f => f.status === 'completed')"
              @click="doCompress"
            >
              <UIcon name="i-heroicons-bolt" class="w-4 h-4 mr-1" />
              开始压缩
            </UButton>
            <UButton 
              v-if="compressFiles.some(f => f.status === 'completed')"
              variant="outline"
              @click="downloadAllCompressed"
            >
              <UIcon name="i-heroicons-archive-box-arrow-down" class="w-4 h-4 mr-1" />
              打包下载
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- PDF 加水印 -->
    <UCard v-if="activeTool === 'watermark'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-paint-brush" class="w-5 h-5 text-cyan-500" />
          <span class="font-semibold">PDF 加水印</span>
          <UBadge color="cyan" variant="soft" size="xs">添加文字水印</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <FileUpload
          accept=".pdf,application/pdf"
          accept-text="PDF 文件"
          icon="i-heroicons-document"
          :multiple="false"
          @files="handleWatermarkFile"
        />

        <div v-if="watermarkFile" class="space-y-4">
          <div class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
            <span class="flex-1 text-sm truncate">{{ watermarkFile.name }}</span>
            <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="watermarkFile = null" />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <UFormGroup label="水印文字">
              <UInput v-model="watermarkOptions.text" placeholder="请输入水印文字 (仅支持英文)" />
            </UFormGroup>

            <UFormGroup label="字体大小">
              <div class="flex items-center gap-3">
                <URange v-model="watermarkOptions.fontSize" :min="12" :max="72" class="flex-1" />
                <UBadge variant="soft" class="w-12 justify-center">{{ watermarkOptions.fontSize }}</UBadge>
              </div>
            </UFormGroup>

            <UFormGroup label="透明度">
              <div class="flex items-center gap-3">
                <URange v-model="watermarkOpacityPercent" :min="5" :max="100" class="flex-1" />
                <UBadge variant="soft" class="w-12 justify-center">{{ watermarkOpacityPercent }}%</UBadge>
              </div>
            </UFormGroup>

            <UFormGroup label="水印颜色">
              <div class="flex items-center gap-2">
                <input type="color" v-model="watermarkOptions.color" class="w-10 h-10 rounded cursor-pointer" />
                <UInput v-model="watermarkOptions.color" class="flex-1" />
              </div>
            </UFormGroup>

            <UFormGroup label="旋转角度">
              <div class="flex items-center gap-3">
                <URange v-model="watermarkOptions.rotation" :min="-90" :max="90" class="flex-1" />
                <UBadge variant="soft" class="w-12 justify-center">{{ watermarkOptions.rotation }}°</UBadge>
              </div>
            </UFormGroup>

            <UFormGroup label="水印位置">
              <USelectMenu 
                v-model="watermarkOptions.position" 
                :options="watermarkPositionOptions"
                value-attribute="value"
                option-attribute="label"
              />
            </UFormGroup>
          </div>

          <UButton 
            color="primary" 
            :loading="processing"
            :disabled="!watermarkOptions.text.trim()"
            @click="doAddWatermark"
          >
            <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-1" />
            添加水印并下载
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- Word 转 PDF -->
    <UCard v-if="activeTool === 'word2pdf'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-document-text" class="w-5 h-5 text-blue-500" />
          <span class="font-semibold">Word 转 PDF</span>
          <UBadge color="blue" variant="soft" size="xs">DOCX → PDF</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <UAlert 
          color="yellow" 
          variant="soft" 
          icon="i-heroicons-exclamation-triangle"
          title="注意事项"
          description="浏览器端转换功能有限，复杂格式可能丢失。建议简单文档使用，复杂文档请使用 Microsoft Office 或 WPS。"
        />

        <FileUpload
          accept=".docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          accept-text="Word 文档 (.docx)"
          icon="i-heroicons-document-text"
          @files="handleWordFiles"
        />

        <div v-if="wordFiles.length > 0" class="space-y-3">
          <div 
            v-for="(item, index) in wordFiles" 
            :key="item.file.name + index"
            class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <UIcon name="i-heroicons-document-text" class="w-5 h-5 text-blue-500" />
            <span class="flex-1 text-sm truncate">{{ item.file.name }}</span>
            <template v-if="item.status === 'completed'">
              <UBadge color="green" variant="soft">完成</UBadge>
              <UButton size="xs" @click="downloadResult(item.result!)">下载 PDF</UButton>
            </template>
            <template v-else-if="item.status === 'processing'">
              <UBadge color="yellow" variant="soft">转换中...</UBadge>
            </template>
            <template v-else-if="item.status === 'error'">
              <UBadge color="red" variant="soft">失败</UBadge>
            </template>
            <template v-else>
              <UBadge color="gray" variant="soft">等待中</UBadge>
            </template>
            <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="wordFiles.splice(index, 1)" />
          </div>

          <UButton 
            color="primary" 
            :loading="processing"
            :disabled="wordFiles.every(f => f.status === 'completed')"
            @click="doWordToPdf"
          >
            <UIcon name="i-heroicons-bolt" class="w-4 h-4 mr-1" />
            开始转换
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- PDF 转 Word -->
    <UCard v-if="activeTool === 'pdf2word'">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
          <span class="font-semibold">PDF 转 Word</span>
          <UBadge color="red" variant="soft" size="xs">PDF → DOCX</UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <UAlert 
          color="yellow" 
          variant="soft" 
          icon="i-heroicons-exclamation-triangle"
          title="注意事项"
          description="浏览器端仅能提取 PDF 中的文本内容，图片和复杂格式将丢失。如需完美转换，建议使用 SmallPDF、iLovePDF 等在线服务。"
        />

        <FileUpload
          accept=".pdf,application/pdf"
          accept-text="PDF 文件"
          icon="i-heroicons-document"
          @files="handlePdf2WordFiles"
        />

        <div v-if="pdf2wordFiles.length > 0" class="space-y-3">
          <div 
            v-for="(item, index) in pdf2wordFiles" 
            :key="item.file.name + index"
            class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <UIcon name="i-heroicons-document" class="w-5 h-5 text-red-500" />
            <span class="flex-1 text-sm truncate">{{ item.file.name }}</span>
            <template v-if="item.status === 'completed'">
              <UBadge color="green" variant="soft">完成</UBadge>
              <UButton size="xs" @click="downloadWordResult(item)">下载 Word</UButton>
            </template>
            <template v-else-if="item.status === 'processing'">
              <UBadge color="yellow" variant="soft">转换中...</UBadge>
            </template>
            <template v-else-if="item.status === 'error'">
              <UBadge color="red" variant="soft">失败</UBadge>
            </template>
            <template v-else>
              <UBadge color="gray" variant="soft">等待中</UBadge>
            </template>
            <UButton size="xs" variant="ghost" icon="i-heroicons-x-mark" @click="pdf2wordFiles.splice(index, 1)" />
          </div>

          <UButton 
            color="primary" 
            :loading="processing"
            :disabled="pdf2wordFiles.every(f => f.status === 'completed')"
            @click="doPdfToWord"
          >
            <UIcon name="i-heroicons-bolt" class="w-4 h-4 mr-1" />
            开始转换
          </UButton>
        </div>
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
  compressPdf, 
  addWatermark,
  wordToPdf,
  pdfToWord,
  imagesToPdf,
  getPdfPageCount 
} = usePdfProcessor()

const tools = [
  { id: 'merge', name: 'PDF 合并', icon: 'i-heroicons-document-duplicate', bgColor: 'bg-blue-100 dark:bg-blue-900/50', iconColor: 'text-blue-600 dark:text-blue-400' },
  { id: 'split', name: 'PDF 拆分', icon: 'i-heroicons-scissors', bgColor: 'bg-purple-100 dark:bg-purple-900/50', iconColor: 'text-purple-600 dark:text-purple-400' },
  { id: 'compress', name: 'PDF 压缩', icon: 'i-heroicons-arrow-down-on-square-stack', bgColor: 'bg-green-100 dark:bg-green-900/50', iconColor: 'text-green-600 dark:text-green-400' },
  { id: 'watermark', name: '加水印', icon: 'i-heroicons-paint-brush', bgColor: 'bg-cyan-100 dark:bg-cyan-900/50', iconColor: 'text-cyan-600 dark:text-cyan-400' },
  { id: 'word2pdf', name: 'Word→PDF', icon: 'i-heroicons-document-text', bgColor: 'bg-blue-100 dark:bg-blue-900/50', iconColor: 'text-blue-600 dark:text-blue-400' },
  { id: 'pdf2word', name: 'PDF→Word', icon: 'i-heroicons-document', bgColor: 'bg-red-100 dark:bg-red-900/50', iconColor: 'text-red-600 dark:text-red-400' },
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

// ========== PDF 合并 ==========
const mergeFiles = ref<File[]>([])
let dragIndex = -1

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
const splitRangeInput = ref('')
const splitOutputMode = ref('separate')  // 'merge' 合并成一个, 'separate' 分成多个

const splitModeOptions = [
  { value: 'single', label: '每页单独一个文件' },
  { value: 'range', label: '按范围拆分' }
]

const splitOutputOptions = [
  { value: 'separate', label: '每个范围单独一个文件 (如: 1-30.pdf, 60-90.pdf)' },
  { value: 'merge', label: '所有范围合并成一个文件' }
]

// 解析后的范围预览
const parsedRangesPreview = computed(() => {
  const ranges = parseRanges(splitRangeInput.value, splitPageCount.value)
  if (ranges.length === 0) return '无有效范围'
  return ranges.map(r => r.start === r.end ? `第${r.start}页` : `第${r.start}-${r.end}页`).join('、')
})

const parsedRangesCount = computed(() => {
  return parseRanges(splitRangeInput.value, splitPageCount.value).length
})

const handleSplitFile = async (files: File[]) => {
  const file = files.find(f => f.type === 'application/pdf')
  if (file) {
    splitFile.value = file
    splitPageCount.value = await getPdfPageCount(file)
  }
}

const parseRanges = (input: string, maxPage: number): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = []
  
  // 支持中英文逗号和分号分隔: , ， ; ；
  const normalizedInput = input
    .replace(/，/g, ',')  // 中文逗号 → 英文逗号
    .replace(/；/g, ';')  // 中文分号 → 英文分号
    .replace(/;/g, ',')   // 英文分号 → 英文逗号
  
  const parts = normalizedInput.split(',').map(s => s.trim()).filter(Boolean)
  
  for (const part of parts) {
    // 支持中英文横线: - －
    const normalizedPart = part.replace(/－/g, '-')
    
    if (normalizedPart.includes('-')) {
      const [startStr, endStr] = normalizedPart.split('-').map(s => s.trim())
      const start = parseInt(startStr)
      const end = parseInt(endStr)
      if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= maxPage && start <= end) {
        ranges.push({ start, end })
      }
    } else {
      const page = parseInt(normalizedPart)
      if (!isNaN(page) && page >= 1 && page <= maxPage) {
        ranges.push({ start: page, end: page })
      }
    }
  }
  
  return ranges
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
      // 按范围拆分
      const ranges = parseRanges(splitRangeInput.value, splitPageCount.value)
      if (ranges.length === 0) {
        alert('请输入有效的页面范围')
        return
      }
      
      if (splitOutputMode.value === 'merge') {
        // 所有范围合并成一个文件
        const result = await splitAndMergePdf(splitFile.value, ranges)
        downloadResult(result)
      } else {
        // 每个范围单独一个文件
        const results = await splitPdf(splitFile.value, ranges)
        
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

// ========== PDF 压缩 ==========
interface CompressItem {
  file: File
  status: 'pending' | 'processing' | 'completed' | 'error'
  result?: PdfProcessResult
}

const compressFiles = ref<CompressItem[]>([])

const handleCompressFiles = (files: File[]) => {
  const pdfFiles = files.filter(f => f.type === 'application/pdf')
  compressFiles.value.push(...pdfFiles.map(file => ({
    file,
    status: 'pending' as const
  })))
}

const doCompress = async () => {
  processing.value = true
  
  for (const item of compressFiles.value) {
    if (item.status !== 'pending') continue
    item.status = 'processing'
    
    try {
      const result = await compressPdf(item.file)
      item.result = result
      item.status = 'completed'
    } catch (e) {
      item.status = 'error'
      console.error(e)
    }
  }
  
  processing.value = false
}

const downloadAllCompressed = async () => {
  const completed = compressFiles.value.filter(f => f.status === 'completed' && f.result)
  if (completed.length === 0) return
  
  if (completed.length === 1) {
    downloadResult(completed[0].result!)
  } else {
    const zip = new JSZip()
    for (const item of completed) {
      zip.file(item.result!.fileName, item.result!.blob)
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(zipBlob, 'compressed_pdfs.zip')
  }
}

// ========== PDF 加水印 ==========
const watermarkFile = ref<File | null>(null)
const watermarkOptions = ref({
  text: 'CONFIDENTIAL',
  fontSize: 36,
  opacity: 0.3,
  color: '#888888',
  rotation: -45,
  position: 'diagonal' as 'center' | 'diagonal' | 'tile'
})

const watermarkOpacityPercent = computed({
  get: () => Math.round(watermarkOptions.value.opacity * 100),
  set: (val: number) => { watermarkOptions.value.opacity = val / 100 }
})

const watermarkPositionOptions = [
  { value: 'center', label: '居中' },
  { value: 'diagonal', label: '对角线' },
  { value: 'tile', label: '平铺' }
]

const handleWatermarkFile = (files: File[]) => {
  const file = files.find(f => f.type === 'application/pdf')
  if (file) {
    watermarkFile.value = file
  }
}

const doAddWatermark = async () => {
  if (!watermarkFile.value || !watermarkOptions.value.text.trim()) return
  processing.value = true
  
  try {
    const result = await addWatermark(watermarkFile.value, watermarkOptions.value)
    downloadResult(result)
  } catch (e) {
    console.error(e)
  } finally {
    processing.value = false
  }
}

// ========== Word 转 PDF ==========
interface WordItem {
  file: File
  status: 'pending' | 'processing' | 'completed' | 'error'
  result?: PdfProcessResult
}

const wordFiles = ref<WordItem[]>([])

const handleWordFiles = (files: File[]) => {
  const docxFiles = files.filter(f => 
    f.name.endsWith('.docx') || 
    f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
  wordFiles.value.push(...docxFiles.map(file => ({
    file,
    status: 'pending' as const
  })))
}

const doWordToPdf = async () => {
  processing.value = true
  
  for (const item of wordFiles.value) {
    if (item.status !== 'pending') continue
    item.status = 'processing'
    
    try {
      const result = await wordToPdf(item.file)
      item.result = result
      item.status = 'completed'
    } catch (e) {
      item.status = 'error'
      console.error(e)
    }
  }
  
  processing.value = false
}

// ========== PDF 转 Word ==========
interface Pdf2WordItem {
  file: File
  status: 'pending' | 'processing' | 'completed' | 'error'
  resultBlob?: Blob
}

const pdf2wordFiles = ref<Pdf2WordItem[]>([])

const handlePdf2WordFiles = (files: File[]) => {
  const pdfFiles = files.filter(f => f.type === 'application/pdf')
  pdf2wordFiles.value.push(...pdfFiles.map(file => ({
    file,
    status: 'pending' as const
  })))
}

const doPdfToWord = async () => {
  processing.value = true
  
  for (const item of pdf2wordFiles.value) {
    if (item.status !== 'pending') continue
    item.status = 'processing'
    
    try {
      const blob = await pdfToWord(item.file)
      item.resultBlob = blob
      item.status = 'completed'
    } catch (e) {
      item.status = 'error'
      console.error(e)
    }
  }
  
  processing.value = false
}

const downloadWordResult = (item: Pdf2WordItem) => {
  if (!item.resultBlob) return
  const filename = item.file.name.replace('.pdf', '.docx')
  downloadBlob(item.resultBlob, filename)
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
