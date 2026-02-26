<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
    <header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between items-center h-16">
          <NuxtLink to="/" class="flex items-center space-x-2">
            <UIcon name="i-heroicons-wrench-screwdriver" class="w-8 h-8 text-primary-500" />
            <span class="text-xl font-bold text-gray-900 dark:text-white">开发工具箱</span>
          </NuxtLink>
          
          <nav class="hidden md:flex items-center space-x-1">
            <UDropdown
              v-for="category in toolCategories"
              :key="category.name"
              :items="[category.tools.map(t => ({ ...t, click: () => navigateTo(t.path) }))]"
              :popper="{ placement: 'bottom-start' }"
            >
              <UButton
                variant="ghost"
                :color="isCategoryActive(category) ? 'primary' : 'gray'"
                size="sm"
                trailing-icon="i-heroicons-chevron-down-20-solid"
              >
                <UIcon :name="category.icon" class="w-4 h-4 mr-1" />
                {{ category.name }}
              </UButton>
              <template #item="{ item }">
                <div class="flex items-center gap-2">
                  <UIcon :name="item.icon" class="w-4 h-4 shrink-0" />
                  <span>{{ item.label }}</span>
                </div>
              </template>
            </UDropdown>
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
        <nav class="space-y-4">
          <div v-for="category in toolCategories" :key="category.name">
            <div class="flex items-center gap-2 mb-2 px-2">
              <UIcon :name="category.icon" class="w-4 h-4 text-gray-500" />
              <span class="text-sm font-medium text-gray-500">{{ category.name }}</span>
            </div>
            <div class="space-y-1">
              <UButton
                v-for="tool in category.tools"
                :key="tool.path"
                :to="tool.path"
                variant="ghost"
                :color="isActive(tool.path) ? 'primary' : 'gray'"
                block
                @click="mobileMenuOpen = false"
              >
                <UIcon :name="tool.icon" class="w-4 h-4 mr-2" />
                {{ tool.label }}
              </UButton>
            </div>
          </div>
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
interface Tool {
  label: string
  path: string
  icon: string
}

interface Category {
  name: string
  icon: string
  tools: Tool[]
}

const route = useRoute()
const mobileMenuOpen = ref(false)

const toolCategories: Category[] = [
  {
    name: '媒体处理',
    icon: 'i-heroicons-photo',
    tools: [
      { label: '图片压缩', path: '/image-compress', icon: 'i-heroicons-arrow-down-tray' },
      { label: '图片格式转换', path: '/image-convert', icon: 'i-heroicons-arrows-right-left' },
      { label: '视频转GIF', path: '/video-to-gif', icon: 'i-heroicons-film' },
      { label: '音频格式转换', path: '/audio-convert', icon: 'i-heroicons-musical-note' }
    ]
  },
  {
    name: 'JSON 工具',
    icon: 'i-heroicons-code-bracket',
    tools: [
      { label: 'JSON 格式化', path: '/json-format', icon: 'i-heroicons-code-bracket' },
      { label: 'JSON 对比', path: '/json-diff', icon: 'i-heroicons-scale' },
      { label: 'JSON 字段提取', path: '/json-extract', icon: 'i-heroicons-funnel' }
    ]
  },
  {
    name: '其他工具',
    icon: 'i-heroicons-wrench-screwdriver',
    tools: [
      { label: '时间戳转换', path: '/timestamp', icon: 'i-heroicons-clock' },
      { label: '内容对比', path: '/content-diff', icon: 'i-heroicons-document-duplicate' }
    ]
  }
]

const isActive = (path: string) => route.path === path

const isCategoryActive = (category: Category) => {
  return category.tools.some(tool => route.path === tool.path)
}
</script>
