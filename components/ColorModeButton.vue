<template>
  <UButton
    :icon="isDark ? 'i-heroicons-moon' : 'i-heroicons-sun'"
    variant="ghost"
    color="gray"
    @click="toggleColorMode"
  />
</template>

<script setup lang="ts">
const colorMode = useColorMode()

const isDark = computed(() => colorMode.value === 'dark')

const toggleColorMode = () => {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>
