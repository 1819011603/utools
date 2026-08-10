<template>
  <div class="space-y-3">
    <!-- 搜索中 -->
    <div v-if="state.status === 'searching'" class="flex items-center gap-2 py-10 justify-center text-sm text-gray-500">
      <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" />
      <span>
        正在搜「{{ keyword }}」…
        <!-- 算工作量证明那几百毫秒界面上什么都没有，不说一句会以为卡住了 -->
        <template v-if="state.powTried">（正在过站点校验，已试 {{ state.powTried.toLocaleString() }} 次）</template>
      </span>
    </div>

    <!-- 只能去源站搜（规则表写明的 manual，或服务端被人机校验挡住）。
         两种情况的处置完全一样，文案由 state.reason 区分 -->
    <div v-else-if="state.status === 'manual' || state.status === 'blocked'" class="space-y-3">
      <UAlert
        color="amber"
        variant="soft"
        icon="i-heroicons-shield-exclamation"
        :title="`「${state.name}」只能在源站搜`"
        :description="`${state.reason || ''}在源站搜到之后，把那部片的详情页地址（.../voddetail/…）粘回下面，照样能解析出整季选集。`"
      />
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          icon="i-heroicons-arrow-top-right-on-square"
          size="sm"
          :to="state.siteSearchUrl || state.homepage"
          target="_blank"
          rel="noopener noreferrer"
        >
          在新标签搜「{{ keyword }}」
        </UButton>
        <!-- 「内嵌试试」而不是默认内嵌：能不能显示完全取决于**你这个浏览器**过没过校验。
             过了的话源站正常页面不带 X-Frame-Options，嵌得进来；没过则回的是挑战页，
             那张页带 SAMEORIGIN，浏览器一定拦，位置上就是一片空白。
             默认摆一个必定空白的框只会让人以为是我们坏了，所以做成开关 -->
        <UButton size="sm" variant="soft" :icon="tryEmbed ? 'i-heroicons-eye-slash' : 'i-heroicons-window'" @click="tryEmbed = !tryEmbed">
          {{ tryEmbed ? '收起内嵌' : '在这里内嵌试试' }}
        </UButton>
      </div>

      <div v-if="tryEmbed" class="space-y-1.5">
        <p class="text-xs text-gray-500 dark:text-gray-400">
          下面直接嵌的是源站搜索页。<b>你这个浏览器过过校验（有 cf_clearance）才显示得出来</b>；
          一片空白就是被挡了（挑战页禁止被别的站内嵌），点上面「在新标签搜」。
          嵌进来之后点里面的结果会在框内跳转，把那部片的地址复制到下面的框里即可解析。
        </p>
        <iframe
          :src="state.siteSearchUrl || state.homepage"
          class="w-full h-[32rem] rounded-lg border border-gray-200 dark:border-gray-800 bg-white"
          referrerpolicy="no-referrer"
          allow="fullscreen"
        />
      </div>
      <UFormGroup label="把源站的详情页/播放页地址粘回来">
        <div class="flex gap-2">
          <UInput
            v-model="pasted"
            placeholder="https://www.kpkuang.org/voddetail/1033381/"
            icon="i-heroicons-clipboard"
            class="flex-1"
            @keyup.enter="openPasted"
          />
          <UButton icon="i-heroicons-play" :disabled="!pasted.trim()" @click="openPasted">解析</UButton>
        </div>
      </UFormGroup>
    </div>

    <!-- 失败：说清是哪一步坏的，并且只重试这一站 -->
    <div v-else-if="state.status === 'error'" class="space-y-3">
      <UAlert
        color="red"
        variant="soft"
        icon="i-heroicons-exclamation-triangle"
        :title="`「${state.name}」搜索失败`"
        :description="state.error"
      />
      <div class="flex gap-2">
        <UButton size="sm" icon="i-heroicons-arrow-path" @click="$emit('retry')">重试本站</UButton>
        <UButton
          size="sm"
          variant="ghost"
          icon="i-heroicons-arrow-top-right-on-square"
          :to="state.siteSearchUrl || state.homepage"
          target="_blank"
          rel="noopener noreferrer"
        >
          去源站搜
        </UButton>
      </div>
    </div>

    <!-- 没搜到。不说成「规则失效」——真没有和规则坏了长得一样，给个源站入口让用户自己判 -->
    <div v-else-if="state.status === 'done' && !state.items.length" class="py-8 text-center space-y-3">
      <UIcon name="i-heroicons-inbox" class="w-8 h-8 mx-auto text-gray-300" />
      <p class="text-sm text-gray-500">「{{ state.name }}」没搜到「{{ keyword }}」</p>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-heroicons-arrow-top-right-on-square"
        :to="state.siteSearchUrl || state.homepage"
        target="_blank"
        rel="noopener noreferrer"
      >
        去源站再搜一次
      </UButton>
    </div>

    <div v-else-if="state.status === 'idle'" class="py-10 text-center text-sm text-gray-400">
      输入片名开始搜索
    </div>

    <!-- 结果网格 -->
    <template v-else>
      <div class="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>
          {{ state.items.length }} 个结果
          <template v-if="state.total && state.total > state.items.length">
            · 站点共 {{ state.total }} 部，这里只列第一页
          </template>
          · 点一格在新标签解析
        </span>
        <UButton
          size="2xs"
          variant="ghost"
          color="gray"
          icon="i-heroicons-arrow-top-right-on-square"
          :to="state.siteSearchUrl || state.homepage"
          target="_blank"
          rel="noopener noreferrer"
        >
          在源站看全部
        </UButton>
      </div>

      <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
        <button
          v-for="(it, i) in state.items"
          :key="i"
          type="button"
          class="group text-left"
          :title="`${it.title}${it.info ? ' · ' + it.info : ''}\n${it.url}`"
          @click="openParse(it.url)"
        >
          <div class="relative aspect-[2/3] rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
            <!-- 封面挂在带防盗链的 CDN 上，不加 no-referrer 会成片 403；
                 挂了也可能挂（源站换图床），失败就退回一个占位块，比留破图强 -->
            <img
              v-if="it.pic && !failed.has(i) && !deadPicHosts.has(hostOfPic(it.pic))"
              :src="picSrc(it.pic, i)"
              :alt="it.title"
              loading="lazy"
              referrerpolicy="no-referrer"
              class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              @error="onPicError(i)"
            >
            <div v-else class="w-full h-full flex items-center justify-center">
              <UIcon name="i-heroicons-film" class="w-7 h-7 text-gray-300 dark:text-gray-600" />
            </div>
            <span
              v-if="it.note"
              class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] leading-none"
            >{{ it.note }}</span>
            <span
              v-if="it.cat"
              class="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-rose-500/85 text-white text-[10px] leading-none"
            >{{ it.cat }}</span>
          </div>
          <div class="mt-1.5 text-xs font-medium truncate group-hover:text-rose-600 dark:group-hover:text-rose-400">
            {{ it.title }}
          </div>
          <div v-if="it.info" class="text-[11px] text-gray-400 truncate">{{ it.info }}</div>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { SiteSearchState } from '~/composables/useVideoSearch'

const props = defineProps<{ state: SiteSearchState; keyword: string }>()
defineEmits<{ retry: [] }>()

/**
 * 取不到封面的图床（按 host）。模块级：换站点、换关键词都留着——
 * 这是「这个图床我们够不着」的事实，不属于某一次搜索。刷新页面清零，站点修好了自动恢复。
 */
const deadPicHosts = reactive(new Set<string>())

const toast = useToast()
const pasted = ref('')
const tryEmbed = ref(false)

// 封面的两级退路：直连失败 → 走 /api/thumb 服务端代取 → 还失败才画占位块。
// 用 Set 记下标而不是给每条塞字段：那些条目来自接口，不该被界面状态污染
const viaThumb = reactive(new Set<number>())
const failed = reactive(new Set<number>())

// 换一批结果就把这两份记录清掉，否则新结果会沿用上一批的下标判死
watch(() => props.state.items, () => { viaThumb.clear(); failed.clear() })

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
  const pic = props.state.items[i]?.pic
  if (viaThumb.has(i)) {
    // 代取也不行 = 这个图床我们根本取不到，整站认栽
    failed.add(i)
    if (pic) deadPicHosts.add(hostOfPic(pic))
  } else {
    viaThumb.add(i)
  }
}

/**
 * 去解析页。**开新标签**：搜索结果这张表还要用（挑片本来就是来回比的动作），
 * 同标签跳走想看下一个候选就得按返回键。被拦（返回 null）就退回同标签，
 * 绝不能让按钮点了没反应。与解析页的 openPlayer 同一条理由、同一套处置。
 */
const openParse = (url: string) => {
  const href = '/video-parse?url=' + encodeURIComponent(url)
  if (window.open(href, '_blank')) return
  toast.add({ title: '新标签被浏览器拦了，已在当前页打开', color: 'orange' })
  void navigateTo(href)
}

const openPasted = () => {
  const u = pasted.value.trim()
  if (!/^https?:\/\//i.test(u)) {
    toast.add({ title: '请粘贴完整地址', description: '要以 http:// 或 https:// 开头', color: 'orange' })
    return
  }
  openParse(u)
}
</script>
