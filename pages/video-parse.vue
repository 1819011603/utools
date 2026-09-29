<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <!--
      左侧悬浮的媒体库（播放历史 + 收藏影片），与放映厅、搜索页共用同一个组件。
      解析页上最常见的下一步就是「接着看昨天那部」，而那条记录本来就在这儿
    -->
    <LibraryDock />

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
            <!-- 收藏：与播放器侧边抽屉里那份是同一份清单（按剧名存、跟着账号同步），
                 所以在这里点一下，换台设备打开播放器就能在「收藏影片」里看到它 -->
            <UButton
              size="xs"
              variant="ghost"
              :color="faved ? 'rose' : 'gray'"
              :icon="faved ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'"
              :title="faved ? '取消收藏' : '收藏这部剧，播放器侧边栏里能直接点开'"
              @click="toggleFavCurrent"
            >
              {{ faved ? '已收藏' : '收藏' }}
            </UButton>
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
              :title="busy ? '正在解析，稍候' : '在新标签页打开播放器'"
              @click="requestPlay()"
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
          :description="`这条线路给的不是视频地址，而是第三方站点（爱奇艺 / 芒果 / 腾讯等）的播放页，真实地址由站点自带的解析服务在浏览器里现算，服务端拿不到。这里直接内嵌它的播放器：能播，但画质、广告、进度条都是它的，我们的抗卡、下载、倍速在这条线路上都用不了。${embedSandbox ? '已勾选「限制广告」：广告的弹窗和整页跳转会被挡住，但部分播放器（如超清EV线）会因此拒绝播放，播不了就取消勾选。' : '播放器拥有完整权限，点画面时可能弹出广告或整页跳去广告站（浏览器回退可返回）；想挡住就勾上「限制广告」，代价是部分线路会拒绝播放。'}想用本站播放器请换一条给直链的线路。`"
        />

        <!-- 内嵌播放器 -->
        <div v-if="isEmbedLine" class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
              <template v-if="embedIndex >= 0">正在播放：{{ currentLine?.episodes[embedIndex]?.title || `第 ${embedIndex + 1} 集` }}</template>
              <template v-else>内嵌播放器</template>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <UTooltip v-if="embedSrc" text="快捷键 Enter 全屏 / Esc 退出（焦点落进播放器后按键归它，点一下播放器外面即可恢复）">
                <UButton
                  size="xs"
                  variant="ghost"
                  icon="i-heroicons-arrows-pointing-out"
                  @click="toggleEmbedFullscreen()"
                >
                  全屏
                </UButton>
              </UTooltip>
              <!-- 「限制广告」= 给 iframe 挂 sandbox。默认关（见 EMBED_SANDBOX 的注释：
                   开着的话超清EV线这类探 sandbox 的播放器一帧都播不出来）。
                   开关而不是确认弹窗：它是个能来回切的状态，不是一次性授权 -->
              <UTooltip
                v-if="embedSrc"
                :text="embedSandbox ? '已挡住广告的顶层跳转。部分播放器（如超清EV线）会因此拒绝播放' : '播放器拥有完整权限，点画面可能被广告劫持整页跳转'"
              >
                <UCheckbox v-model="embedSandbox" label="限制广告" :ui="{ label: 'text-xs' }" />
              </UTooltip>
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
          </div>
          <!-- 全屏的是这个外框而不是 iframe 本身：iframe 全屏后我们的边框圆角、
               「正在获取地址」那层遮罩全都跟不进去，退出时还会闪一下 -->
          <div
            ref="embedStage"
            class="relative w-full rounded-lg overflow-hidden bg-black"
            :class="isEmbedFullscreen ? 'h-full rounded-none' : ''"
            :style="isEmbedFullscreen ? undefined : 'aspect-ratio: 16 / 9'"
          >
            <!-- key 里必须带上 sandbox 档位：sandbox 是文档创建时定死的，光改属性不重建
                 iframe 一点用没有，切开关会看着毫无变化（Vue 只会 patch 属性） -->
            <iframe
              v-if="embedSrc"
              :key="embedSrc + (embedSandbox ? '#box' : '')"
              :src="embedSrc"
              class="absolute inset-0 w-full h-full"
              allowfullscreen
              allow="fullscreen; encrypted-media; autoplay"
              :sandbox="embedSandbox ? EMBED_SANDBOX : undefined"
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

        <!-- 可达性检测：只在手上真有一条已解析地址时出现（内嵌线路、不给直链的线路没有可测的东西）。
             按需取址的站点这里只有当前那一集，测它即可——同一条线路各集的域名和防盗链通常一致 -->
        <VideoParseReachCheck
          v-if="checkTarget"
          :url="checkTarget.url"
          :ep-title="checkTarget.title"
          :origin="hintOrigin"
          :referer="hintReferer"
          @status="reach = $event"
        />

        <!--
          续看条：重新搜一遍、重新解析之后，页面上一切都从第 1 集开始，而「上次看到第几集」
          只存在播放器自己的状态里，解析页看不到——用户只能靠回忆或一集一集点过去试（原话
          「假设我今天看了10集，我重新搜索解析，我只能从第一集开始看」）。
          记录按**剧名**存（见 useWatchHistory），所以换站、换线路也能续上。
        -->
        <div
          v-if="resumeTarget"
          class="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-gradient-to-r from-violet-50 to-rose-50
                 dark:from-violet-500/10 dark:to-rose-500/10 ring-1 ring-violet-200/70 dark:ring-violet-400/20"
        >
          <UIcon name="i-heroicons-clock" class="w-4 h-4 shrink-0 text-violet-500" />
          <span class="text-sm">
            上次看到
            <b class="text-violet-600 dark:text-violet-300">第 {{ resumeTarget.index + 1 }} 集</b>
            <span v-if="resumeTarget.epName && resumeTarget.epName !== String(resumeTarget.index + 1)" class="text-gray-500">
              （{{ resumeTarget.epName }}）
            </span>
            <span v-if="resumeWatch?.total" class="text-xs text-gray-400">/ 共 {{ resumeWatch.total }} 集</span>
            <!-- 线路对不上要说出来：同一部剧不同线路的集数可能不一样，续看落点只能按集名/序号猜 -->
            <span v-if="resumeOtherLine" class="text-xs text-amber-600 dark:text-amber-400">
              · 当时看的是「{{ resumeWatch?.lineName }}」
            </span>
          </span>
          <div class="flex items-center gap-2 ml-auto">
            <UButton size="xs" icon="i-heroicons-play" @click="requestPlay(resumeTarget.index)">
              继续观看
            </UButton>
            <UButton size="xs" variant="ghost" color="gray" @click="dismissResume">不用了</UButton>
          </div>
        </div>

        <!-- 选集 -->
        <div class="space-y-2">
          <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
            <template v-if="isEmbedLine">选集（共 {{ currentLine?.episodes.length || 0 }} 集，点一集在上面的内嵌播放器里播）</template>
            <template v-else-if="isLazy">选集（共 {{ currentLine?.episodes.length || 0 }} 集，播到哪集取哪集；点一集在新标签播）</template>
            <template v-else>
              选集（{{ resolvedCount }}/{{ currentLine?.episodes.length || 0 }} 解析成功；点一集在新标签播，右键复制该集地址）
            </template>
          </div>
          <!-- 网格排布，与播放器的 PlaylistPanel 同一套：几十集竖着列要滚好几屏，
               横着摆一眼就能扫到目标集（73 集一屏看完）。
               代价是每格只放得下集名——单集复制挪到右键，「复制全部地址」在卡片头上 -->
          <div class="max-h-80 overflow-y-auto p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 gap-2">
              <button
                v-for="(ep, i) in currentLine?.episodes || []"
                :key="i"
                type="button"
                :disabled="busy || !epPlayable(ep)"
                class="rounded text-sm text-center px-2 py-2 truncate transition-colors"
                :class="[
                  isEmbedLine && i === embedIndex
                    ? 'bg-violet-500 text-white font-medium'
                    : epPlayable(ep)
                      ? 'bg-white dark:bg-gray-700 hover:bg-violet-100 dark:hover:bg-gray-600 cursor-pointer'
                      : 'bg-white/50 dark:bg-gray-700/40 text-gray-400 cursor-not-allowed',
                  busy ? 'opacity-60' : '',
                ]"
                :title="epTip(ep, i)"
                @click="epClick(ep, i)"
                @contextmenu.prevent="ep.videoUrl && copyOne(ep.videoUrl)"
              >
                <!-- 内嵌线路点一集要现去取地址（好几秒），转圈就画在那一格里，
                     否则点完毫无反应，只能盯着上面的播放器猜 -->
                <UIcon
                  v-if="isEmbedLine && embedPending === i"
                  name="i-heroicons-arrow-path"
                  class="w-3.5 h-3.5 inline-block mr-1 align-text-bottom animate-spin"
                />
                {{ ep.title || `第 ${i + 1} 集` }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- 播放前的二次确认：只在可达性检测没通过时出现（通过了直接开新标签，不打扰） -->
    <UModal v-model="confirmOpen">
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              :name="reach.verdict?.severity === 'fatal' ? 'i-heroicons-x-circle' : 'i-heroicons-exclamation-triangle'"
              class="w-5 h-5 shrink-0"
              :class="reach.verdict?.severity === 'fatal' ? 'text-red-500' : 'text-amber-500'"
            />
            <span class="font-medium">{{ playGuard.title }}</span>
          </div>
        </template>
        <p class="text-sm text-gray-600 dark:text-gray-300">{{ playGuard.detail }}</p>
        <p class="mt-3 text-xs text-gray-400">
          换一条线路通常比硬着头皮播更快——左边那排线路点一下就会自动重测。
        </p>
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="gray" variant="ghost" @click="confirmOpen = false">先不播</UButton>
            <!-- 不做成 primary：这是「知道有风险还要继续」的那一侧 -->
            <UButton color="amber" variant="soft" icon="i-heroicons-play" @click="confirmPlay">
              仍要播放
            </UButton>
          </div>
        </template>
      </UCard>
    </UModal>

    <!-- 历史 -->
    <UCard v-if="parseHistory.length">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium">
            解析历史
            <span class="font-normal text-xs text-gray-400">· {{ parseHistory.length }} 条</span>
          </span>
          <div class="flex items-center gap-2">
            <!-- 「永久保存」得说得起来：能不能永久取决于浏览器给不给持久化授权，
                 拿不到就如实标出来（Safari 尤其现实：7 天不来就清，而它压根没有这个 API） -->
            <UBadge
              v-if="storagePersisted === true"
              color="green" variant="subtle" size="xs"
              title="浏览器已授予持久化存储：磁盘吃紧时不会被自动清掉。手动「清除浏览数据」仍会清"
            >
              已持久化
            </UBadge>
            <UBadge
              v-else-if="storagePersisted === false"
              color="amber" variant="subtle" size="xs"
              title="浏览器没给持久化授权：磁盘吃紧时可能被清；Safari 上 7 天不访问就会清。把本站加为书签/添加到主屏幕能提高授权几率"
            >
              未持久化
            </UBadge>
            <UButton size="xs" variant="ghost" color="red" @click="clearAllHistory">清空</UButton>
          </div>
        </div>
      </template>
      <!-- 上限提到 2000 条，撑开卡片就没法看了 → 限高滚动 -->
      <div class="space-y-1 max-h-96 overflow-y-auto">
        <div
          v-for="(h, i) in parseHistory"
          :key="i"
          class="flex items-center gap-2 p-2 rounded text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
          @click="inputUrl = h.data.url; startResolve()"
        >
          <UIcon name="i-heroicons-clock" class="w-4 h-4 shrink-0 text-gray-400" />
          <!-- 站点徽标：优先规则表里的中文站名，认不出（规则删了/改了 pattern）才退回裸域名。
               光有片名认不出是哪来的——同一部片在好几个站都有，而各站的线路和防盗链完全不同 -->
          <UBadge :color="historySite(h.data.url).known ? 'violet' : 'gray'" variant="subtle" size="xs" class="shrink-0">
            {{ historySite(h.data.url).label }}
          </UBadge>
          <span class="flex-1 truncate">{{ h.data.title || h.data.url }}</span>
          <span class="text-xs text-gray-400 shrink-0">{{ formatWhen(h.timestamp) }}</span>
          <!-- 回原网页。**必须 @click.stop**：外层那一整行点了就重新解析，
               不拦住的话点这个图标会既开新标签又跑一遍解析 -->
          <UButton
            :to="h.data.url"
            target="_blank"
            rel="noopener"
            size="2xs"
            variant="ghost"
            color="gray"
            icon="i-heroicons-arrow-top-right-on-square"
            title="在新标签页打开原网页"
            class="shrink-0"
            @click.stop
          />
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useVideoParseResolve } from '~/composables/useVideoParseResolve'
import { useVideoParsePlay } from '~/composables/useVideoParsePlay'
import { useVideoParseEmbed } from '~/composables/useVideoParseEmbed'
import { useVideoParseHistory } from '~/composables/useVideoParseHistory'

const vp = useVideoParseResolve()
const { inputUrl, busy, stage, error, result, powTried, powPercent, supportedSites, matchedRule, historySite, currentLine, resolvedCount, isLazy, playableCount, checkTarget, hasSignedUrl, deadLines, parseHistory, storagePersisted, resumeWatch, startResolve } = vp
const { reach, confirmOpen, playGuard, requestPlay, confirmPlay, hintOrigin, hintReferer } = useVideoParsePlay(vp)
const { isEmbedLine, embedSrc, embedIndex, embedSandbox, embedPending, EMBED_SANDBOX, embedStage, isEmbedFullscreen, toggleEmbedFullscreen, epPlayable, epClick, epTip } = useVideoParseEmbed(vp, requestPlay)
const { resumeTarget, resumeOtherLine, dismissResume, faved, toggleFavCurrent, formatWhen, copyPageLink, copyOne, copyAll, clearAllHistory } = useVideoParseHistory(vp)
</script>
