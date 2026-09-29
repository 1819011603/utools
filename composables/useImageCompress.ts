/**
 * 图片压缩页面逻辑（从 `pages/image-compress.vue` 下沉，纯搬运、行为不变）。
 *
 * 队列并发调度、对比弹窗拖拽、选项变更后的重处理都收在这里；页面只做装配。
 */
import type { ProcessItem } from '~/composables/useMediaProcess'

interface CompareItem extends ProcessItem {
  originalPreviewUrl?: string
  imageWidth?: number
  imageHeight?: number
}

export function useImageCompress() {
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

  const quality = ref(85)
  const maxWidth = ref<number | undefined>()
  const outputFormat = ref('image/jpeg')
  const maxConcurrent = ref(4)
  const selectedItem = ref<CompareItem | null>(null)
  const showCompareModal = ref(false)
  const comparePosition = ref(50)
  const imageLoaded = ref(false)

  const compareContainerStyle = computed(() => {
    if (!selectedItem.value?.imageWidth || !selectedItem.value?.imageHeight) {
      return { aspectRatio: '16/10', maxHeight: '70vh' }
    }
    const ratio = selectedItem.value.imageWidth / selectedItem.value.imageHeight
    return {
      aspectRatio: `${ratio}`,
      maxHeight: '75vh',
      maxWidth: '100%'
    }
  })

  const formatOptions = [
    { label: 'JPEG (推荐)', value: 'image/jpeg' },
    { label: 'WebP (更小)', value: 'image/webp' },
    { label: 'PNG', value: 'image/png' },
    { label: 'PDF', value: 'application/pdf' }
  ]

  const { isTiff, createTiffPreview } = useTiffProcessor()

  const isPdfOutput = computed(() => outputFormat.value === 'application/pdf')

  const { compressImage, getCompressionRate } = useImageProcessor({ updateItem, quality, maxWidth, outputFormat })

  let previousQuality = 85

  watch(outputFormat, (newFormat, oldFormat) => {
    if (newFormat === 'application/pdf' && oldFormat !== 'application/pdf') {
      previousQuality = quality.value
      quality.value = 100
    } else if (newFormat !== 'application/pdf' && oldFormat === 'application/pdf') {
      quality.value = previousQuality
    }
  })

  const qualityColor = computed(() => {
    if (quality.value >= 80) return 'green'
    if (quality.value >= 50) return 'yellow'
    return 'red'
  })

  const processingQueue: ProcessItem[] = []
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
    const imageFiles = Array.from(files).filter(f =>
      f.type.startsWith('image/') || isTiff(f)
    )

    for (const file of imageFiles) {
      const item = addItem(file)
      if (isTiff(file)) {
        try {
          item.preview = await createTiffPreview(file)
        } catch {
          item.preview = await createPreview(file)
        }
      } else {
        item.preview = await createPreview(file)
      }
      processingQueue.push(item)
    }

    const startCount = Math.min(maxConcurrent.value, processingQueue.length)
    for (let i = 0; i < startCount; i++) {
      processNext()
    }
  }

  const reprocess = (item: ProcessItem) => {
    if (item.processedPreview) {
      URL.revokeObjectURL(item.processedPreview)
    }
    const meta = item.meta as { originalPreviewUrl?: string } | undefined
    if (meta?.originalPreviewUrl && meta.originalPreviewUrl !== item.preview) {
      URL.revokeObjectURL(meta.originalPreviewUrl)
    }
    updateItem(item.id, { status: 'pending', processedBlob: undefined, processedSize: undefined, processedPreview: undefined, meta: undefined })
    processingQueue.push(item)
    processNext()
  }

  const selectItem = async (item: ProcessItem) => {
    if (item.status === 'completed' && item.processedPreview) {
      const meta = item.meta as { originalPreviewUrl?: string } | undefined
      const previewUrl = meta?.originalPreviewUrl || item.preview || ''

      imageLoaded.value = false

      const dimensions = await getImageDimensions(previewUrl)

      selectedItem.value = {
        ...item,
        originalPreviewUrl: previewUrl,
        imageWidth: dimensions.width,
        imageHeight: dimensions.height
      }
      showCompareModal.value = true
    }
  }

  const getImageDimensions = (src: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve({ width: 16, height: 10 })
      img.src = src
    })
  }

  const onImageLoad = () => {
    imageLoaded.value = true
  }

  const compareContainer = ref<HTMLElement>()
  let isDragging = false

  const updateComparePosition = (clientX: number) => {
    if (!compareContainer.value) return
    const rect = compareContainer.value.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    comparePosition.value = Math.round((x / rect.width) * 100)
  }

  const startDrag = (e: MouseEvent) => {
    isDragging = true
    updateComparePosition(e.clientX)
  }

  const onDrag = (e: MouseEvent) => {
    if (!isDragging) return
    e.preventDefault()
    updateComparePosition(e.clientX)
  }

  const startTouchDrag = (e: TouchEvent) => {
    isDragging = true
    if (e.touches.length > 0) {
      updateComparePosition(e.touches[0].clientX)
    }
  }

  const onTouchDrag = (e: TouchEvent) => {
    if (!isDragging) return
    if (e.touches.length > 0) {
      updateComparePosition(e.touches[0].clientX)
    }
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

  return {
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
    formatSize,
    quality,
    maxWidth,
    outputFormat,
    maxConcurrent,
    selectedItem,
    showCompareModal,
    comparePosition,
    imageLoaded,
    compareContainerStyle,
    formatOptions,
    isPdfOutput,
    getCompressionRate,
    qualityColor,
    handleFiles,
    reprocess,
    selectItem,
    onImageLoad,
    compareContainer,
    startDrag,
    onDrag,
    startTouchDrag,
    onTouchDrag,
    stopDrag
  }
}
