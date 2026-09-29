/**
 * 视频转 GIF 页面逻辑（从 `pages/video-to-gif.vue` 下沉，纯搬运、行为不变）。
 */
import {
  useGifEncoder,
  DITHER_OPTIONS,
  QUALITY_OPTIONS,
  REPEAT_OPTIONS,
  type DitherType
} from '~/composables/useGifEncoder'

export function useVideoToGif() {
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

  return {
    videoRef,
    videoUrl,
    videoFile,
    videoLoaded,
    duration,
    currentTime,
    isPlaying,
    startTime,
    endTime,
    settings,
    previewUrl,
    gifUrl,
    gifBlob,
    gifSize,
    clipDuration,
    estimatedFrames,
    outputHeight,
    estimatedBytes,
    isEncoding,
    progress,
    handleVideoFile,
    loadVideo,
    clearVideo,
    clearGif,
    onVideoLoaded,
    onTimeUpdate,
    togglePlay,
    seekTo,
    generatePreview,
    resetSettings,
    startConvert,
    downloadGif,
    formatFileSize,
    formatTime,
    QUALITY_OPTIONS,
    DITHER_OPTIONS,
    REPEAT_OPTIONS
  }
}
