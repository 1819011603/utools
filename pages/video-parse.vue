<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频解析</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
        粘贴视频站的播放页地址，解析出整季选集的真实播放地址，一键送进播放器
      </p>
    </div>

    <!-- 输入 -->
    <UCard>
      <div class="space-y-3">
        <UFormGroup label="播放页地址">
          <div class="flex gap-2">
            <UInput
              v-model="inputUrl"
              placeholder="https://www.example.com/play/123-4-567.html"
              icon="i-heroicons-link"
              class="flex-1"
              :disabled="busy"
              @keyup.enter="startResolve()"
            />
            <UButton
              icon="i-heroicons-magnifying-glass"
              :loading="busy"
              :disabled="!inputUrl.trim()"
              @click="startResolve()"
            >
              解析
            </UButton>
          </div>
        </UFormGroup>

        <!-- 支持的站点：既是清单，也是「我这个地址支不支持」的即时反馈——
             命中的那条高亮，没命中就整排保持静默，不用再单开一块说明区 -->
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <UIcon name="i-heroicons-check-badge" class="w-4 h-4 shrink-0" />
            <span>
              目前支持 {{ supportedSites.length }} 个站点
              <template v-if="!matchedRule">，点站名打开首页，进任意影片的<b>播放页</b>后复制地址栏</template>
            </span>
          </div>

          <div class="flex flex-wrap gap-2">
            <UTooltip
              v-for="site in supportedSites"
              :key="site.id"
              :text="site.note || (site.custom ? '自定义规则' : '')"
              :prevent="!site.note && !site.custom"
            >
              <component
                :is="site.homepage ? 'a' : 'span'"
                v-bind="site.homepage ? { href: site.homepage, target: '_blank', rel: 'noopener noreferrer' } : {}"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors"
                :class="matchedRule?.id === site.id
                  ? 'border-green-500 bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400'"
              >
                <UIcon
                  :name="matchedRule?.id === site.id ? 'i-heroicons-check-circle' : 'i-heroicons-globe-alt'"
                  class="w-3.5 h-3.5 shrink-0"
                />
                <span>{{ site.name }}</span>
                <UIcon v-if="site.note" name="i-heroicons-information-circle" class="w-3.5 h-3.5 shrink-0 opacity-50" />
              </component>
            </UTooltip>
          </div>

          <div v-if="matchedRule" class="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
            <UIcon name="i-heroicons-check-circle" class="w-4 h-4 shrink-0" />
            <span>已匹配「{{ matchedRule.name }}」，可以解析</span>
          </div>
          <div v-else-if="inputUrl.trim()" class="flex items-center gap-1.5 text-xs text-orange-500">
            <UIcon name="i-heroicons-exclamation-triangle" class="w-4 h-4 shrink-0" />
            <span>这个地址不在支持列表里，解析多半会失败</span>
          </div>
        </div>

        <!-- 进度 -->
        <div v-if="busy" class="space-y-2">
          <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" />
            <span>{{ stage }}</span>
          </div>
          <UProgress v-if="powTried > 0" :value="powPercent" size="xs" />
        </div>

        <UAlert
          v-if="error"
          color="red"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
          :title="error"
        />
      </div>
    </UCard>

    <!-- 结果 -->
    <UCard v-if="result">
      <template #header>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-2 min-w-0">
            <UIcon name="i-heroicons-film" class="w-5 h-5 shrink-0 text-violet-500" />
            <span class="font-medium truncate">{{ result.title || '解析结果' }}</span>
            <UBadge color="violet" variant="soft" size="xs">
              {{ currentLine?.name }}{{ currentLine?.sublabel ? ' · ' + currentLine.sublabel : '' }}
            </UBadge>
          </div>
          <div class="flex gap-2">
            <UButton size="xs" variant="ghost" icon="i-heroicons-share" title="复制带地址和线路的本页链接" @click="copyPageLink">
              分享本页
            </UButton>
            <!-- 按需取址的站点这里只有当前一集的地址，复制「全部」会误导；
                 内嵌线路压根没有地址可复制 -->
            <UButton
              v-if="!isLazy && !isEmbedLine"
              size="xs"
              variant="soft"
              icon="i-heroicons-clipboard"
              @click="copyAll"
            >
              复制全部地址
            </UButton>
            <!-- 解析未完成时禁用：长剧要分多批拉，中途点会只把已解析的那部分带过去。
                 内嵌线路不显示：这条线路的地址进不了我们的播放器（见 isEmbedLine） -->
            <UButton
              v-if="!isEmbedLine"
              size="xs"
              icon="i-heroicons-play"
              :disabled="!playableCount || busy"
              :title="busy ? '正在解析，稍候' : ''"
              @click="playAll()"
            >
              播放全部 ({{ playableCount }}<template v-if="busy">…</template>)
            </UButton>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <!-- 线路 -->
        <div class="space-y-2">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
            切换线路
            <span class="font-normal text-gray-400">（切换会重新解析该线路的全部集数）</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="(line, i) in result.lines"
              :key="i"
              size="xs"
              :color="i === result.activeLineIndex ? 'violet' : 'gray'"
              :variant="i === result.activeLineIndex ? 'solid' : 'soft'"
              :disabled="busy"
              :class="deadLines.has(i) ? 'opacity-40 line-through' : ''"
              :title="deadLines.has(i) ? '该线路不提供直链' : ''"
              @click="startResolve(i)"
            >
              {{ line.name }}
              <span v-if="line.sublabel" class="opacity-60 ml-1">{{ line.sublabel }}</span>
              <UBadge color="gray" variant="solid" size="xs" class="ml-1">{{ line.episodes.length }}</UBadge>
            </UButton>
          </div>
        </div>

        <UAlert
          v-if="result.lineUnsupported"
          color="red"
          variant="soft"
          icon="i-heroicons-no-symbol"
          :title="`「${currentLine?.name}」线路不提供直链`"
          :description="result.lineUnsupportedReason || '这类线路的页面把播放地址留空，改由播放器运行时另行获取，服务端拿不到。换一条线路即可。'"
        />

        <!-- 只能用站点自带播放器内嵌播的线路。说清「换了什么」而不只是「能播」——
             用的是它的播放器，我们那套抗卡/下载/倍速在这条线路上一个都没有 -->
        <UAlert
          v-if="isEmbedLine"
          color="blue"
          variant="soft"
          icon="i-heroicons-tv"
          :title="`「${currentLine?.name}」线路用站点自带的播放器播放`"
          description="这条线路给的不是视频地址，而是第三方站点（爱奇艺 / 芒果 / 腾讯等）的播放页，真实地址由站点自带的解析服务在浏览器里现算，服务端拿不到。这里直接内嵌它的播放器：能播，但画质、广告、进度条都是它的，我们的抗卡、下载、倍速在这条线路上都用不了。部分播放器检测不到广告就拒绝播放，所以内嵌框允许它弹窗——播放期间可能弹出广告页，关掉即可（顶层跳转仍被拦着，本页不会被劫走）。想用本站播放器请换一条给直链的线路。"
        />

        <!-- 内嵌播放器 -->
        <div v-if="isEmbedLine" class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
              <template v-if="embedIndex >= 0">正在播放：{{ currentLine?.episodes[embedIndex]?.title || `第 ${embedIndex + 1} 集` }}</template>
              <template v-else>内嵌播放器</template>
            </div>
            <!-- 逃生口：部分解析站不允许被别的域套 iframe（X-Frame-Options），
                 内嵌位置会是一片空白，此时只能整页打开 -->
            <UButton
              v-if="embedSrc"
              size="xs"
              variant="ghost"
              icon="i-heroicons-arrow-top-right-on-square"
              :to="embedSrc"
              target="_blank"
              rel="noopener noreferrer"
            >
              在新标签打开
            </UButton>
          </div>
          <div class="relative w-full rounded-lg overflow-hidden bg-black" style="aspect-ratio: 16 / 9">
            <!-- 后面两个 token 是被这些播放器的「反内嵌」自检逼出来的，各对一条线路，别顺手删：
                 · allow-document-domain ← 超清EV线（ezplayer）拿 `document.domain = document.domain`
                   试探，沙箱文档里这句必抛 SecurityError（消息里带 sandboxed），一抛就罢工，
                   只显示「Opss! Sandboxed our player is not allowed」。跟广告无关，探的就是 sandbox 属性本身。
                   放行它没有代价：document.domain 早已废弃，跨域 iframe 本来也降不到同源。
                 · allow-popups ← 超清AB线（abyssplayer）点遮罩时要 `window.open(广告页)` 连续成功两次
                   （失败两次就 document.write 掉播放器，报「Due to certain reasons (AdBlock/Sandbox)…」）。
                   用户装了拦截插件照样过不了，那个我们兜不住。
                 **故意不给** allow-popups-to-escape-sandbox（弹出窗继承同一套限制，落地页的二次跳转/
                 自动下载仍被关着）和 allow-top-navigation*（那一项最恶心：点一下播放整页被劫走，
                 用户只会以为是本站跳的）。
                 allow-same-origin 必须给（播放器要读自己的存储和接口），跨域 iframe 给它不影响本页安全 -->
            <iframe
              v-if="embedSrc"
              :key="embedSrc"
              :src="embedSrc"
              class="absolute inset-0 w-full h-full"
              allowfullscreen
              allow="fullscreen; encrypted-media; autoplay"
              sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups allow-document-domain"
            />
            <div v-else class="absolute inset-0 flex items-center justify-center gap-2 text-sm text-gray-400">
              <UIcon v-if="embedPending >= 0" name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" />
              <span>{{ embedPending >= 0 ? '正在获取这一集的播放地址…' : '点下面任意一集开始播放' }}</span>
            </div>
          </div>
        </div>

        <UAlert
          v-if="result.remaining > 0 && !busy"
          color="orange"
          variant="soft"
          icon="i-heroicons-exclamation-circle"
          :title="`还有 ${result.remaining} 集未解析（共 ${currentLine?.episodes.length || 0} 集）`"
          description="解析中断了，重新点「解析」可以继续。"
        />

        <UAlert
          v-if="hasSignedUrl"
          color="amber"
          variant="soft"
          icon="i-heroicons-clock"
          title="该线路的地址带时效签名"
          description="地址里含 sign/timestamp，过一段时间会失效，届时重新解析即可。不建议长期收藏或分享。"
        />

        <UAlert
          v-if="isLazy"
          color="blue"
          variant="soft"
          icon="i-heroicons-bolt"
          title="该站点按需取址"
          description="源站限流，不能一次把整季的地址都取下来（会被判为请求过于频繁）。这里只取了当前这一集，其余集在播放器里切到哪集就取哪集，正常播放即可。"
        />

        <!-- 选集 -->
        <div class="space-y-2">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
            <template v-if="isEmbedLine">选集（共 {{ currentLine?.episodes.length || 0 }} 集，点一集在上面的内嵌播放器里播）</template>
            <template v-else-if="isLazy">选集（共 {{ currentLine?.episodes.length || 0 }} 集，播到哪集取哪集）</template>
            <template v-else>选集（{{ resolvedCount }}/{{ currentLine?.episodes.length || 0 }} 解析成功）</template>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              v-for="(ep, i) in currentLine?.episodes || []"
              :key="i"
              class="flex items-center gap-2 p-2 rounded-lg text-sm bg-gray-50 dark:bg-gray-800"
            >
              <UIcon
                :name="epIcon(ep, i)"
                class="w-4 h-4 shrink-0"
                :class="epIconClass(ep, i)"
              />
              <div class="min-w-0 flex-1">
                <div class="font-medium truncate">{{ ep.title || `第 ${i + 1} 集` }}</div>
                <div class="text-xs text-gray-400 truncate">{{ epDesc(ep, i) }}</div>
              </div>
              <UButton
                v-if="ep.videoUrl"
                size="2xs"
                variant="ghost"
                icon="i-heroicons-clipboard"
                title="复制地址"
                @click="copyOne(ep.videoUrl)"
              />
              <!-- 内嵌线路：换的是上面 iframe 的 src，不去播放器 -->
              <UButton
                v-if="isEmbedLine"
                size="2xs"
                :variant="i === embedIndex ? 'solid' : 'ghost'"
                :color="i === embedIndex ? 'violet' : 'gray'"
                icon="i-heroicons-play"
                :loading="embedPending === i"
                :disabled="busy"
                title="在上面的内嵌播放器里播这一集"
                @click="playEmbed(i)"
              />
              <!-- 按需取址时每一集都能播（地址由播放器现取），不能按 videoUrl 判 -->
              <UButton
                v-else-if="ep.videoUrl || isLazy"
                size="2xs"
                variant="ghost"
                icon="i-heroicons-play"
                :disabled="busy"
                title="从这一集开始播放"
                @click="playAll(i)"
              />
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- 历史 -->
    <UCard v-if="parseHistory.length">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-medium">解析历史</span>
          <UButton size="xs" variant="ghost" color="red" @click="clearAllHistory">清空</UButton>
        </div>
      </template>
      <div class="space-y-1">
        <div
          v-for="(h, i) in parseHistory"
          :key="i"
          class="flex items-center gap-2 p-2 rounded text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
          @click="inputUrl = h.data.url; startResolve()"
        >
          <UIcon name="i-heroicons-clock" class="w-4 h-4 shrink-0 text-gray-400" />
          <span class="flex-1 truncate">{{ h.data.title || h.data.url }}</span>
          <span class="text-xs text-gray-400 shrink-0">{{ formatWhen(h.timestamp) }}</span>
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import type { ParsedEpisode, ParseResult, ParseRule } from '~/composables/videoParseRules'

const toast = useToast()

const inputUrl = ref('')
const busy = ref(false)
const stage = ref('')
const error = ref('')
const result = ref<ParseResult | null>(null)

// 期望迭代约 65536 次；进度条只是给个「在动」的感觉，超过就压在 95%
const powTried = ref(0)
const powPercent = computed(() => Math.min(95, Math.round((powTried.value / 65536) * 100)))

// 解出的 cookie 在本次会话内复用：实测同站不同影片页共用同一挑战常量，
// 只有第一次解析需要算 PoW
const powCookie = ref('')
const lastParsedUrl = ref('')

const userRules = ref<ParseRule[]>([])
// 清单从规则表现算，不硬编码站名：加站点只需改 videoParseRules.ts 的两张表，这里自动跟上
const supportedSites = computed(() => listParseSites(userRules.value))
const matchedRule = computed(() => {
  const u = inputUrl.value.trim()
  if (!u) return null
  return matchParseSite(u, userRules.value)
})

const currentLine = computed(() => result.value?.lines[result.value.activeLineIndex] ?? null)
const resolvedEpisodes = computed(() => (currentLine.value?.episodes || []).filter(e => e.videoUrl))
const resolvedCount = computed(() => resolvedEpisodes.value.length)

// 按需取址的站点：站点限流，不许一次把整季取完，所以这里只取了当前这一集，
// 其余集在播放器里播到哪集才取哪集。界面上要按「全部可播」来呈现，不能按已解析数算
const isLazy = computed(() => !!result.value?.clientTask?.lazy)
const playableCount = computed(() =>
  isLazy.value ? (currentLine.value?.episodes.length ?? 0) : resolvedCount.value,
)
const hasSignedUrl = computed(() =>
  // Expires/Signature 是 S3 风格预签名地址的标志（4kvm 的部分集数走网盘直链就是这种）
  resolvedEpisodes.value.some(e => /[?&](sign|signature|timestamp|token|auth_key|expires)=/i.test(e.videoUrl || '')),
)

// ── 内嵌线路（只能用站点自带的解析播放器播，见 ParseResult.embedUrl）──
// 这条线路一个视频地址都没有，所以上面那些按 videoUrl 算的计数在这里全是 0，
// 界面得整块换成「内嵌 iframe + 点选集换 src」
const isEmbedLine = computed(() => !!result.value?.embedUrl)
const embedSrc = ref('')
const embedIndex = ref(-1)     // 内嵌播的是第几集，-1 = 还没点
const embedPending = ref(-1)   // 正在现取第几集的内嵌地址，-1 = 空闲

/** 选集行的状态呈现。三种线路（直链 / 按需取址 / 内嵌）各一套说法，写成内联三元没法看 */
const epIcon = (ep: ParsedEpisode, i: number) => {
  if (ep.videoUrl) return 'i-heroicons-check-circle'
  if (isEmbedLine.value) return i === embedIndex.value ? 'i-heroicons-play-circle' : 'i-heroicons-tv'
  return isLazy.value ? 'i-heroicons-bolt' : 'i-heroicons-x-circle'
}
const epIconClass = (ep: ParsedEpisode, i: number) => {
  if (ep.videoUrl) return 'text-green-500'
  if (isEmbedLine.value) return i === embedIndex.value ? 'text-violet-500' : 'text-blue-400'
  return isLazy.value ? 'text-blue-400' : 'text-gray-400'
}
const epDesc = (ep: ParsedEpisode, i: number) => {
  if (ep.videoUrl) return ep.videoUrl
  if (ep.error) return ep.error
  if (isEmbedLine.value) return i === embedIndex.value ? '正在内嵌播放' : '点右侧按钮内嵌播放'
  return isLazy.value ? '播放时现取地址' : '未解析'
}

/**
 * 内嵌播这一集。地址是**每集一份**、写在各自的播放页上，只能现取
 * （服务端 only=1 只解析这一集、不碰选集表）。取过就留在 ep 上，再点不重取。
 *
 * 取址那一发要打源站、常要好几秒，期间**不能把别的集按住**：原来在等待中的那集之外
 * 全部 disabled，用户看到的就是「整排突然置灰、点不动了」，只会以为页面坏了（实测被问过）。
 * 现在改成后点的作废先点的——用自增序号认领结果，回来时序号已变就整个丢掉
 * （包括错误提示：那是上一次点击的事，弹出来只会误导）。
 */
let embedSeq = 0

const playEmbed = async (i: number) => {
  const ep = currentLine.value?.episodes[i]
  if (!ep || busy.value) return
  const seq = ++embedSeq

  if (!ep.embedUrl) {
    embedPending.value = i
    // 先清掉上一集，否则等待期间画面还停在上一集，看着像点了没反应
    embedSrc.value = ''
    embedIndex.value = -1
    try {
      const res = await $fetch<ParseResult>('/api/resolve', {
        query: {
          step: 'extract',
          url: ep.pageUrl,
          only: '1',
          ...(userRules.value.length ? { rules: JSON.stringify(userRules.value) } : {}),
        },
      })
      if (seq !== embedSeq) return
      ep.embedUrl = res?.embedUrl
    } catch (e: any) {
      if (seq !== embedSeq) return
      toast.add({
        title: '取这一集的播放地址失败',
        description: e?.statusMessage || e?.data?.statusMessage || e?.message,
        color: 'red',
      })
    } finally {
      // 已被后来的点击接管时不能碰它，否则会把那一次的转圈图标提前抹掉
      if (seq === embedSeq) embedPending.value = -1
    }
  }

  if (!ep.embedUrl) {
    toast.add({ title: '这一集没给出播放地址', description: '换一集或换一条线路试试', color: 'orange' })
    return
  }
  embedIndex.value = i
  embedSrc.value = ep.embedUrl
}

// 已探明不给直链的线路（本次解析内记忆），置灰避免用户反复去点
const deadLines = ref(new Set<number>())

const { addToHistory, getHistory, clearHistory } = useHistory<{ url: string; title?: string }>('video-parse')
const parseHistory = ref(getHistory())

const formatWhen = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

const startResolve = async (line?: number) => {
  const url = inputUrl.value.trim()
  if (!url || busy.value) return

  busy.value = true
  error.value = ''
  powTried.value = 0
  stage.value = '正在获取页面…'

  try {
    // 工作量证明 + 分批续拉都在 useResolvePlaylist 里，与播放器的「刷新链接」共用同一套
    const { result: res, cookie } = await resolvePlaylist({
      pageUrl: url,
      line,
      cookie: powCookie.value,
      rules: userRules.value,
      onStage: t => { stage.value = t },
      onPow: n => { powTried.value = n },
    })
    powCookie.value = cookie
    result.value = res

    // 内嵌播放器归位：换线路/换片子后 iframe 还停在上一条线路的那一集，
    // 而下面的集名早就换了，对不上。服务端探测到的那一集就是起点
    embedSrc.value = res.embedUrl || ''
    embedIndex.value = res.embedUrl
      ? (res.lines[res.activeLineIndex]?.episodes.findIndex(e => e.embedUrl === res.embedUrl) ?? -1)
      : -1

    if (res.remaining > 0) {
      const total = res.lines[res.activeLineIndex]?.episodes.length ?? 0
      toast.add({ title: `已解析 ${res.batchTo}/${total} 集`, description: '剩余集数过多，已停在安全上限', color: 'orange' })
    }

    // 换了片子就把上一部的死线路记录清掉（线路序号只在同一部片子里有意义）
    if (res.pageUrl !== lastParsedUrl.value) {
      deadLines.value = new Set()
      lastParsedUrl.value = res.pageUrl
    }
    if (res.lineUnsupported) deadLines.value.add(res.activeLineIndex)

    addToHistory({ url, title: res.title })
    parseHistory.value = getHistory()
    syncUrlToQuery()   // 地址栏跟着当前地址+线路走，随时可复制分享
  } catch (e: any) {
    // 409 = 服务端说 cookie 失效：丢掉重算一轮，只重试一次避免死循环
    const status = e?.statusCode || e?.response?.status
    if (status === 409 && powCookie.value) {
      powCookie.value = ''
      busy.value = false
      return startResolve(line)
    }
    error.value = e?.statusMessage || e?.data?.statusMessage || e?.message || '解析失败'
  } finally {
    busy.value = false
    stage.value = ''
    // 失败时也要把地址写回去：刷新页面能直接重试同一个地址。
    // 此时 syncUrlToQuery 里的 pageUrl 校验会自动省掉 line，不会带上残留线路号
    syncUrlToQuery()
  }
}

// ── URL 参数双向同步 ──────────────────────────────────────────
// 参数：url（播放页地址）、line（线路序号，0 基）
//
// 与 video-player 同一套做法，包括那个坑：播放页地址自带 query（?id=1&t=2）时，
// 未编码的 & 会被拆成独立参数，直接读 route.query.url 只能拿到第一段。
// 所以从原始 search 串手工解析，凡「不是本页已知参数」的片段原样回写进地址。
const PAGE_QUERY_KEYS = new Set(['url', 'line'])

interface QueryParseParams {
  url?: string
  line?: number
}

const parseQueryParams = (): QueryParseParams => {
  const out: QueryParseParams = {}
  const raw = (typeof window === 'undefined' ? '' : window.location.search).replace(/^\?/, '')
  if (!raw) return out

  // 只做 percent 解码，不把 + 当空格：站点地址里的 + 是字面量，转空格会 404
  const dec = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }

  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const val = eq === -1 ? '' : part.slice(eq + 1)

    if (!PAGE_QUERY_KEYS.has(key)) {
      // 属于播放页地址自己的 query 片段，原样接回去
      if (out.url) out.url += (out.url.includes('?') ? '&' : '?') + part
      continue
    }

    if (key === 'url') out.url = dec(val).trim()
    else if (key === 'line') {
      const n = Number.parseInt(dec(val), 10)
      if (Number.isFinite(n)) out.line = n
    }
  }
  return out
}

// 用原生 replaceState 而非 router.replace：本页只读 window.location.search，
// 不经 vue-router，避免 query 变化触发路由重解析，也不污染后退栈
const syncUrlToQuery = () => {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()
  const u = inputUrl.value.trim()
  if (u) params.set('url', u)
  // 线路序号跟着实际解析的那条走，刷新/分享后能落回同一条线路。
  // 必须校验结果属于当前这个地址——否则解析失败或换了片子时，
  // 会把上一次残留的线路号写进新地址，分享出去直接跳到一条不相干的线路
  if (result.value && result.value.pageUrl === u && result.value.activeLineIndex >= 0) {
    params.set('line', String(result.value.activeLineIndex))
  }
  const qs = params.toString()
  // 必须写全 window.：本组件有个叫 history 的 ref（解析历史），会遮蔽全局 history
  window.history.replaceState(window.history.state, '', qs ? `${location.pathname}?${qs}` : location.pathname)
}

const copyPageLink = async () => {
  await navigator.clipboard.writeText(location.href)
  toast.add({ title: '已复制本页链接', color: 'green' })
}

// 超过这个长度就不往 query 里塞了，改走交接槽。
// 短列表仍走 query，因为那样的链接可以直接复制给别人；交接槽是本机 localStorage，分享不了。
const MAX_QUERY_LEN = 1800

// 播放器持有的长列表交接槽（见 video-player.vue 的 HANDOFF_KEY）
const HANDOFF_KEY = 'video-player-handoff'

/** 源站播放页的 origin，带去播放器当防盗链候选值（推不出来的那类站点全靠它） */
const originOfPage = (pageUrl: string): string => {
  const u = (pageUrl || '').trim()
  if (!u) return ''
  try { return new URL(u.startsWith('//') ? 'https:' + u : u).origin } catch { return '' }
}

const playAll = (startIndex = 0) => {
  const eps = currentLine.value?.episodes || []
  // 按需取址的站点整份带走（列表里是占位地址，下标必须与作业单对齐）；
  // 其余站点只装解析成功的，索引按过滤后的位置重新算
  const playable = isLazy.value ? eps : eps.filter(e => e.videoUrl)
  if (!playable.length) return
  const clicked = eps[startIndex]
  const idx = Math.max(0, playable.findIndex(e => e === clicked))
  const urls = playable.map(e => (isLazy.value ? e.pageUrl : e.videoUrl!)) as string[]
  // 集名一并带过去：长剧每集的地址都叫 index.m3u8，播放器光看 URL 认不出第几集
  const names = playable.map((e, i) => e.title || `第 ${i + 1} 集`)

  const params = new URLSearchParams()

  // 交接槽始终写：长列表靠它整份传过去，短列表靠它把集名带过去
  // （短列表的地址仍走 urls=，那样的链接可以直接复制给别人；交接槽是本机 localStorage，分享不了）
  let handoffOk = true
  try {
    // 剧名一起带过去，播放器用它顶掉「播放器」「播放列表」这两个泛标题；
    // source 让播放器能在链接过期时就地重新解析（带签名的地址活不久）
    const title = result.value?.title
    // 线路名一并带走：播放器判断「槽里是不是这份列表」时按名字比，光比序号会在
    // 源站增删线路后把另一条线路的列表错当成这一份用上
    const source = result.value
      ? { pageUrl: result.value.pageUrl, line: result.value.activeLineIndex, lineName: currentLine.value?.name }
      : undefined
    // 按需取址的站点必须把作业单一起交接：列表里是占位地址，没有它播放器一集都取不到
    const lazy = isLazy.value ? result.value?.clientTask : undefined
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ urls, names, title, source, lazy, index: idx, at: Date.now() }))
  } catch (e) {
    handoffOk = false
    console.error('写入播放列表交接槽失败:', e)
  }

  // 首选「从哪解析的 + 哪条线路 + 第几集」：链接短、可以直接分享，且不怕地址过期——
  // 别人打开时播放器会拿这三个参数自己解析一遍（本机有交接槽则直接用槽，不重复解析）。
  // 早先解析来的列表只有两种表达，都不能分享：?handoff=1（列表在本机 localStorage 里，
  // 别人打开一片空白）、urls=a|b|c（几十集顶爆地址栏，带签名的地址过几小时还会变死链）。
  const parsed = result.value
  if (parsed?.pageUrl) {
    params.set('parseUrl', parsed.pageUrl)
    // 线路和集数各带两份：序号是位置、名字是身份。源站增删线路或往中间插集之后
    // 序号就指到别处了，而分享链接的寿命以天计——播放器打开时先按名字认，序号兜底。
    if (parsed.activeLineIndex > 0) params.set('line', String(parsed.activeLineIndex))
    const lineName = currentLine.value?.name
    if (lineName) params.set('lineName', lineName)
    params.set('index', String(idx))
    if (names[idx]) params.set('ep', names[idx])
  } else if (isLazy.value) {
    if (!handoffOk) {
      toast.add({ title: '浏览器存储不可用，该站点无法送进播放器', color: 'red' })
      return
    }
    params.set('handoff', '1')
  } else if (urls.join('|').length > MAX_QUERY_LEN) {
    if (handoffOk) {
      // 几十集拼进 query 会顶爆地址栏。以前是截成 31 集的窗口——等于偷偷丢集数，
      // 现在整份走交接槽，一集不少
      params.set('handoff', '1')
    } else {
      // localStorage 满了/被禁 → 只能退回 query，带得下多少算多少
      params.set('urls', urls.slice(0, 31).join('|'))
      params.set('index', String(Math.min(idx, 30)))
      toast.add({ title: '浏览器存储不可用，本次只带 31 集', color: 'orange' })
    }
  } else {
    params.set('urls', urls.join('|'))
    params.set('index', String(idx))
  }

  // 把「视频是从哪个站点解析出来的」当防盗链候选值带过去。
  // 这类站点的防盗链认的是播放页域名，而视频常挂在毫不相干的 CDN 上
  //（实测视频在 vod1.maowushi.com、防盗链认 aeete.com），播放器光看视频地址永远推不出来。
  //
  // 只是**候选值**，不是强制配置：播放器的可达性探测仍按 直连 → 代理·伪装 → 用这对头 → 主域
  // 的顺序逐级降级，直连能通就走直连，带上它不会平白多绕一层代理。
  //
  // 走 parseUrl 时播放器自己解析也能拿到这对头，但命中交接槽那条路不会重新解析，
  // 所以这里仍要带上。规则显式声明的那对头优先（那是站点作者写死的正确值）：
  // 有的站点视频只认某个第三方域名，播放页域名照样 403
  //（实测 netflixgc.net → cjbfq.netflixgc.tv），这时拿播放页 origin 兜底反而是错的。
  const srcOrigin = originOfPage(result.value?.pageUrl || inputUrl.value)
  if (result.value?.referer) params.set('referer', result.value.referer)
  else if (srcOrigin) params.set('referer', srcOrigin + '/')
  const playOrigin = result.value?.origin || srcOrigin
  if (playOrigin) params.set('origin', playOrigin)

  navigateTo('/video-player?' + params.toString())
}

const copyOne = async (url: string) => {
  await navigator.clipboard.writeText(url)
  toast.add({ title: '已复制', color: 'green' })
}

const copyAll = async () => {
  const text = resolvedEpisodes.value.map(e => e.videoUrl).join('\n')
  if (!text) return
  await navigator.clipboard.writeText(text)
  toast.add({ title: `已复制 ${resolvedEpisodes.value.length} 条地址`, color: 'green' })
}

const clearAllHistory = () => {
  clearHistory()
  parseHistory.value = []
}

onMounted(() => {
  userRules.value = loadUserParseRules()
  // 支持 /video-parse?url=…&line=N 直接带地址进来自动解析
  const q = parseQueryParams()
  if (q.url) {
    inputUrl.value = q.url
    startResolve(q.line)
  }
})
</script>
