<template>
  <!--
    氛围靠**底色和留白**，不靠把颜色调重：整页一层极淡的玫瑰→薰衣草渐变（透明度都在 10% 以下），
    暗色下换成带紫调的深夜色。控件本身仍是中性灰，否则一屏粉红就俗了。
  -->
  <!--
    overflow-x-clip 挂在**根**上，不能挂在 <main>：放映厅的播放器要横向铺满视口
    （`w-screen` + 居中位移突破 main 的 max-w 和 padding），挂在 main 上等于把想溢出的那块
    又裁回容器宽度，铺满当场失效。挂在根上只裁掉「100vw 比可用宽度多出来的滚动条宽度」，
    否则桌面上会顶出一条横向滚动条。
    用 clip 而不是 hidden：后者会给自己建滚动容器，把 header 的 sticky 废掉。
  -->
  <div class="min-h-screen overflow-x-clip bg-gradient-to-b from-rose-50/70 via-white to-violet-50/60
              dark:from-[#1a1520] dark:via-[#141119] dark:to-[#16121d]">
    <!-- /video-search 自己有一套「站点按钮 + 结果」的紧凑版式，顶部品牌栏在这一页纯属占地方
         （屏幕就那么高，多留一行给它，海报网格就得少露半行）——这一页单独不出这层 header -->
    <header
      v-if="showHeader"
      class="sticky top-0 z-40 bg-white/70 dark:bg-[#171320]/70 backdrop-blur-xl
             border-b border-rose-100/70 dark:border-white/5"
    >
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between items-center h-16">
          <NuxtLink to="/" class="flex items-center space-x-2">
            <span class="w-9 h-9 rounded-2xl bg-gradient-to-br from-rose-400 via-pink-400 to-violet-400
                         flex items-center justify-center shadow-sm shadow-rose-200/60 dark:shadow-none">
              <UIcon name="i-heroicons-heart-solid" class="w-5 h-5 text-white" />
            </span>
            <span class="flex flex-col leading-none">
              <!-- 「晚风」：夏夜晚风那种氛围，不直说「爱情/浪漫」——直说的都俗 -->
              <span class="text-xl font-bold tracking-wide bg-gradient-to-r from-rose-500 via-pink-500 to-violet-500
                           bg-clip-text text-transparent">晚风</span>
              <span class="text-[10px] tracking-[0.3em] text-gray-400 dark:text-gray-500 mt-0.5">EVENING BREEZE</span>
            </span>
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
            <UserAuthButton />
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
          <div class="flex items-center gap-1">
            <UserAuthButton />
            <UButton
              variant="ghost"
              icon="i-heroicons-x-mark"
              @click="mobileMenuOpen = false"
            />
          </div>
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

    <!-- 挂在布局根上而不是嵌在按钮里：/video-search 那一页不出 header，
         按钮跟着不渲染，弹窗要是嵌在里面就一起没了 -->
    <UserAuthModal />

    <footer class="border-t border-rose-100/70 dark:border-white/5 mt-auto">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
        <p class="text-center text-gray-400 dark:text-gray-500 text-xs tracking-widest">
          晚风 · 一切都在你自己的浏览器里发生
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

const showHeader = computed(() => route.path !== '/video-search')

/*
 * 云同步挂在**布局**上而不是某个页面上：清单会在 /video-player、/video-parse、
 * /video-search 好几处被改到，挂在页面上就得挂三遍，还得想清楚「同时开两个页面」怎么办。
 *
 * `restore()` 必须排在 `start()` 之前 —— start 里第一件事就是看有没有令牌。
 * 引擎自己有「有变更才同步 + 5 分钟节流」两道闸，所以这里无条件调用是安全的：
 * 没登录、没改动时它一个请求都不发。
 */
const { restore } = useUserAuth()
restore()

const cloudSync = useCloudSync()
onMounted(() => cloudSync.start())

const toolCategories: Category[] = [
  {
    name: '媒体处理',
    icon: 'i-heroicons-photo',
    tools: [
      { label: '图片压缩', path: '/image-compress', icon: 'i-heroicons-arrow-down-tray' },
      { label: '图片格式转换', path: '/image-convert', icon: 'i-heroicons-arrows-right-left' },
      { label: '视频转GIF', path: '/video-to-gif', icon: 'i-heroicons-film' },
      { label: '放映厅', path: '/video-player', icon: 'i-heroicons-play-circle' },
      { label: '按片名搜索', path: '/video-search', icon: 'i-heroicons-magnifying-glass' },
      { label: '视频解析', path: '/video-parse', icon: 'i-heroicons-link' },
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
      { label: '内容对比', path: '/content-diff', icon: 'i-heroicons-document-duplicate' },
      { label: 'PDF 工具箱', path: '/pdf-tools', icon: 'i-heroicons-document' }
    ]
  }
]

const isActive = (path: string) => route.path === path

const isCategoryActive = (category: Category) => {
  return category.tools.some(tool => route.path === tool.path)
}
</script>
