<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">音频格式转换</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">音频格式互转，支持批量处理</p>
      </div>
      <div v-if="hasCompleted" class="flex items-center gap-3">
        <UBadge color="green" variant="soft">{{ completedItems.length }} 个已完成</UBadge>
        <UButton @click="downloadAllAsZip('converted-audio.zip', '')">
          <UIcon name="i-heroicons-archive-box-arrow-down" class="w-4 h-4 mr-1" />
          打包下载
        </UButton>
      </div>
    </div>

    <UAlert
      icon="i-heroicons-information-circle"
      color="blue"
      variant="soft"
    >
      <template #title>说明</template>
      <template #description>
        <div class="text-sm">
          浏览器只支持转换为 <strong>WAV</strong> 格式。可调整采样率和位深度控制文件大小。
        </div>
      </template>
    </UAlert>

    <UCard>
      <div class="space-y-4">
        <div class="flex items-end gap-4 flex-wrap">
          <UFormGroup label="采样率">
            <USelectMenu 
              v-model="sampleRate" 
              :options="sampleRateOptions" 
              value-attribute="value"
              option-attribute="label"
              class="w-36" 
            />
          </UFormGroup>
          
          <UFormGroup label="位深度">
            <USelectMenu 
              v-model="bitDepth" 
              :options="bitDepthOptions" 
              value-attribute="value"
              option-attribute="label"
              class="w-32" 
            />
          </UFormGroup>
        </div>


        <FileUpload
          accept="audio/*"
          accept-text="MP3 / WAV / OGG / M4A / FLAC / AAC"
          icon="i-heroicons-musical-note"
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

      <div class="space-y-3">
        <UCard v-for="item in items" :key="item.id" :ui="{ body: { padding: 'p-4' } }">
          <div class="flex items-center gap-4">
            <div 
              class="w-14 h-14 rounded-xl flex items-center justify-center shrink-0"
              :class="getStatusBgColor(item.status)"
            >
              <UIcon 
                v-if="item.status === 'processing'"
                name="i-heroicons-arrow-path" 
                class="w-6 h-6 text-yellow-600 animate-spin" 
              />
              <UIcon 
                v-else-if="item.status === 'completed'"
                name="i-heroicons-check" 
                class="w-6 h-6 text-green-600" 
              />
              <UIcon 
                v-else-if="item.status === 'error'"
                name="i-heroicons-exclamation-triangle" 
                class="w-6 h-6 text-red-600" 
              />
              <UIcon 
                v-else
                name="i-heroicons-musical-note" 
                class="w-6 h-6 text-violet-600" 
              />
            </div>
            
            <div class="flex-1 min-w-0">
              <p class="font-medium text-gray-900 dark:text-white truncate">{{ item.name }}</p>
              <div class="flex items-center gap-3 mt-1 text-sm">
                <div class="flex items-center gap-1.5">
                  <UBadge size="xs" color="gray">{{ getFormatLabel(item.file.type) }}</UBadge>
                  <UIcon name="i-heroicons-arrow-right" class="w-3 h-3 text-gray-400" />
                  <UBadge size="xs" color="blue">WAV</UBadge>
                </div>
                <span class="text-gray-500">
                  {{ formatSize(item.originalSize) }}
                  <template v-if="item.processedSize">
                    → {{ formatSize(item.processedSize) }}
                  </template>
                </span>
                <span v-if="item.meta?.duration" class="text-gray-500">
                  {{ formatDuration(item.meta.duration) }}
                </span>
              </div>
              
              <div v-if="item.status === 'processing'" class="mt-2">
                <UProgress :value="item.progress" size="sm" />
                <p class="text-xs text-gray-500 mt-1">{{ getProgressText(item.progress) }}</p>
              </div>
              
              <p v-if="item.status === 'error'" class="text-xs text-red-500 mt-1">
                {{ item.error }}
              </p>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <template v-if="item.status === 'completed'">
                <UButton size="sm" @click="downloadItem(item, '')">下载</UButton>
                <UButton 
                  size="sm" 
                  variant="ghost" 
                  icon="i-heroicons-play"
                  @click="playAudio(item)"
                />
              </template>
              <UButton 
                v-if="item.status === 'error'" 
                size="sm" 
                variant="soft"
                @click="retryConvert(item)"
              >
                重试
              </UButton>
              <UButton 
                size="sm" 
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

    <audio ref="audioPlayer" class="hidden" />
  </div>
</template>

<script setup lang="ts">
import { useAudioConvert } from '~/composables/useAudioConvert'

const {
  items,
  completedItems,
  hasCompleted,
  clearAll,
  downloadItem,
  downloadAllAsZip,
  formatSize,
  audioPlayer,
  sampleRate,
  bitDepth,
  sampleRateOptions,
  bitDepthOptions,
  handleFiles,
  retryConvert,
  removeItem,
  playAudio,
  formatDuration,
  getFormatLabel,
  getStatusBgColor,
  getProgressText
} = useAudioConvert()
</script>
