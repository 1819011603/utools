export default defineNuxtConfig({
  devtools: { enabled: false },
  
  modules: ['@nuxt/ui'],

  // 纯 keyframes，不含 @tailwind 指令，跟 @nuxt/ui 自己注入的那份互不干扰
  css: ['~/assets/css/motion.css'],

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

  // ssr:false 时 @nuxt/icon 默认 provider 是 'iconify'——每个图标都现场打
  // https://api.iconify.design 取（见 module.mjs 那行判断）。这条域名跟正文里那些
  // 被污染的目标站一个命运：用户网络一卡，图标就是「按钮显形却没有图案」
  // （ghost 按钮直接隐形、solid 按钮剩一块纯色块，正是收藏面板收起按钮和播放键实测的样子）。
  // scan:true 在构建期把源码里出现过的图标名（含三元表达式里的字面量）打进客户端 bundle，
  // 运行时零网络依赖。
  icon: {
    clientBundle: {
      scan: true
    }
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
