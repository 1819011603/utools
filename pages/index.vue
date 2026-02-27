<template>
  <div>
    <div class="text-center mb-10">
      <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-3">
        开发工具箱
      </h1>
      <p class="text-lg text-gray-600 dark:text-gray-300">
        常用开发工具集合，提升日常开发效率
      </p>
    </div>

    <div class="space-y-8">
      <div v-for="category in categories" :key="category.name">
        <UAccordion :items="[{ label: category.name, icon: category.icon, defaultOpen: category.defaultOpen }]" variant="soft">
          <template #default="{ item, open }">
            <UButton
              color="gray"
              variant="ghost"
              class="w-full"
              :ui="{ padding: { sm: 'p-3' } }"
            >
              <template #leading>
                <div class="p-1.5 rounded-lg" :class="category.bgColor">
                  <UIcon :name="category.icon" class="w-5 h-5" :class="category.iconColor" />
                </div>
              </template>
              <span class="text-base font-semibold">{{ category.name }}</span>
              <span class="ml-2 text-sm text-gray-500 dark:text-gray-400">({{ category.tools.length }})</span>
              <template #trailing>
                <UIcon
                  name="i-heroicons-chevron-down-20-solid"
                  class="w-5 h-5 transform transition-transform duration-200"
                  :class="{ 'rotate-180': open }"
                />
              </template>
            </UButton>
          </template>
          <template #item>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2 pb-4 px-1">
              <NuxtLink
                v-for="tool in category.tools"
                :key="tool.path"
                :to="tool.path"
                class="block"
              >
                <UCard
                  class="h-full hover:shadow-md transition-all cursor-pointer hover:ring-2 hover:ring-primary-500/50 hover:-translate-y-0.5"
                  :ui="{ body: { padding: 'p-4' } }"
                >
                  <div class="flex items-start space-x-3">
                    <div class="p-2 rounded-lg shrink-0" :class="tool.bgColor">
                      <UIcon :name="tool.icon" class="w-5 h-5" :class="tool.iconColor" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        {{ tool.name }}
                      </h3>
                      <p class="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                        {{ tool.description }}
                      </p>
                    </div>
                    <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 text-gray-400 shrink-0 mt-1" />
                  </div>
                </UCard>
              </NuxtLink>
            </div>
          </template>
        </UAccordion>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Tool {
  name: string
  path: string
  icon: string
  description: string
  bgColor: string
  iconColor: string
}

interface Category {
  name: string
  icon: string
  bgColor: string
  iconColor: string
  defaultOpen: boolean
  tools: Tool[]
}

const categories: Category[] = [
  {
    name: 'PDF 工具',
    icon: 'i-heroicons-document',
    bgColor: 'bg-red-100 dark:bg-red-900/50',
    iconColor: 'text-red-600 dark:text-red-400',
    defaultOpen: true,
    tools: [
      {
        name: 'PDF 工具箱',
        path: '/pdf-tools',
        icon: 'i-heroicons-document-duplicate',
        description: 'PDF 合并、拆分、压缩、加水印、格式转换等',
        bgColor: 'bg-red-100 dark:bg-red-900/50',
        iconColor: 'text-red-600 dark:text-red-400'
      }
    ]
  },
  {
    name: '媒体处理',
    icon: 'i-heroicons-photo',
    bgColor: 'bg-rose-100 dark:bg-rose-900/50',
    iconColor: 'text-rose-600 dark:text-rose-400',
    defaultOpen: true,
    tools: [
      {
        name: '图片压缩',
        path: '/image-compress',
        icon: 'i-heroicons-arrow-down-tray',
        description: '在线压缩图片大小，支持 PNG、JPG、WebP 等格式',
        bgColor: 'bg-rose-100 dark:bg-rose-900/50',
        iconColor: 'text-rose-600 dark:text-rose-400'
      },
      {
        name: '图片格式转换',
        path: '/image-convert',
        icon: 'i-heroicons-arrows-right-left',
        description: '图片格式互转，支持 PNG、JPG、WebP、GIF 等',
        bgColor: 'bg-pink-100 dark:bg-pink-900/50',
        iconColor: 'text-pink-600 dark:text-pink-400'
      },
      {
        name: '视频转 GIF',
        path: '/video-to-gif',
        icon: 'i-heroicons-film',
        description: '将视频转换为 GIF 动图，支持裁剪和调整帧率',
        bgColor: 'bg-purple-100 dark:bg-purple-900/50',
        iconColor: 'text-purple-600 dark:text-purple-400'
      },
      {
        name: '音频格式转换',
        path: '/audio-convert',
        icon: 'i-heroicons-musical-note',
        description: '音频格式互转，支持 MP3、WAV、AAC、OGG 等',
        bgColor: 'bg-violet-100 dark:bg-violet-900/50',
        iconColor: 'text-violet-600 dark:text-violet-400'
      }
    ]
  },
  {
    name: 'JSON 工具',
    icon: 'i-heroicons-code-bracket',
    bgColor: 'bg-blue-100 dark:bg-blue-900/50',
    iconColor: 'text-blue-600 dark:text-blue-400',
    defaultOpen: true,
    tools: [
      {
        name: 'JSON 格式化',
        path: '/json-format',
        icon: 'i-heroicons-code-bracket',
        description: '格式化、压缩 JSON 数据，支持语法高亮和错误检测',
        bgColor: 'bg-blue-100 dark:bg-blue-900/50',
        iconColor: 'text-blue-600 dark:text-blue-400'
      },
      {
        name: 'JSON 对比',
        path: '/json-diff',
        icon: 'i-heroicons-scale',
        description: '对比两个 JSON 数据的差异，支持指定字段匹配进行对比',
        bgColor: 'bg-cyan-100 dark:bg-cyan-900/50',
        iconColor: 'text-cyan-600 dark:text-cyan-400'
      },
      {
        name: 'JSON 字段提取',
        path: '/json-extract',
        icon: 'i-heroicons-funnel',
        description: '使用 JQ 语法提取 JSON 字段，支持排序、去重等操作',
        bgColor: 'bg-teal-100 dark:bg-teal-900/50',
        iconColor: 'text-teal-600 dark:text-teal-400'
      }
    ]
  },
  {
    name: '其他工具',
    icon: 'i-heroicons-wrench-screwdriver',
    bgColor: 'bg-amber-100 dark:bg-amber-900/50',
    iconColor: 'text-amber-600 dark:text-amber-400',
    defaultOpen: true,
    tools: [
      {
        name: '时间戳转换',
        path: '/timestamp',
        icon: 'i-heroicons-clock',
        description: '时间戳与日期时间互转，支持多种格式和时区',
        bgColor: 'bg-amber-100 dark:bg-amber-900/50',
        iconColor: 'text-amber-600 dark:text-amber-400'
      },
      {
        name: '内容对比',
        path: '/content-diff',
        icon: 'i-heroicons-document-duplicate',
        description: '文本内容集合操作，支持交集、并集、差集等',
        bgColor: 'bg-orange-100 dark:bg-orange-900/50',
        iconColor: 'text-orange-600 dark:text-orange-400'
      }
    ]
  }
]
</script>
