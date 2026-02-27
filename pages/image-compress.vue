<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">图片压缩</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">批量压缩图片，支持实时预览对比</p>
      </div>
      <div v-if="hasCompleted" class="flex items-center gap-3">
        <div v-if="savedSize > 0" class="text-right text-sm">
          <div class="text-gray-500">已节省</div>
          <div class="font-semibold text-green-600 dark:text-green-400">
            {{ formatSize(savedSize) }} ({{ savedPercent }}%)
          </div>
        </div>
        <div v-else class="text-right text-sm">
          <div class="text-gray-500">提示</div>
          <div class="font-semibold text-yellow-600 dark:text-yellow-400">
            文件已增大 {{ formatSize(Math.abs(savedSize)) }}
          </div>
        </div>
        <UButton @click="downloadAllAsZip('compressed-images.zip', '_compressed')">
          <UIcon name="i-heroicons-archive-box-arrow-down" class="w-4 h-4 mr-1" />
          打包下载
        </UButton>
      </div>
    </div>

    <UCard>
      <div class="space-y-4">
        <div class="flex items-end gap-6 flex-wrap">
          <UFormGroup label="压缩质量" class="flex-1 min-w-[200px]">
            <div class="flex items-center gap-3">
              <URange v-model="quality" :min="10" :max="100" :step="5" class="flex-1" />
              <UBadge :color="qualityColor" variant="soft" class="w-14 justify-center">
                {{ quality }}%
              </UBadge>
            </div>
            <div class="flex justify-between text-xs text-gray-400 mt-1">
              <span>文件更小</span>
              <span>质量更好</span>
            </div>
          </UFormGroup>
          
          <UFormGroup label="最大宽度 (px)">
            <UInput 
              v-model.number="maxWidth" 
              type="number" 
              placeholder="不限制" 
              class="w-28"
              :ui="{ base: 'text-center' }"
            />
          </UFormGroup>
          
          <UFormGroup label="输出格式">
            <USelectMenu 
              v-model="outputFormat" 
              :options="formatOptions" 
              value-attribute="value"
              option-attribute="label"
              class="w-32" 
            />
          </UFormGroup>

          <UFormGroup label="并行数">
            <div class="flex items-center gap-2">
              <URange v-model="maxConcurrent" :min="1" :max="8" :step="1" class="w-24" />
              <UBadge variant="soft" class="w-8 justify-center">{{ maxConcurrent }}</UBadge>
            </div>
          </UFormGroup>
        </div>

        <FileUpload
          accept="image/*"
          accept-text="PNG / JPG / WebP / GIF"
          icon="i-heroicons-photo"
          @files="handleFiles"
        />
      </div>
    </UCard>

    <div v-if="items.length > 0" class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
            处理列表
          </h2>
          <UBadge color="gray" variant="soft">{{ items.length }} 张</UBadge>
          <UBadge v-if="completedItems.length" color="green" variant="soft">
            {{ completedItems.length }} 完成
          </UBadge>
        </div>
        <UButton variant="ghost" color="red" size="sm" @click="clearAll">
          <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
          清空
        </UButton>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UCard 
          v-for="item in items" 
          :key="item.id" 
          :ui="{ body: { padding: 'p-3' } }"
          :class="{ 'ring-2 ring-primary-500': selectedItem?.id === item.id }"
        >
          <div class="flex gap-3">
            <div 
              class="w-20 h-20 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0 cursor-pointer relative group"
              @click="selectItem(item)"
            >
              <img
                v-if="item.preview"
                :src="item.processedPreview || item.preview"
                class="w-full h-full object-cover"
                alt="preview"
              />
              <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <UIcon name="i-heroicons-magnifying-glass-plus" class="w-6 h-6 text-white" />
              </div>
              <UBadge
                v-if="item.status === 'completed' && item.processedSize && item.processedSize < item.originalSize"
                color="green"
                size="xs"
                class="absolute bottom-1 right-1"
              >
                -{{ getCompressionRate(item) }}
              </UBadge>
              <UBadge
                v-else-if="item.status === 'completed'"
                color="gray"
                size="xs"
                class="absolute bottom-1 right-1"
              >
                原图
              </UBadge>
            </div>
            
            <div class="flex-1 min-w-0">
              <p class="font-medium text-gray-900 dark:text-white truncate text-sm">{{ item.name }}</p>
              <div class="mt-1 space-y-0.5 text-xs">
                <div class="flex justify-between text-gray-500 dark:text-gray-400">
                  <span>原始:</span>
                  <span>{{ formatSize(item.originalSize) }}</span>
                </div>
                <div v-if="item.processedSize" class="flex justify-between">
                  <span class="text-gray-500 dark:text-gray-400">压缩后:</span>
                  <span 
                    :class="item.processedSize < item.originalSize 
                      ? 'text-green-600 dark:text-green-400 font-medium' 
                      : 'text-gray-500 dark:text-gray-400'"
                  >
                    {{ formatSize(item.processedSize) }}
                    <span v-if="item.processedSize >= item.originalSize" class="text-xs">(已是最优)</span>
                  </span>
                </div>
              </div>
              
              <div class="mt-2 flex items-center gap-2">
                <template v-if="item.status === 'completed'">
                  <UButton size="xs" @click="downloadItem(item, '_compressed')">下载</UButton>
                  <UButton size="xs" variant="ghost" @click="reprocess(item)">
                    <UIcon name="i-heroicons-arrow-path" class="w-3 h-3" />
                  </UButton>
                </template>
                <template v-else-if="item.status === 'processing'">
                  <UBadge color="yellow" variant="soft">压缩中...</UBadge>
                </template>
                <template v-else-if="item.status === 'error'">
                  <UBadge color="red" variant="soft">失败</UBadge>
                  <UButton size="xs" variant="ghost" @click="reprocess(item)">重试</UButton>
                </template>
              </div>
            </div>
            
            <UButton 
              size="xs" 
              variant="ghost" 
              color="gray"
              icon="i-heroicons-x-mark"
              @click="removeItem(item.id)"
            />
          </div>
        </UCard>
      </div>
    </div>

    <UModal v-model="showCompareModal" :ui="{ width: 'max-w-4xl' }">
      <UCard v-if="selectedItem">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">压缩前后对比</span>
            <UButton variant="ghost" icon="i-heroicons-x-mark" @click="showCompareModal = false" />
          </div>
        </template>

        <div class="space-y-4">
          <div class="flex items-center justify-center gap-2 text-sm">
            <UBadge color="gray">原图: {{ formatSize(selectedItem.originalSize) }}</UBadge>
            <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 text-gray-400" />
            <UBadge color="green">压缩后: {{ formatSize(selectedItem.processedSize || 0) }}</UBadge>
            <UBadge color="primary" variant="soft">节省 {{ getCompressionRate(selectedItem) }}</UBadge>
          </div>

          <div 
            ref="compareContainer"
            class="relative rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 select-none" 
            style="aspect-ratio: 16/10;"
            @mousedown="startDrag"
            @mousemove="onDrag"
            @mouseup="stopDrag"
            @mouseleave="stopDrag"
          >
            <img
              :src="selectedItem.preview"
              class="absolute inset-0 w-full h-full object-contain pointer-events-none"
              alt="original"
              draggable="false"
            />
            <div 
              class="absolute inset-0 overflow-hidden pointer-events-none"
              :style="{ width: `${comparePosition}%` }"
            >
              <img
                :src="selectedItem.processedPreview"
                class="absolute top-0 left-0 h-full object-contain"
                :style="{ width: `${100 / comparePosition * 100}%`, maxWidth: 'none' }"
                alt="compressed"
                draggable="false"
              />
            </div>
            
            <div 
              class="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg pointer-events-none"
              :style="{ left: `${comparePosition}%`, transform: 'translateX(-50%)' }"
            >
              <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center cursor-ew-resize pointer-events-auto">
                <UIcon name="i-heroicons-arrows-right-left" class="w-4 h-4 text-gray-600" />
              </div>
            </div>

            <div class="absolute bottom-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded pointer-events-none">
              压缩后
            </div>
            <div class="absolute bottom-2 right-2 px-2 py-1 bg-black/60 text-white text-xs rounded pointer-events-none">
              原图
            </div>
          </div>

          <URange v-model="comparePosition" :min="0" :max="100" />
        </div>
      </UCard>
    </UModal>
  </div>
</template>

<script setup lang="ts">
const {
  items,
  completedItems,
  hasCompleted,
  savedSize,
  savedPercent,
  addItem,
  updateItem,
  removeItem,
  clearAll,
  downloadItem,
  downloadAllAsZip,
  createPreview,
  formatSize
} = useMediaProcess()

const quality = ref(75)
const maxWidth = ref<number | undefined>()
const outputFormat = ref('image/jpeg')
const maxConcurrent = ref(4)
const selectedItem = ref<typeof items.value[0] | null>(null)
const showCompareModal = ref(false)
const comparePosition = ref(50)

const formatOptions = [
  { label: 'JPEG (推荐)', value: 'image/jpeg' },
  { label: 'WebP (更小)', value: 'image/webp' },
  { label: 'PNG', value: 'image/png' }
]

const qualityColor = computed(() => {
  if (quality.value >= 80) return 'green'
  if (quality.value >= 50) return 'yellow'
  return 'red'
})

const processingQueue: Array<typeof items.value[0]> = []
let activeCount = 0

const processNext = async () => {
  if (activeCount >= maxConcurrent.value || processingQueue.length === 0) return
  
  const item = processingQueue.shift()
  if (!item) return
  
  activeCount++
  try {
    await compressImage(item)
  } finally {
    activeCount--
    processNext()
  }
}

const handleFiles = async (files: File[]) => {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
  
  for (const file of imageFiles) {
    const item = addItem(file)
    item.preview = await createPreview(file)
    processingQueue.push(item)
  }
  
  const startCount = Math.min(maxConcurrent.value, processingQueue.length)
  for (let i = 0; i < startCount; i++) {
    processNext()
  }
}

const compressImage = async (item: typeof items.value[0]) => {
  updateItem(item.id, { status: 'processing', progress: 0 })

  try {
    const bitmap = await createImageBitmap(item.file)
    
    let width = bitmap.width
    let height = bitmap.height
    
    if (maxWidth.value && width > maxWidth.value) {
      height = Math.round((maxWidth.value / width) * height)
      width = maxWidth.value
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    
    const ctx = canvas.getContext('2d')!

    let mimeType = outputFormat.value === 'original' 
      ? (item.file.type || 'image/jpeg')
      : outputFormat.value

    if (mimeType === 'image/gif') {
      mimeType = 'image/png'
    }

    if (mimeType === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, width, height)
    }
    
    ctx.drawImage(bitmap, 0, 0, width, height)

    const supportsQuality = ['image/jpeg', 'image/webp'].includes(mimeType)
    const qualityValue = supportsQuality ? quality.value / 100 : undefined

    let blob: Blob

    if (mimeType === 'image/png') {
      blob = await compressPng(canvas, ctx, width, height, quality.value)
    } else {
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          b => b ? resolve(b) : reject(new Error('压缩失败')),
          mimeType,
          qualityValue
        )
      })
    }

    if (blob.size >= item.originalSize) {
      blob = item.file
    }

    const processedPreview = URL.createObjectURL(blob)

    updateItem(item.id, {
      processedBlob: blob,
      processedSize: blob.size,
      processedPreview,
      status: 'completed',
      progress: 100
    })
  } catch (error) {
    updateItem(item.id, { 
      status: 'error', 
      error: error instanceof Error ? error.message : '压缩失败' 
    })
  }
}

const reprocess = (item: typeof items.value[0]) => {
  if (item.processedPreview) {
    URL.revokeObjectURL(item.processedPreview)
  }
  updateItem(item.id, { status: 'pending', processedBlob: undefined, processedSize: undefined, processedPreview: undefined })
  processingQueue.push(item)
  processNext()
}

const compressPng = async (
  _canvas: HTMLCanvasElement, 
  ctx: CanvasRenderingContext2D, 
  width: number, 
  height: number,
  qualityPercent: number
): Promise<Blob> => {
  try {
    // @ts-ignore
    const UPNG = await import('upng-js')
    
    const imageData = ctx.getImageData(0, 0, width, height)
    const rgba = new Uint8Array(imageData.data.buffer)
    
    const targetColors = Math.max(8, Math.min(256, Math.round(qualityPercent * 2.56)))
    
    const pngData = UPNG.encode([rgba.buffer], width, height, targetColors)
    
    return new Blob([pngData], { type: 'image/png' })
  } catch (e) {
    console.error('PNG compression failed:', e)
    return new Promise<Blob>((resolve, reject) => {
      _canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('PNG 压缩失败')),
        'image/png'
      )
    })
  }
}

const getCompressionRate = (item: typeof items.value[0]): string => {
  if (!item.processedSize) return '0%'
  const rate = ((1 - item.processedSize / item.originalSize) * 100).toFixed(0)
  return `${rate}%`
}

const selectItem = (item: typeof items.value[0]) => {
  if (item.status === 'completed' && item.processedPreview) {
    selectedItem.value = item
    showCompareModal.value = true
  }
}

const compareContainer = ref<HTMLElement>()
let isDragging = false

const updateComparePosition = (e: MouseEvent) => {
  if (!compareContainer.value) return
  const rect = compareContainer.value.getBoundingClientRect()
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
  comparePosition.value = Math.round((x / rect.width) * 100)
}

const startDrag = (e: MouseEvent) => {
  isDragging = true
  updateComparePosition(e)
}

const onDrag = (e: MouseEvent) => {
  if (!isDragging) return
  e.preventDefault()
  updateComparePosition(e)
}

const stopDrag = () => {
  isDragging = false
}

let reprocessTimer: ReturnType<typeof setTimeout> | null = null

const debouncedReprocess = () => {
  if (reprocessTimer) {
    clearTimeout(reprocessTimer)
  }
  reprocessTimer = setTimeout(() => {
    const toReprocess = items.value.filter(item => item.status === 'completed' || item.status === 'error')
    toReprocess.forEach(item => {
      if (item.processedPreview) {
        URL.revokeObjectURL(item.processedPreview)
      }
      updateItem(item.id, { status: 'pending', processedBlob: undefined, processedSize: undefined, processedPreview: undefined })
      processingQueue.push(item)
    })
    
    const startCount = Math.min(maxConcurrent.value, processingQueue.length)
    for (let i = 0; i < startCount; i++) {
      processNext()
    }
    reprocessTimer = null
  }, 800)
}

watch([quality, maxWidth, outputFormat], debouncedReprocess)
</script>
