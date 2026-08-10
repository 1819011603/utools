<template>
  <!--
    列数是**看得清**和**一屏看得完**之间的折中，改之前先想清楚往哪边让。
    最早是 3→8 列，8 列时每张海报只剩 100px 出头，封面上的片名和台标全糊成一团，
    等于把一张挑片用的图降级成色块；一度放到 2→5 列又太占地方，一屏摆不下十张。
    现在这档比 5 列小约三成，海报仍读得出字，同时一屏能看到两行以上
  -->
  <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-7 gap-3">
    <button
      v-for="(it, i) in items"
      :key="i"
      type="button"
      class="wf-fade-up group text-left focus:outline-none"
      :style="{ animationDelay: Math.min(i, 12) * 35 + 'ms' }"
      :title="`${it.title}${it.info ? ' · ' + it.info : ''}\n${it.url}`"
      @click="$emit('open', it.url)"
    >
      <div
        class="relative aspect-[2/3] rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800
               ring-1 ring-black/5 dark:ring-white/10 shadow-sm
               transition-all duration-300 ease-out
               group-hover:-translate-y-1 group-hover:shadow-xl group-hover:shadow-rose-200/50
               dark:group-hover:shadow-black/40 group-hover:ring-rose-300/60
               group-focus-visible:ring-2 group-focus-visible:ring-rose-500"
      >
        <!-- 封面挂在带防盗链的 CDN 上，不加 no-referrer 会成片 403；
             挂了也可能挂（源站换图床），失败就退回一个占位块，比留破图强 -->
        <img
          v-if="it.pic && !failed.has(i) && !deadPicHosts.has(hostOfPic(it.pic))"
          :src="picSrc(it.pic, i)"
          :alt="it.title"
          loading="lazy"
          referrerpolicy="no-referrer"
          class="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.07]"
          @error="onPicError(i)"
        >
        <div v-else class="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900">
          <UIcon name="i-heroicons-film" class="w-8 h-8 text-gray-300 dark:text-gray-600" />
        </div>

        <!-- 常驻一层很淡的底部压暗：右下角那枚「已完结」角标常压在浅色画面上，
             不压暗就读不出来。hover 时整体加深，给「这一格被选中了」一个交代 -->
        <!-- 只压最下面那一截，而且压得比看上去需要的更轻：
             整张铺一层灰的话，还没加载出来的封面会看着像「坏掉的灰卡片」（海报缩小后尤其明显） -->
        <div class="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/50 to-transparent
                    opacity-75 group-hover:opacity-95 transition-opacity duration-300" />

        <!-- hover 才出的播放键。海报本身没有任何「可点」的暗示，
             光靠指针变手型在触摸端根本不存在 -->
        <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100
                    transition-opacity duration-300">
          <span class="w-9 h-9 rounded-full bg-white/95 dark:bg-white/90 backdrop-blur
                       flex items-center justify-center shadow-lg
                       scale-75 group-hover:scale-100 transition-transform duration-300 ease-out">
            <UIcon name="i-heroicons-play-solid" class="w-4 h-4 text-rose-600 ml-0.5" />
          </span>
        </div>

        <span
          v-if="it.note"
          class="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/55 backdrop-blur-sm
                 text-white text-[10px] leading-none font-medium tracking-wide"
        >{{ it.note }}</span>
        <span
          v-if="it.cat"
          class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-white text-[10px] leading-none font-medium
                 bg-gradient-to-r from-rose-500/90 to-pink-500/90 backdrop-blur-sm shadow-sm"
        >{{ it.cat }}</span>
      </div>

      <div class="mt-1.5 text-xs font-medium text-gray-800 dark:text-gray-100 truncate
                  transition-colors group-hover:text-rose-600 dark:group-hover:text-rose-400">
        {{ it.title }}
      </div>
      <div v-if="it.info" class="text-[11px] text-gray-400 dark:text-gray-500 truncate">{{ it.info }}</div>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { SearchItem } from '~/composables/videoSearchRules'

const props = defineProps<{ items: SearchItem[] }>()
defineEmits<{ open: [string] }>()

/**
 * 取不到封面的图床（按 host）。模块级：换站点、换关键词都留着——
 * 这是「这个图床我们够不着」的事实，不属于某一次搜索。刷新页面清零，站点修好了自动恢复。
 */
const deadPicHosts = reactive(new Set<string>())

// 封面的两级退路：直连失败 → 走 /api/thumb 服务端代取 → 还失败才画占位块。
// 用 Set 记下标而不是给每条塞字段：那些条目来自接口，不该被界面状态污染
const viaThumb = reactive(new Set<number>())
const failed = reactive(new Set<number>())

// 换一批结果就把这两份记录清掉，否则新结果会沿用上一批的下标判死
watch(() => props.items, () => { viaThumb.clear(); failed.clear() })

/**
 * 封面的两级退路：直连 → 服务端代取（/api/thumb）→ 占位块。
 *
 * 为什么不一上来就全走服务端：多数站点的图床是公开 CDN，直连最快、也不吃我们的出口流量。
 * 但有的站点连图片都过反爬（实测 ncat 的封面直连回的是 850 挑战页），那种只有服务端
 * 代取才可能拿到——它手上有搜索时浏览器算出来的那份 cookie。
 *
 * **失败要按图床 host 记，而且跨组件存**（deadPicHosts 是模块级）：ncat 那种源站
 * 干脆 403 掉整个封面目录的，一页 18 张各自「直连失败 → 代取失败」就是 36 个白跑的请求、
 * 其中 18 个还打在我们自己的服务端上。第一张失败之后同 host 的后面几张直接画占位块。
 * 不做成规则表里的开关：站点什么时候修好图床我们不知道，刷新一次就能自愈比配置死了强。
 */
const hostOfPic = (pic: string) => { try { return new URL(pic, location.href).host } catch { return pic } }

const picSrc = (pic: string, i: number) =>
  viaThumb.has(i) ? '/api/thumb?url=' + encodeURIComponent(pic) : pic

const onPicError = (i: number) => {
  const pic = props.items[i]?.pic
  if (viaThumb.has(i)) {
    // 代取也不行 = 这个图床我们根本取不到，整站认栽
    failed.add(i)
    if (pic) deadPicHosts.add(hostOfPic(pic))
  } else {
    viaThumb.add(i)
  }
}
</script>
