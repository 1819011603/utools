<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">图片格式转换</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">批量转换图片格式，支持 SVG 转换</p>
      </div>
      <div v-if="hasCompleted" class="flex items-center gap-3">
        <UBadge color="green" variant="soft">{{ completedItems.length }} 个已完成</UBadge>
        <UButton @click="downloadAllAsZip('converted-images.zip', '')">
          <UIcon name="i-heroicons-archive-box-arrow-down" class="w-4 h-4 mr-1" />
          打包下载
        </UButton>
      </div>
    </div>

    <UCard>
      <div class="space-y-4">
        <div class="flex items-end gap-4 flex-wrap">
          <UFormGroup label="目标格式" class="min-w-[160px]">
            <USelectMenu 
              v-model="targetFormat" 
              :options="formatOptions"
              value-attribute="value"
              option-attribute="label"
            >
              <template #label>
                <div class="flex items-center gap-2">
                  <UBadge :color="formatInfo.color" size="xs">{{ formatInfo.label }}</UBadge>
                  <span class="text-xs text-gray-500">{{ formatInfo.desc }}</span>
                </div>
              </template>
            </USelectMenu>
          </UFormGroup>
          
          <UFormGroup v-if="targetFormat === 'image/jpeg' || targetFormat === 'image/webp'" label="输出质量">
            <div class="flex items-center gap-2">
              <URange v-model="outputQuality" :min="60" :max="100" :step="5" class="w-28" />
              <span class="text-sm text-gray-500 w-10">{{ outputQuality }}%</span>
            </div>
          </UFormGroup>

          <UFormGroup v-if="hasSvgFiles" label="SVG 输出尺寸">
            <UInput 
              v-model.number="svgScale" 
              type="number" 
              placeholder="1"
              class="w-20"
            />
            <template #hint>倍率 (1-4)</template>
          </UFormGroup>
        </div>

        <FileUpload
          :accept="acceptFormats"
          accept-text="PNG / JPG / WebP / SVG"
          icon="i-heroicons-arrows-right-left"
          @files="handleFiles"
        />
      </div>
    </UCard>

    <div v-if="items.length > 0" class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">转换列表</h2>
          <UBadge color="gray" variant="soft">{{ items.length }} 个</UBadge>
        </div>
        <UButton variant="ghost" color="red" size="sm" @click="clearAll">
          <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
          清空
        </UButton>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <UCard 
          v-for="item in items" 
          :key="item.id" 
          :ui="{ body: { padding: 'p-3' } }"
        >
          <div class="space-y-2">
            <div class="aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 relative">
              <img
                v-if="item.preview"
                :src="item.processedPreview || item.preview"
                class="w-full h-full object-contain"
                alt="preview"
              />
              <div 
                v-if="item.status === 'processing'"
                class="absolute inset-0 bg-black/50 flex items-center justify-center"
              >
                <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 text-white animate-spin" />
              </div>
              <UBadge
                v-if="item.status === 'completed'"
                color="green"
                size="xs"
                class="absolute top-2 right-2"
              >
                <UIcon name="i-heroicons-check" class="w-3 h-3" />
              </UBadge>
            </div>
            
            <div class="space-y-1">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate">{{ item.name }}</p>
              <div class="flex items-center gap-1 text-xs">
                <UBadge size="xs" color="gray">{{ getFormatLabel(item.file.type) }}</UBadge>
                <UIcon name="i-heroicons-arrow-right" class="w-3 h-3 text-gray-400" />
                <UBadge size="xs" color="primary">{{ formatInfo.label }}</UBadge>
              </div>
              <div class="text-xs text-gray-500">
                {{ formatSize(item.originalSize) }}
                <span v-if="item.processedSize"> → {{ formatSize(item.processedSize) }}</span>
              </div>
            </div>

            <div class="flex gap-2">
              <UButton 
                v-if="item.status === 'completed'" 
                size="xs" 
                block
                @click="downloadItem(item, '')"
              >
                下载
              </UButton>
              <UButton 
                v-if="item.status === 'error'" 
                size="xs" 
                color="red"
                variant="soft"
                block
                @click="convertImage(item)"
              >
                重试
              </UButton>
              <UButton 
                size="xs" 
                variant="ghost" 
                color="gray"
                icon="i-heroicons-x-mark"
                @click="removeItem(item.id)"
              />
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const {
  items,
  completedItems,
  hasCompleted,
  addItem,
  updateItem,
  removeItem,
  clearAll,
  downloadItem,
  downloadAllAsZip,
  createPreview,
  formatSize
} = useMediaProcess()

const targetFormat = ref('image/jpeg')
const outputQuality = ref(85)
const svgScale = ref(2)

const formatOptions = [
  { label: 'JPEG', value: 'image/jpeg', desc: '体积小', color: 'yellow' as const },
  { label: 'WebP', value: 'image/webp', desc: '更小体积', color: 'green' as const },
  { label: 'PNG', value: 'image/png', desc: '无损透明', color: 'blue' as const }
]

const acceptFormats = 'image/png,image/jpeg,image/webp,image/svg+xml,.svg'

const formatInfo = computed(() => {
  return formatOptions.find(f => f.value === targetFormat.value) || formatOptions[0]
})

const hasSvgFiles = computed(() => {
  return items.value.some(item => item.file.type === 'image/svg+xml' || item.name.endsWith('.svg'))
})

const handleFiles = async (files: File[]) => {
  for (const file of files) {
    const isSvg = file.type === 'image/svg+xml' || file.name.endsWith('.svg')
    if (!file.type.startsWith('image/') && !isSvg) continue
    
    const item = addItem(file)
    item.preview = await createPreview(file)
    convertImage(item)
  }
}

const convertImage = async (item: typeof items.value[0]) => {
  updateItem(item.id, { status: 'processing', progress: 0 })

  try {
    const isSvg = item.file.type === 'image/svg+xml' || item.name.endsWith('.svg')
    
    let width: number
    let height: number
    let source: HTMLImageElement | ImageBitmap

    if (isSvg) {
      const img = new Image()
      const svgUrl = URL.createObjectURL(item.file)
      
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('SVG 加载失败'))
        img.src = svgUrl
      })

      width = (img.naturalWidth || 100) * svgScale.value
      height = (img.naturalHeight || 100) * svgScale.value
      source = img
      
      URL.revokeObjectURL(svgUrl)
    } else {
      const bitmap = await createImageBitmap(item.file)
      width = bitmap.width
      height = bitmap.height
      source = bitmap
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    
    const ctx = canvas.getContext('2d')!
    
    if (targetFormat.value === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, width, height)
    }
    
    ctx.drawImage(source, 0, 0, width, height)

    const supportsQuality = ['image/jpeg', 'image/webp'].includes(targetFormat.value)
    const quality = supportsQuality ? outputQuality.value / 100 : undefined

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('转换失败')),
        targetFormat.value,
        quality
      )
    })

    const processedPreview = URL.createObjectURL(blob)

    updateItem(item.id, {
      processedBlob: blob,
      processedSize: blob.size,
      processedPreview,
      status: 'completed',
      progress: 100
    })
  } catch (error) {
    console.error('转换失败:', error)
    updateItem(item.id, { 
      status: 'error', 
      error: error instanceof Error ? error.message : '转换失败' 
    })
  }
}

const getFormatLabel = (type: string): string => {
  const map: Record<string, string> = {
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/jpg': 'JPG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/svg+xml': 'SVG'
  }
  return map[type] || type.split('/')[1]?.toUpperCase() || '未知'
}

watch([targetFormat, outputQuality, svgScale], () => {
  items.value.forEach(item => {
    if (item.status === 'completed' || item.status === 'error') {
      convertImage(item)
    }
  })
})
</script>
