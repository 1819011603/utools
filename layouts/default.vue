<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between items-center h-16">
          <NuxtLink to="/" class="flex items-center space-x-2">
            <UIcon name="i-heroicons-wrench-screwdriver" class="w-8 h-8 text-primary-500" />
            <span class="text-xl font-bold text-gray-900 dark:text-white">开发工具箱</span>
          </NuxtLink>
          
          <nav class="hidden md:flex space-x-1">
            <UButton
              v-for="tool in tools"
              :key="tool.path"
              :to="tool.path"
              variant="ghost"
              :color="isActive(tool.path) ? 'primary' : 'gray'"
              size="sm"
            >
              <UIcon :name="tool.icon" class="w-4 h-4 mr-1" />
              {{ tool.name }}
            </UButton>
          </nav>

          <div class="flex items-center space-x-2">
            <ColorModeButton />
            <UButton
              class="md:hidden"
              variant="ghost"
              icon="i-heroicons-bars-3"
              @click="mobileMenuOpen = true"
            />
          </div>
        </div>
      </div>
    </header>

    <USlideover v-model="mobileMenuOpen" side="right">
      <div class="p-4">
        <div class="flex justify-between items-center mb-6">
          <span class="text-lg font-semibold">工具列表</span>
          <UButton
            variant="ghost"
            icon="i-heroicons-x-mark"
            @click="mobileMenuOpen = false"
          />
        </div>
        <nav class="space-y-2">
          <UButton
            v-for="tool in tools"
            :key="tool.path"
            :to="tool.path"
            variant="ghost"
            :color="isActive(tool.path) ? 'primary' : 'gray'"
            block
            @click="mobileMenuOpen = false"
          >
            <UIcon :name="tool.icon" class="w-4 h-4 mr-2" />
            {{ tool.name }}
          </UButton>
        </nav>
      </div>
    </USlideover>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <slot />
    </main>

    <footer class="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-auto">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <p class="text-center text-gray-500 dark:text-gray-400 text-sm">
          开发工具箱 - 提升开发效率
        </p>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const mobileMenuOpen = ref(false)

const tools = [
  { name: 'JSON格式化', path: '/json-format', icon: 'i-heroicons-code-bracket' },
  { name: 'JSON对比', path: '/json-diff', icon: 'i-heroicons-scale' },
  { name: '时间戳', path: '/timestamp', icon: 'i-heroicons-clock' },
  { name: 'JSON提取', path: '/json-extract', icon: 'i-heroicons-funnel' },
  { name: '内容对比', path: '/content-diff', icon: 'i-heroicons-arrows-right-left' },
]

const isActive = (path: string) => route.path === path
</script>
