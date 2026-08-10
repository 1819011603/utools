<template>
  <div class="space-y-3">
    <!--
      搜索中画骨架屏而不是一行转圈：这一块最终会是一片海报网格，
      先把版式摆出来，结果落地时是「填进去」而不是「整块跳一下」。
      转圈还有个副作用——它不透露任何进度，慢站（ncat 要先算一轮 PoW）看着像卡死了
    -->
    <div v-if="state.status === 'searching'" class="space-y-4">
      <div class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin text-rose-400" />
        <span>
          正在搜「{{ keyword }}」…
          <!-- 算工作量证明那几百毫秒界面上什么都没有，不说一句会以为卡住了 -->
          <template v-if="state.powTried">（正在过站点校验，已试 {{ state.powTried.toLocaleString() }} 次）</template>
        </span>
      </div>
      <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-7 gap-3">
        <div v-for="n in 14" :key="n" class="wf-fade-in" :style="{ animationDelay: n * 45 + 'ms' }">
          <div class="wf-shimmer relative aspect-[2/3] rounded-xl overflow-hidden bg-gray-100 dark:bg-white/[0.06]" />
          <div class="wf-shimmer relative mt-1.5 h-3 w-4/5 rounded overflow-hidden bg-gray-100 dark:bg-white/[0.06]" />
        </div>
      </div>
    </div>

    <!-- 只能去源站搜（规则表写明的 manual，或服务端被人机校验挡住）。
         两种情况的处置完全一样，文案由 state.reason 区分 -->
    <div v-else-if="state.status === 'manual' || state.status === 'blocked'" class="space-y-3 wf-fade-in">
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

      <div v-if="tryEmbed" class="space-y-1.5 wf-fade-in">
        <p class="text-xs text-gray-500 dark:text-gray-400">
          下面直接嵌的是源站搜索页。<b>你这个浏览器过过校验（有 cf_clearance）才显示得出来</b>；
          一片空白就是被挡了（挑战页禁止被别的站内嵌），点上面「在新标签搜」。
          嵌进来之后点里面的结果会在框内跳转，把那部片的地址复制到下面的框里即可解析。
        </p>
        <iframe
          :src="state.siteSearchUrl || state.homepage"
          class="w-full h-[32rem] rounded-xl border border-gray-200 dark:border-gray-800 bg-white"
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
    <div v-else-if="state.status === 'error'" class="space-y-3 wf-fade-in">
      <!-- 错误文案走 slot 而不是 description 属性：报错里常是一长串没有空格的东西
           （域名 + UND_ERR_CONNECT_TIMEOUT 这类），默认不折行，在手机上直接横着捅出卡片外（踩过） -->
      <UAlert
        color="red"
        variant="soft"
        icon="i-heroicons-exclamation-triangle"
        :title="`「${state.name}」搜索失败`"
      >
        <template #description>
          <p class="break-words">{{ state.error }}</p>
        </template>
      </UAlert>
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
    <div v-else-if="state.status === 'done' && !state.items.length" class="py-12 text-center space-y-3 wf-fade-in">
      <div class="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-gray-100 to-gray-50
                  dark:from-white/[0.06] dark:to-transparent flex items-center justify-center">
        <UIcon name="i-heroicons-inbox" class="w-7 h-7 text-gray-300 dark:text-gray-600" />
      </div>
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

    <div v-else-if="state.status === 'idle'" class="py-12 text-center text-sm text-gray-400">
      输入片名开始搜索
    </div>

    <!-- 结果网格 -->
    <template v-else>
      <div class="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span class="truncate">
          <span class="font-medium text-gray-700 dark:text-gray-200">{{ state.items.length }}</span> 个结果
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
          class="shrink-0"
          :to="state.siteSearchUrl || state.homepage"
          target="_blank"
          rel="noopener noreferrer"
        >
          在源站看全部
        </UButton>
      </div>

      <VideoSearchResultGrid :items="state.items" @open="openParse" />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { SiteSearchState } from '~/composables/useVideoSearch'

defineProps<{ state: SiteSearchState; keyword: string }>()
defineEmits<{ retry: [] }>()

const toast = useToast()
const pasted = ref('')
const tryEmbed = ref(false)

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
