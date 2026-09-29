/**
 * 音频格式转换页面逻辑（从 `pages/audio-convert.vue` 下沉，纯搬运、行为不变）。
 */
interface AudioMeta {
  duration: number
}

export function useAudioConvert() {
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
    formatSize
  } = useMediaProcess<AudioMeta>()

  const audioPlayer = ref<HTMLAudioElement>()
  const sampleRate = ref(44100)
  const bitDepth = ref(16)

  const sampleRateOptions = [
    { label: '22050 Hz (较小)', value: 22050 },
    { label: '44100 Hz (CD质量)', value: 44100 },
    { label: '48000 Hz (高质量)', value: 48000 }
  ]

  const bitDepthOptions = [
    { label: '16 bit (推荐)', value: 16 },
    { label: '8 bit (较小)', value: 8 }
  ]

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('audio/')) continue

      const item = addItem(file)

      const duration = await getAudioDuration(file)
      updateItem(item.id, { meta: { duration } })

      convertAudio(item)
    }
  }

  const getAudioDuration = (file: File): Promise<number> => {
    return new Promise(resolve => {
      const audio = new Audio()
      audio.onloadedmetadata = () => {
        resolve(audio.duration)
        URL.revokeObjectURL(audio.src)
      }
      audio.onerror = () => resolve(0)
      audio.src = URL.createObjectURL(file)
    })
  }

  const convertAudio = async (item: typeof items.value[0]) => {
    updateItem(item.id, { status: 'processing', progress: 0 })

    try {
      const audioContext = new AudioContext()

      updateItem(item.id, { progress: 10 })

      const arrayBuffer = await item.file.arrayBuffer()
      updateItem(item.id, { progress: 30 })

      let audioBuffer: AudioBuffer
      try {
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
      } catch (e) {
        throw new Error('无法解码音频文件，格式可能不支持')
      }
      updateItem(item.id, { progress: 50 })

      const resampledBuffer = await resampleAudio(audioContext, audioBuffer, sampleRate.value)
      const convertedBlob = audioBufferToWav(resampledBuffer, bitDepth.value)
      updateItem(item.id, { progress: 90 })

      updateItem(item.id, {
        processedBlob: convertedBlob,
        processedSize: convertedBlob.size,
        status: 'completed',
        progress: 100
      })

      audioContext.close()
    } catch (error) {
      console.error('转换失败:', error)
      updateItem(item.id, {
        status: 'error',
        error: error instanceof Error ? error.message : '转换失败'
      })
    }
  }

  const resampleAudio = async (context: AudioContext, buffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> => {
    if (buffer.sampleRate === targetSampleRate) {
      return buffer
    }

    const offlineContext = new OfflineAudioContext(
      buffer.numberOfChannels,
      Math.ceil(buffer.duration * targetSampleRate),
      targetSampleRate
    )

    const source = offlineContext.createBufferSource()
    source.buffer = buffer
    source.connect(offlineContext.destination)
    source.start()

    return await offlineContext.startRendering()
  }

  const audioBufferToWav = (buffer: AudioBuffer, targetBitDepth: number = 16): Blob => {
    const numChannels = Math.min(buffer.numberOfChannels, 2)
    const bufferSampleRate = buffer.sampleRate
    const format = 1

    const bytesPerSample = targetBitDepth / 8
    const blockAlign = numChannels * bytesPerSample

    const dataLength = buffer.length * blockAlign
    const wavBuffer = new ArrayBuffer(44 + dataLength)
    const view = new DataView(wavBuffer)

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i))
      }
    }

    writeString(0, 'RIFF')
    view.setUint32(4, 36 + dataLength, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, format, true)
    view.setUint16(22, numChannels, true)
    view.setUint32(24, bufferSampleRate, true)
    view.setUint32(28, bufferSampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, targetBitDepth, true)
    writeString(36, 'data')
    view.setUint32(40, dataLength, true)

    const channels: Float32Array[] = []
    for (let i = 0; i < numChannels; i++) {
      channels.push(buffer.getChannelData(i))
    }

    let offset = 44

    if (targetBitDepth === 8) {
      for (let i = 0; i < buffer.length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = Math.max(-1, Math.min(1, channels[ch][i]))
          const uint8 = Math.round((sample + 1) * 127.5)
          view.setUint8(offset, uint8)
          offset += 1
        }
      }
    } else {
      for (let i = 0; i < buffer.length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = Math.max(-1, Math.min(1, channels[ch][i]))
          const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff
          view.setInt16(offset, int16, true)
          offset += 2
        }
      }
    }

    return new Blob([wavBuffer], { type: 'audio/wav' })
  }

  const retryConvert = (item: typeof items.value[0]) => {
    convertAudio(item)
  }

  const playAudio = (item: typeof items.value[0]) => {
    if (!item.processedBlob || !audioPlayer.value) return

    const url = URL.createObjectURL(item.processedBlob)
    audioPlayer.value.src = url
    audioPlayer.value.play()
  }

  const formatDuration = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return ''
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const getFormatLabel = (type: string): string => {
    const map: Record<string, string> = {
      'audio/wav': 'WAV',
      'audio/mpeg': 'MP3',
      'audio/mp3': 'MP3',
      'audio/ogg': 'OGG',
      'audio/webm': 'WebM',
      'audio/aac': 'AAC',
      'audio/mp4': 'M4A',
      'audio/x-m4a': 'M4A',
      'audio/flac': 'FLAC',
      'audio/x-flac': 'FLAC'
    }
    return map[type] || type.split('/')[1]?.toUpperCase() || '未知'
  }

  const getStatusBgColor = (status: string): string => {
    switch (status) {
      case 'processing': return 'bg-yellow-100 dark:bg-yellow-900/30'
      case 'completed': return 'bg-green-100 dark:bg-green-900/30'
      case 'error': return 'bg-red-100 dark:bg-red-900/30'
      default: return 'bg-violet-100 dark:bg-violet-900/30'
    }
  }

  const getProgressText = (progress: number): string => {
    if (progress < 30) return '读取文件...'
    if (progress < 50) return '解码音频...'
    if (progress < 90) return '转换格式...'
    return '完成中...'
  }

  watch([sampleRate, bitDepth], () => {
    items.value.forEach(item => {
      if (item.status === 'completed' || item.status === 'error') {
        convertAudio(item)
      }
    })
  })

  return {
    items,
    completedItems,
    hasCompleted,
    addItem,
    updateItem,
    removeItem,
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
    playAudio,
    formatDuration,
    getFormatLabel,
    getStatusBgColor,
    getProgressText
  }
}
