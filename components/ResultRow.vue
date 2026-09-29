<template>
  <div class="flex items-center justify-between p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
    <span class="text-sm text-gray-600 dark:text-gray-400 min-w-[100px]">{{ label }}</span>
    <div class="flex items-center gap-3">
      <span
        class="font-mono text-lg"
        :class="highlight
          ? 'text-primary-600 dark:text-primary-400 font-semibold'
          : 'text-gray-900 dark:text-white'"
      >{{ value }}</span>
      <UButton
        variant="ghost"
        size="sm"
        @click="copyValue"
      >
        <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4" />
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps({
  label: { type: String, required: true },
  value: { type: String, required: true },
  highlight: { type: Boolean, default: false }
})

const copyValue = async () => {
  await navigator.clipboard.writeText(props.value)
  useToast().add({ title: '已复制', color: 'green' })
}
</script>
