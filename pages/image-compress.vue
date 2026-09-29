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
          <UFormGroup :label="isPdfOutput ? 'PDF 图片质量' : '压缩质量'" class="flex-1 min-w-[200px]">
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
          accept="image/*,.tiff,.tif"
          accept-text="PNG / JPG / WebP / GIF / TIFF"
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
          :class="[
            { 'ring-2 ring-primary-500': selectedItem?.id === item.id },
            item.status === 'completed' ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors' : ''
          ]"
          @click="selectItem(item)"
        >
          <div class="flex gap-3">
            <div class="w-20 h-20 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0 relative group">
              <img
                v-if="item.preview"
                :src="item.processedPreview || item.preview"
                class="w-full h-full object-cover"
                alt="preview"
              />
              <div 
                v-if="item.status === 'completed'"
                class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
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
                  <UButton size="xs" @click.stop="downloadItem(item, '_compressed')">下载</UButton>
                  <UButton size="xs" variant="ghost" @click.stop="reprocess(item)">
                    <UIcon name="i-heroicons-arrow-path" class="w-3 h-3" />
                  </UButton>
                  <span class="text-xs text-gray-400 ml-auto">点击预览对比</span>
                </template>
                <template v-else-if="item.status === 'processing'">
                  <UBadge color="yellow" variant="soft">压缩中...</UBadge>
                </template>
                <template v-else-if="item.status === 'pending'">
                  <UBadge color="gray" variant="soft">等待中...</UBadge>
                </template>
                <template v-else-if="item.status === 'error'">
                  <UBadge color="red" variant="soft">失败</UBadge>
                  <UButton size="xs" variant="ghost" @click.stop="reprocess(item)">重试</UButton>
                </template>
              </div>
            </div>
            
            <UButton 
              size="xs" 
              variant="ghost" 
              color="gray"
              icon="i-heroicons-x-mark"
              @click.stop="removeItem(item.id)"
            />
          </div>
        </UCard>
      </div>
    </div>

    <UModal v-model="showCompareModal" :ui="{ width: 'max-w-[90vw] sm:max-w-[85vw]' }">
      <UCard v-if="selectedItem">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">压缩前后对比</span>
            <UButton variant="ghost" icon="i-heroicons-x-mark" @click="showCompareModal = false" />
          </div>
        </template>

        <div class="space-y-4">
          <div class="flex items-center justify-center gap-2 text-sm flex-wrap">
            <UBadge color="gray">原图: {{ formatSize(selectedItem.originalSize) }}</UBadge>
            <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 text-gray-400" />
            <UBadge color="green">压缩后: {{ formatSize(selectedItem.processedSize || 0) }}</UBadge>
            <UBadge color="primary" variant="soft">节省 {{ getCompressionRate(selectedItem) }}</UBadge>
          </div>

          <div class="flex justify-center">
            <div 
              ref="compareContainer"
              class="relative rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 select-none w-full" 
              :style="compareContainerStyle"
              @mousedown="startDrag"
              @mousemove="onDrag"
              @mouseup="stopDrag"
              @mouseleave="stopDrag"
              @touchstart.prevent="startTouchDrag"
              @touchmove.prevent="onTouchDrag"
              @touchend="stopDrag"
            >
              <img
                :src="selectedItem.originalPreviewUrl"
                class="absolute inset-0 w-full h-full object-contain pointer-events-none"
                alt="original"
                draggable="false"
                @load="onImageLoad"
              />
              <div 
                v-if="imageLoaded"
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
                v-if="imageLoaded"
                class="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg pointer-events-none"
                :style="{ left: `${comparePosition}%`, transform: 'translateX(-50%)' }"
              >
                <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center cursor-ew-resize pointer-events-auto">
                  <UIcon name="i-heroicons-arrows-right-left" class="w-4 h-4 text-gray-600" />
                </div>
              </div>

              <div v-if="imageLoaded" class="absolute bottom-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded pointer-events-none">
                压缩后
              </div>
              <div v-if="imageLoaded" class="absolute bottom-2 right-2 px-2 py-1 bg-black/60 text-white text-xs rounded pointer-events-none">
                原图
              </div>
              
              <div v-if="!imageLoaded" class="absolute inset-0 flex items-center justify-center">
                <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 text-gray-400 animate-spin" />
              </div>
            </div>
          </div>

          <URange v-model="comparePosition" :min="0" :max="100" />
        </div>
      </UCard>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { useImageCompress } from '~/composables/useImageCompress'

const {
  items,
  completedItems,
  hasCompleted,
  savedSize,
  savedPercent,
  formatSize,
  downloadAllAsZip,
  downloadItem,
  clearAll,
  removeItem,
  quality,
  maxWidth,
  outputFormat,
  maxConcurrent,
  qualityColor,
  isPdfOutput,
  formatOptions,
  handleFiles,
  reprocess,
  selectItem,
  getCompressionRate,
  showCompareModal,
  selectedItem,
  compareContainer,
  compareContainerStyle,
  startDrag,
  onDrag,
  stopDrag,
  startTouchDrag,
  onTouchDrag,
  onImageLoad,
  imageLoaded,
  comparePosition
} = useImageCompress()
</script>
