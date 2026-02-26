<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频转 GIF</h1>
      <p class="text-gray-600 dark:text-gray-400 mt-1">将视频片段转换为 GIF 动图</p>
    </div>

    <UAlert
      icon="i-heroicons-exclamation-triangle"
      color="yellow"
      variant="soft"
    >
      <template #title>GIF 文件通常比视频大</template>
      <template #description>
        <div class="text-sm">
          GIF 格式压缩效率远低于视频。建议：<strong>宽度 ≤240px</strong>、<strong>时长 ≤5秒</strong>、<strong>帧率 ≤10fps</strong>
        </div>
      </template>
    </UAlert>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
        </div>
      </UCard>

      <UCard>
        <template #header>
          <span class="font-medium">GIF 设置</span>
        </template>

        <div class="space-y-4">
          <UFormGroup label="输出宽度">
            <div class="flex items-center gap-3">
              <URange v-model="outputWidth" :min="160" :max="640" :step="40" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ outputWidth }}px</UBadge>
            </div>
            <template #hint>
              <span :class="outputWidth > 480 ? 'text-yellow-600' : ''">
                {{ outputWidth > 480 ? '宽度较大，文件可能很大' : '推荐宽度' }}
              </span>
            </template>
          </UFormGroup>

          <UFormGroup label="帧率 (FPS)">
            <div class="flex items-center gap-3">
              <URange v-model="fps" :min="5" :max="20" :step="1" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ fps }} fps</UBadge>
            </div>
            <template #hint>帧率越低文件越小，10-15 fps 通常足够</template>
          </UFormGroup>

          <UFormGroup label="颜色数量">
            <USelectMenu 
              v-model="maxColors" 
              :options="colorOptions"
              value-attribute="value"
              option-attribute="label"
            />
            <template #hint>颜色越少文件越小，GIF 最多 256 色</template>
          </UFormGroup>

          <UFormGroup label="编码质量">
            <USelectMenu 
              v-model="colorQuality" 
              :options="qualityOptions"
              value-attribute="value"
              option-attribute="label"
            />
            <template #hint>影响颜色采样精度，值越小越精细但更慢</template>
          </UFormGroup>

          <UFormGroup label="并行线程数">
            <div class="flex items-center gap-3">
              <URange v-model="workerCount" :min="1" :max="8" :step="1" class="flex-1" />
              <UBadge variant="soft" class="w-16 justify-center">{{ workerCount }} 线程</UBadge>
            </div>
            <template #hint>更多线程可加速处理，但会占用更多内存</template>
          </UFormGroup>

          <UDivider />

          <div class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-500">预估帧数</span>
              <span class="font-medium">{{ estimatedFrames }} 帧</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">预估大小</span>
              <span class="font-medium">{{ estimatedSize }}</span>
            </div>
          </div>

          <UButton
            block
            size="lg"
            :loading="isConverting"
            :disabled="!videoUrl || clipDuration <= 0"
            @click="startConvert"
          >
            <UIcon name="i-heroicons-sparkles" class="w-5 h-5 mr-2" />
            {{ isConverting ? '转换中...' : '开始转换' }}
          </UButton>

          <div v-if="isConverting" class="space-y-2">
            <UProgress :value="progress" :color="progress < 50 ? 'primary' : 'green'" />
            <p class="text-sm text-center text-gray-500">{{ progressText }}</p>
          </div>

          <div v-if="gifUrl" class="space-y-4 pt-4">
            <UDivider label="转换结果" />
            <div class="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 p-2">
              <img :src="gifUrl" class="w-full rounded" alt="Generated GIF" />
            </div>
            <div class="flex items-center justify-between text-sm">
              <span class="text-gray-500">文件大小</span>
              <UBadge :color="gifSize > 5 * 1024 * 1024 ? 'yellow' : 'green'" variant="soft">
                {{ formatFileSize(gifSize) }}
              </UBadge>
            </div>
            <UButton block variant="soft" @click="downloadGif">
              <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4 mr-2" />
              下载 GIF
            </UButton>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import GIF from 'gif.js'

const videoRef = ref<HTMLVideoElement>()
const videoUrl = ref('')
const videoFile = ref<File>()
const videoLoaded = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const isPlaying = ref(false)

const startTime = ref(0)
const endTime = ref(0)

const outputWidth = ref(240)
const fps = ref(8)
const colorQuality = ref(20)
const workerCount = ref(4)
const maxColors = ref(128)

const isConverting = ref(false)
const progress = ref(0)
const progressText = ref('')

const gifUrl = ref('')
const gifBlob = ref<Blob>()
const gifSize = ref(0)

const qualityOptions = [
  { label: '最高质量 (文件大)', value: 1 },
  { label: '较高质量', value: 10 },
  { label: '中等质量 (推荐)', value: 20 },
  { label: '较低质量 (文件小)', value: 30 }
]

const colorOptions = [
  { label: '256 色 (最佳画质)', value: 256 },
  { label: '128 色 (推荐)', value: 128 },
  { label: '64 色 (较小文件)', value: 64 },
  { label: '32 色 (最小文件)', value: 32 }
]

const clipDuration = computed(() => Math.max(0, endTime.value - startTime.value))

const estimatedFrames = computed(() => Math.ceil(clipDuration.value * fps.value))

const estimatedSize = computed(() => {
  const frames = estimatedFrames.value
  const pixels = outputWidth.value * (outputWidth.value * 0.5625)
  const colorFactor = maxColors.value / 256
  const qualityFactor = (30 - colorQuality.value + 10) / 30
  const bytesPerFrame = pixels * 0.5 * colorFactor * qualityFactor
  const totalBytes = frames * bytesPerFrame
  return formatFileSize(totalBytes)
})

const handleVideoFile = (files: File[]) => {
  if (files[0]) loadVideo(files[0])
}

const loadVideo = (file: File) => {
  videoFile.value = file
  videoUrl.value = URL.createObjectURL(file)
  gifUrl.value = ''
  videoLoaded.value = false
}

const clearVideo = () => {
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
  if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
  videoUrl.value = ''
  videoFile.value = undefined
  gifUrl.value = ''
  currentTime.value = 0
  duration.value = 0
  startTime.value = 0
  endTime.value = 0
  videoLoaded.value = false
}

const onVideoLoaded = () => {
  if (videoRef.value) {
    duration.value = videoRef.value.duration
    endTime.value = duration.value
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

const formatTime = (seconds: number): string => {
  if (!seconds || !isFinite(seconds)) return '0:00.0'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

const seekVideo = (video: HTMLVideoElement, time: number): Promise<void> => {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    video.addEventListener('seeked', onSeeked)
    video.currentTime = time
  })
}

const extractFrameToImageData = (
  video: HTMLVideoElement, 
  canvas: HTMLCanvasElement, 
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): ImageData => {
  ctx.drawImage(video, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

const startConvert = async () => {
  if (!videoRef.value || clipDuration.value <= 0) return

  isConverting.value = true
  progress.value = 0
  progressText.value = '准备中...'

  try {
    const video = videoRef.value
    const aspectRatio = video.videoHeight / video.videoWidth
    const outputHeight = Math.round(outputWidth.value * aspectRatio)

    const canvas = document.createElement('canvas')
    canvas.width = outputWidth.value
    canvas.height = outputHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const frameDelay = Math.round(1000 / fps.value)
    const totalFrames = Math.ceil(clipDuration.value * fps.value)

    progressText.value = `提取帧 (0/${totalFrames})`

    const frames: ImageData[] = []
    
    for (let i = 0; i < totalFrames; i++) {
      const time = startTime.value + (i / fps.value)
      if (time > endTime.value) break
      
      await seekVideo(video, time)
      
      const imageData = extractFrameToImageData(video, canvas, ctx, outputWidth.value, outputHeight)
      frames.push(imageData)

      progress.value = Math.round((i / totalFrames) * 50)
      progressText.value = `提取帧 (${i + 1}/${totalFrames})`
    }

    progressText.value = `生成 GIF (${workerCount.value} 线程)...`
    progress.value = 55

    const gif = new GIF({
      workers: workerCount.value,
      quality: colorQuality.value,
      width: outputWidth.value,
      height: outputHeight,
      workerScript: '/gif.worker.js',
      dither: maxColors.value < 128 ? 'FloydSteinberg' : false
    })

    for (const frame of frames) {
      gif.addFrame(frame, { delay: frameDelay, transparent: null })
    }

    gif.on('progress', (p: number) => {
      progress.value = 55 + Math.round(p * 45)
    })

    const blob = await new Promise<Blob>((resolve) => {
      gif.on('finished', (blob: Blob) => resolve(blob))
      gif.render()
    })

    gifBlob.value = blob
    gifSize.value = blob.size
    if (gifUrl.value) URL.revokeObjectURL(gifUrl.value)
    gifUrl.value = URL.createObjectURL(blob)

    progress.value = 100
    progressText.value = '完成!'
  } catch (error) {
    console.error('转换失败:', error)
    progressText.value = '转换失败: ' + (error instanceof Error ? error.message : '未知错误')
  } finally {
    isConverting.value = false
  }
}

const downloadGif = () => {
  if (!gifBlob.value) return
  const a = document.createElement('a')
  a.href = gifUrl.value
  a.download = (videoFile.value?.name.replace(/\.[^.]+$/, '') || 'video') + '.gif'
  a.click()
}
</script>
