<template>
  <div
    class="border-2 border-dashed rounded-xl p-6 text-center transition-all duration-200 cursor-pointer"
    :class="[
      isDragging 
        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 scale-[1.02]' 
        : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
    ]"
    @dragover.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="handleDrop"
    @click="triggerFileInput"
  >
    <UIcon :name="icon" class="w-10 h-10 mx-auto text-gray-400 mb-2" />
    <p class="text-gray-600 dark:text-gray-400 mb-2 text-sm">
      拖拽文件到此处，或点击选择
    </p>
    <UBadge color="gray" variant="soft" size="xs">
      {{ acceptText }}
    </UBadge>
    <input
      ref="fileInput"
      type="file"
      :multiple="multiple"
      :accept="accept"
      class="hidden"
      @change="handleFileSelect"
    />
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  accept?: string
  acceptText?: string
  multiple?: boolean
  icon?: string
}>(), {
  accept: '*/*',
  acceptText: '所有文件',
  multiple: true,
  icon: 'i-heroicons-cloud-arrow-up'
})

const emit = defineEmits<{
  files: [files: File[]]
}>()

const fileInput = ref<HTMLInputElement>()
const isDragging = ref(false)

const triggerFileInput = () => fileInput.value?.click()

const handleFileSelect = (e: Event) => {
  const input = e.target as HTMLInputElement
  if (input.files?.length) {
    emit('files', Array.from(input.files))
    input.value = ''
  }
}

const handleDrop = (e: DragEvent) => {
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (files?.length) {
    const acceptTypes = props.accept.split(',').map(t => t.trim())
    const filtered = Array.from(files).filter(f => {
      if (props.accept === '*/*') return true
      return acceptTypes.some(type => {
        if (type.endsWith('/*')) {
          return f.type.startsWith(type.replace('/*', '/'))
        }
        return f.type === type || f.name.endsWith(type.replace('*', ''))
      })
    })
    if (filtered.length) {
      emit('files', filtered)
    }
  }
}
</script>
