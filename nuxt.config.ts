export default defineNuxtConfig({
  devtools: { enabled: false },
  
  modules: ['@nuxt/ui'],
  
  ssr: false,
  
  nitro: {
    preset: 'cloudflare-pages-static'
  },
  
  app: {
    head: {
      title: '开发工具箱',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '在线开发工具集合 - JSON格式化、对比、时间戳转换等' }
      ]
    }
  },

  colorMode: {
    preference: 'light'
  },

  compatibilityDate: '2024-07-01'
})
