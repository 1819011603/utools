<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频转 GIF</h1>
      <p class="text-gray-600 dark:text-gray-400 mt-1">将视频片段转换为 GIF 动图</p>
    </div>

    <UAlert
      icon="i-heroicons-light-bulb"
      color="blue"
      variant="soft"
    >
      <template #title>使用建议</template>
      <template #description>
        <div class="text-sm">
          控制 <strong>时长在 3-5 秒</strong> 可获得最佳效果。默认参数已优化清晰度，如需更小文件可降低宽度或帧率。
        </div>
      </template>
    </UAlert>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- 视频源 -->
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">视频源</span>
            <UButton v-if="videoUrl" variant="ghost" size="xs" color="red" @click="clearVideo">
              清除
            </UButton>
          </div>
        </template>
        
        <div v-if="!videoUrl" class="space-y-4">
          <FileUpload
            accept="video/*"
            accept-text="MP4 / WebM / MOV"
            icon="i-heroicons-film"
            :multiple="false"
            @files="handleVideoFile"
          />
        </div>

        <div v-else class="space-y-4">
          <div class="rounded-lg overflow-hidden bg-black aspect-video relative">
            <video
              ref="videoRef"
              :src="videoUrl"
              class="w-full h-full"
              muted
              playsinline
              @loadedmetadata="onVideoLoaded"
              @timeupdate="onTimeUpdate"
            />
            <div v-if="!videoLoaded" class="absolute inset-0 flex items-center justify-center">
              <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 text-white animate-spin" />
            </div>
          </div>

          <!-- 播放控制 -->
          <div class="flex items-center gap-2">
            <UButton
              variant="ghost"
              :icon="isPlaying ? 'i-heroicons-pause' : 'i-heroicons-play'"
              @click="togglePlay"
            />
            <div class="flex-1 relative">
              <URange
                v-model="currentTime"
                :min="0"
                :max="duration"
                :step="0.01"
                @update:model-value="seekTo"
              />
              <div 
                v-if="startTime < endTime"
                class="absolute top-1/2 h-1 bg-primary-500/30 rounded -translate-y-1/2 pointer-events-none"
                :style="{
                  left: `${(startTime / duration) * 100}%`,
                  width: `${((endTime - startTime) / duration) * 100}%`
                }"
              />
            </div>
            <span class="text-sm text-gray-500 w-24 text-right font-mono">
              {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
            </span>
          </div>

          <!-- 时间选择 -->
          <div class="grid grid-cols-2 gap-4">
            <UFormGroup label="开始时间">
              <div class="flex items-center gap-2">
                <UInput 
                  :model-value="formatTime(startTime)" 
                  readonly
                  class="flex-1 font-mono"
                  :ui="{ base: 'text-center' }"
                />
                <UButton size="sm" variant="soft" @click="startTime = currentTime">
                  设为当前
                </UButton>
              </div>
            </UFormGroup>
            <UFormGroup label="结束时间">
              <div class="flex items-center gap-2">
                <UInput 
                  :model-value="formatTime(endTime)"
                  readonly
                  class="flex-1 font-mono"
                  :ui="{ base: 'text-center' }"
                />
                <UButton size="sm" variant="soft" @click="endTime = currentTime">
                  设为当前
                </UButton>
              </div>
            </UFormGroup>
          </div>

          <!-- 时长信息 -->
          <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <span class="text-sm text-gray-500">选中时长</span>
            <div class="flex items-center gap-2">
              <span class="font-mono font-medium">{{ formatTime(clipDuration) }}</span>
              <UBadge 
                v-if="clipDuration > 10" 
                color="yellow" 
                variant="soft" 
                size="xs"
              >
                较长，建议裁短
              </UBadge>
              <UBadge 
                v-else-if="clipDuration > 0" 
                color="green" 
                variant="soft" 
                size="xs"
              >
                合适
              </UBadge>
            </div>
          </div>

          <!-- 预览按钮 -->
          <UButton 
            v-if="videoLoaded && !previewUrl"
            block 
            variant="soft" 
            @click="generatePreview"
          >
            <UIcon name="i-heroicons-eye" class="w-4 h-4 mr-2" />
            预览首帧效果
          </UButton>
        </div>
      </UCard>

      <!-- GIF 设置 -->
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">GIF 设置</span>
            <UButton variant="ghost" size="xs" @click="resetSettings">
              重置
            </UButton>
          </div>
        </template>

        <div class="space-y-4">
          <!-- 基础设置 -->
          <UFormGroup label="输出宽度">
            <div class="flex items-center gap-3">
              <URange v-model="settings.width" :min="240" :max="800" :step="40" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ settings.width }}px</UBadge>
            </div>
            <template #hint>
              <span :class="settings.width > 600 ? 'text-yellow-600' : ''">
                {{ settings.width > 600 ? '宽度较大，文件会较大' : '推荐 400-500px 兼顾清晰度和大小' }}
              </span>
            </template>
          </UFormGroup>

          <UFormGroup label="帧率 (FPS)">
            <div class="flex items-center gap-3">
              <URange v-model="settings.fps" :min="8" :max="24" :step="1" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ settings.fps }} fps</UBadge>
            </div>
            <template #hint>推荐 10-15 fps，流畅且文件适中</template>
          </UFormGroup>

          <UDivider label="画质设置" />

          <!-- 颜色质量 -->
          <UFormGroup label="清晰度">
            <USelectMenu 
              v-model="settings.quality" 
              :options="QUALITY_OPTIONS"
              value-attribute="value"
              option-attribute="label"
            />
            <template #hint>清晰度越高颜色越准确，但编码稍慢</template>
          </UFormGroup>

          <!-- 抖动算法 -->
          <UFormGroup label="抖动处理">
            <USelectMenu 
              v-model="settings.dither" 
              :options="DITHER_OPTIONS"
              value-attribute="value"
              option-attribute="label"
            />
            <template #hint>无抖动最清晰，有抖动过渡更平滑</template>
          </UFormGroup>

          <!-- 循环设置 -->
          <UFormGroup label="循环播放">
            <USelectMenu 
              v-model="settings.repeat" 
              :options="REPEAT_OPTIONS"
              value-attribute="value"
              option-attribute="label"
            />
          </UFormGroup>

          <!-- 并行线程 -->
          <UFormGroup label="并行线程">
            <div class="flex items-center gap-3">
              <URange v-model="settings.workers" :min="1" :max="8" :step="1" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ settings.workers }} 线程</UBadge>
            </div>
            <template #hint>更多线程加速编码，但占用更多内存</template>
          </UFormGroup>

          <UDivider />

          <!-- 预估信息 -->
          <div class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-500">预估帧数</span>
              <span class="font-medium">{{ estimatedFrames }} 帧</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">预估大小</span>
              <span class="font-medium" :class="estimatedBytes > 5 * 1024 * 1024 ? 'text-yellow-600' : ''">
                {{ formatFileSize(estimatedBytes) }}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">输出尺寸</span>
              <span class="font-medium">{{ settings.width }} × {{ outputHeight }}px</span>
            </div>
          </div>

          <!-- 转换按钮 -->
          <UButton
            block
            size="lg"
            :loading="isEncoding"
            :disabled="!videoUrl || clipDuration <= 0"
            @click="startConvert"
          >
            <UIcon name="i-heroicons-sparkles" class="w-5 h-5 mr-2" />
            {{ isEncoding ? '转换中...' : '开始转换' }}
          </UButton>

          <!-- 进度条 -->
          <div v-if="isEncoding" class="space-y-2">
            <UProgress :value="progress.progress" :color="progress.phase === 'extracting' ? 'primary' : 'green'" />
            <p class="text-sm text-center text-gray-500">{{ progress.message }}</p>
          </div>
        </div>
      </UCard>
    </div>

    <!-- 预览和结果 -->
    <div v-if="previewUrl || gifUrl" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- 预览 -->
      <UCard v-if="previewUrl">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">首帧预览</span>
            <UButton variant="ghost" size="xs" @click="previewUrl = ''">关闭</UButton>
          </div>
        </template>
        <div class="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
          <img :src="previewUrl" class="w-full" alt="Preview" />
        </div>
        <template #footer>
          <p class="text-sm text-gray-500 text-center">
            预览尺寸: {{ settings.width }} × {{ outputHeight }}px
          </p>
        </template>
      </UCard>

      <!-- 结果 -->
      <UCard v-if="gifUrl">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-medium">转换结果</span>
            <UBadge :color="gifSize > 5 * 1024 * 1024 ? 'yellow' : 'green'" variant="soft">
              {{ formatFileSize(gifSize) }}
            </UBadge>
          </div>
        </template>
        <div class="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
          <img :src="gifUrl" class="w-full" alt="Generated GIF" />
        </div>
        <template #footer>
          <div class="flex gap-2">
            <UButton class="flex-1" variant="soft" @click="downloadGif">
              <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-2" />
              下载 GIF
            </UButton>
            <UButton variant="ghost" @click="clearGif">
              <UIcon name="i-heroicons-trash" class="w-4 h-4" />
            </UButton>
          </div>
        </template>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { 
  useGifEncoder, 
  DITHER_OPTIONS, 
  QUALITY_OPTIONS, 
  REPEAT_OPTIONS,
  type DitherType 
} from '~/composables/useGifEncoder'

const {
  isEncoding,
  progress,
  convertVideoToGif,
  captureFrame,
  estimateGifSize,
  formatFileSize,
  formatTime
} = useGifEncoder()

const videoRef = ref<HTMLVideoElement>()
const videoUrl = ref('')
const videoFile = ref<File>()
const videoLoaded = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const isPlaying = ref(false)

const startTime = ref(0)
const endTime = ref(0)

const settings = reactive({
  width: 480,
  fps: 12,
  quality: 1,
  workers: 4,
  dither: false as DitherType,
  repeat: 0
})

const previewUrl = ref('')
const gifUrl = ref('')
const gifBlob = ref<Blob>()
const gifSize = ref(0)

const clipDuration = computed(() => Math.max(0, endTime.value - startTime.value))
const estimatedFrames = computed(() => Math.ceil(clipDuration.value * settings.fps))

const outputHeight = computed(() => {
  if (!videoRef.value || !videoLoaded.value) return Math.round(settings.width * 0.5625)
  const aspectRatio = videoRef.value.videoHeight / videoRef.value.videoWidth
  return Math.round(settings.width * aspectRatio)
})

const estimatedBytes = computed(() => 
  estimateGifSize(estimatedFrames.value, settings.width, outputHeight.value, 128, settings.quality)
)

const handleVideoFile = (files: File[]) => {
  if (files[0]) loadVideo(files[0])
}

const loadVideo = (file: File) => {
  videoFile.value = file
  videoUrl.value = URL.createObjectURL(file)
  gifUrl.value = ''
  previewUrl.value = ''
  videoLoaded.value = false
}

const clearVideo = () => {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  clearGif()
  videoUrl.value = ''
  videoFile.value = undefined
  currentTime.value = 0
  duration.value = 0
  startTime.value = 0
  endTime.value = 0
  videoLoaded.value = false
  previewUrl.value = ''
}

const clearGif = () => {
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
  gifUrl.value = ''
  gifBlob.value = undefined
  gifSize.value = 0
}

const onVideoLoaded = () => {
  if (videoRef.value) {
    duration.value = videoRef.value.duration
    endTime.value = Math.min(duration.value, 5)
    videoLoaded.value = true
  }
}

const onTimeUpdate = () => {
  if (videoRef.value && isPlaying.value) {
    currentTime.value = videoRef.value.currentTime
  }
}

const togglePlay = () => {
  if (!videoRef.value) return
  if (isPlaying.value) {
    videoRef.value.pause()
  } else {
    videoRef.value.play()
  }
  isPlaying.value = !isPlaying.value
}

const seekTo = (time: number) => {
  if (videoRef.value) {
    videoRef.value.currentTime = time
    currentTime.value = time
  }
}

const generatePreview = () => {
  if (!videoRef.value) return
  videoRef.value.currentTime = startTime.value
  
  setTimeout(() => {
    if (videoRef.value) {
      previewUrl.value = captureFrame(videoRef.value, settings.width, outputHeight.value)
    }
  }, 100)
}

const resetSettings = () => {
  settings.width = 480
  settings.fps = 12
  settings.quality = 1
  settings.workers = 4
  settings.dither = false
  settings.repeat = 0
}

const startConvert = async () => {
  if (!videoRef.value || clipDuration.value <= 0) return

  try {
    const blob = await convertVideoToGif(videoRef.value, {
      startTime: startTime.value,
      endTime: endTime.value,
      fps: settings.fps,
      width: settings.width,
      height: outputHeight.value,
      quality: settings.quality,
      workers: settings.workers,
      dither: settings.dither,
      repeat: settings.repeat
    })

    gifBlob.value = blob
    gifSize.value = blob.size
    if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
    gifUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    console.error('转换失败:', error)
  }
}

const downloadGif = () => {
  if (!gifBlob.value) return
  const a = document.createElement('a')
  a.href = gifUrl.value
  a.download = (videoFile.value?.name.replace(/\.[^.]+$/, '') || 'video') + '.gif'
  a.click()
}

onUnmounted(() => {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
})
</script>
