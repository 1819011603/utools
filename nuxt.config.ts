export default defineNuxtConfig({
  devtools: { enabled: false },
  
  modules: ['@nuxt/ui'],
  
  ssr: false,
  
  nitro: {
    preset: 'cloudflare-pages'
  },
  
  app: {
    head: {
      title: '晚风 · 在线工具',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '晚风 — 纯浏览器端的在线工具集：放映厅、图片与 PDF 处理、JSON 工具' }
      ]
    }
  },

  colorMode: {
    preference: 'light'
  },

  // Nuxt 默认只扫 composables/ 顶层和 composables/*/index.ts，
  // 按页面分的子目录（如播放器那一整套）要在这里显式登记，否则自动导入认不到。
  imports: {
    dirs: ['composables/videoPlayer']
  },

  vite: {
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
    }
  },

  compatibilityDate: '2024-07-01'
})
