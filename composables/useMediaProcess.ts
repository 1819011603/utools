import JSZip from 'jszip'

export type ProcessStatus = 'pending' | 'processing' | 'completed' | 'error'

export interface ProcessItem<T = unknown> {
  id: string
  file: File
  name: string
  originalSize: number
  processedSize?: number
  processedBlob?: Blob
  preview?: string
  processedPreview?: string
  status: ProcessStatus
  progress: number
  error?: string
  meta?: T
}

export function useMediaProcess<T = unknown>() {
  const items = ref<ProcessItem<T>[]>([])

  const pendingItems = computed(() => items.value.filter(i => i.status === 'pending'))
  const processingItems = computed(() => items.value.filter(i => i.status === 'processing'))
  const completedItems = computed(() => items.value.filter(i => i.status === 'completed'))
  const hasCompleted = computed(() => completedItems.value.length > 0)

  const totalOriginalSize = computed(() => items.value.reduce((sum, i) => sum + i.originalSize, 0))
  const totalProcessedSize = computed(() => completedItems.value.reduce((sum, i) => sum + (i.processedSize || 0), 0))
  const savedSize = computed(() => totalOriginalSize.value - totalProcessedSize.value)
  const savedPercent = computed(() => {
    if (totalOriginalSize.value === 0) return 0
    return Math.round((savedSize.value / totalOriginalSize.value) * 100)
  })

  const addItem = (file: File, meta?: T): ProcessItem<T> => {
    const item: ProcessItem<T> = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name,
      originalSize: file.size,
      status: 'pending',
      progress: 0,
      meta
    }
    items.value.push(item)
    return item
  }

  const updateItem = (id: string, updates: Partial<ProcessItem<T>>) => {
    const index = items.value.findIndex(i => i.id === id)
    if (index !== -1) {
      items.value[index] = { ...items.value[index], ...updates }
    }
  }

  const removeItem = (id: string) => {
    const index = items.value.findIndex(i => i.id === id)
    if (index !== -1) {
      const item = items.value[index]
      if (item.preview) URL.revokeObjectURL(item.preview)
      if (item.processedPreview) URL.revokeObjectURL(item.processedPreview)
      items.value.splice(index, 1)
    }
  }

  const clearAll = () => {
    items.value.forEach(item => {
      if (item.preview) URL.revokeObjectURL(item.preview)
      if (item.processedPreview) URL.revokeObjectURL(item.processedPreview)
    })
    items.value = []
  }

  const downloadItem = (item: ProcessItem<T>, suffix = '_processed') => {
    if (!item.processedBlob) return
    const url = URL.createObjectURL(item.processedBlob)
    const a = document.createElement('a')
    a.href = url
    const ext = item.processedBlob.type.split('/')[1] || item.name.split('.').pop() || ''
    const baseName = item.name.replace(/\.[^.]+$/, '')
    a.download = `${baseName}${suffix}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadAllAsZip = async (zipName = 'files.zip', suffix = '_processed') => {
    if (!hasCompleted.value) return

    const zip = new JSZip()
    
    for (const item of completedItems.value) {
      if (item.processedBlob) {
        const ext = item.processedBlob.type.split('/')[1] || item.name.split('.').pop() || ''
        const baseName = item.name.replace(/\.[^.]+$/, '')
        zip.file(`${baseName}${suffix}.${ext}`, item.processedBlob)
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = zipName
    a.click()
    URL.revokeObjectURL(url)
  }

  const createPreview = (file: File): Promise<string> => {
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target?.result as string)
      reader.readAsDataURL(file)
    })
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  return {
    items,
    pendingItems,
    processingItems,
    completedItems,
    hasCompleted,
    totalOriginalSize,
    totalProcessedSize,
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
  }
}
