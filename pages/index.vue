<template>
  <div>
    <div class="text-center mb-12">
      <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
        开发工具箱
      </h1>
      <p class="text-lg text-gray-600 dark:text-gray-300">
        常用开发工具集合，提升日常开发效率
      </p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <NuxtLink
        v-for="tool in tools"
        :key="tool.path"
        :to="tool.path"
        class="block"
      >
        <UCard class="h-full hover:shadow-lg transition-shadow cursor-pointer hover:ring-2 hover:ring-primary-500">
          <template #header>
            <div class="flex items-center space-x-3">
              <div class="p-2 rounded-lg" :class="tool.bgColor">
                <UIcon :name="tool.icon" class="w-6 h-6" :class="tool.iconColor" />
              </div>
              <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ tool.name }}
              </h2>
            </div>
          </template>
          <p class="text-gray-600 dark:text-gray-300">
            {{ tool.description }}
          </p>
          <template #footer>
            <div class="flex items-center text-primary-500 font-medium text-sm">
              使用工具
              <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 ml-1" />
            </div>
          </template>
        </UCard>
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
const tools = [
  {
    name: 'JSON 格式化',
    path: '/json-format',
    icon: 'i-heroicons-code-bracket',
    description: '格式化、压缩 JSON 数据，支持语法高亮和错误检测',
    bgColor: 'bg-blue-100 dark:bg-blue-900',
    iconColor: 'text-blue-600 dark:text-blue-400'
  },
  {
    name: 'JSON 对比',
    path: '/json-diff',
    icon: 'i-heroicons-scale',
    description: '对比两个 JSON 数据的差异，支持指定字段匹配进行对比',
    bgColor: 'bg-green-100 dark:bg-green-900',
    iconColor: 'text-green-600 dark:text-green-400'
  },
  {
    name: '时间戳转换',
    path: '/timestamp',
    icon: 'i-heroicons-clock',
    description: '时间戳与日期时间互转，支持多种格式和时区',
    bgColor: 'bg-purple-100 dark:bg-purple-900',
    iconColor: 'text-purple-600 dark:text-purple-400'
  },
  {
    name: 'JSON 字段提取',
    path: '/json-extract',
    icon: 'i-heroicons-funnel',
    description: '使用 JQ 语法提取 JSON 字段，支持排序、去重等操作',
    bgColor: 'bg-orange-100 dark:bg-orange-900',
    iconColor: 'text-orange-600 dark:text-orange-400'
  },
  {
    name: '内容对比',
    path: '/content-diff',
    icon: 'i-heroicons-arrows-right-left',
    description: '文本内容集合操作，支持交集、并集、差集等',
    bgColor: 'bg-pink-100 dark:bg-pink-900',
    iconColor: 'text-pink-600 dark:text-pink-400'
  }
]
</script>
