<script setup lang="ts">
/**
 * 音乐：搜索、播放、下载 mp3 / flac。
 *
 * 本文件只做装配（建控制器 → provide → 接生命周期），逻辑在 composables/musicPlayer/，
 * 站点差异在 composables/musicSites/，UI 在 components/music/（同 video-player 那套样板）。
 *
 * **单页 + 底部常驻播放条**，不做「搜索页 + 播放页」两页：
 * 音乐是边听边干别的的事，搜下一首不该把正在听的打断。
 */
import type { MusicSearchRow, MusicSiteId } from '~/composables/musicSites/types'
import { rowToTrack, siteById } from '~/composables/musicSites'
import { MUSIC_PLAYER_KEY, useMusicPlayerController } from '~/composables/musicPlayer/useMusicPlayerController'
import { useMusicResolveGate } from '~/composables/musicPlayer/useMusicResolveGate'

useHead({ title: '音乐 · 晚风' })

// ── 取址闸门 ──
// 站点限流是**静默**的（照常回 200、只是不给地址），所以只能从发送侧下手：
// 全站所有取址都从这一个闸门过，按站点串行 + 退避。详见 useMusicResolveGate 的文件注释。
//
// 闸门本身**一个站点都不认识**，这三个回调就是它与注册表之间唯一的接缝。
const gate = useMusicResolveGate({
  tiersOf: site => siteById(site)?.tiers.map(t => t.tier) ?? [],
  fetchOne: (site, id, tier, signal) => {
    const s = siteById(site)
    // 收藏里可能留着已经下线的站点名，说清是「不认识这个源」而不是「这首没资源」
    if (!s) throw new Error(`不认识「${site}」这个音乐源，可能是收藏里的旧数据`)
    return s.resolve(id, tier, signal)
  },
  // 返回 undefined 的站点就没有「每日配额」这回事（fangpi 就是），闸门据此不为它准备停手那条路
  quotaHintOf: site => siteById(site)?.quotaHint,
})

const player = useMusicPlayerController({ resolve: gate.resolveTrack })
provide(MUSIC_PLAYER_KEY, player)

const {
  urlInput, playDirectUrl, setQueue, current, isResolving, errorMessage, errorKind,
  downloadTrack, showDownloads, showFavorites, showQueue, showLyrics, mount, unmount,
} = player

// 收藏是页面级能力，不经过播放器上下文（播放器不该认识「收藏」这回事）
const { favoriteKeys, toggleFavorite, refreshMeta } = useMusicFavorites()

/*
 * 收藏里存的是**收藏那一刻**的元数据，而封面要等取址（也就是播过一次）之后才有
 * ——搜出来直接点心收藏的那些，存下来时压根没有封面，在收藏列表里是一片灰块，
 * 看着像图挂了。播到哪首就把那条补上（只补已收藏的，不会因为播过就自动收藏）。
 * 这一层也放在页面而不是播放器里，理由同上。
 */
watch(() => current.value?.cover, (cover) => {
  if (cover && current.value) refreshMeta(current.value)
})

// ── 搜索 ──
const { keyword, sections, searching, emptyResult, search, loadMore, retry } = useMusicSearch()

/** 正在取址的那首，用来在结果行上画转圈 */
const resolvingKey = computed(() => (isResolving.value ? current.value?.key : undefined))
const currentKey = computed(() => current.value?.key)

/**
 * 撞上配额/限流的音乐源。**按站点一条条报**——
 * 24bit 配额用完时 fangpi 照常能用，摆一句笼统的「音乐站不可用」等于把好的那条路也一起否了。
 */
const troubles = computed(() =>
  gate.troubledSites.value
    .map(id => siteById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map(site => ({
      site,
      quota: gate.isQuotaOut(site.id),
      // 服务端写的停手理由。429 只说了「停」，为什么停只有它知道
      reason: gate.stopReason.value[site.id],
    })),
)

/**
 * 点某个音质档就播。**整段都装进队列**（不是只放这一首），
 * 这样「播完自动下一首」立刻可用——用户点第 3 首，后面的自然接着播。
 *
 * 用户点的那个档作为 `preferred` 传下去，闸门会先试它；那个档没资源时再退同站点的别的档。
 * 队列里其余曲目跟随同一个档 —— 用户选了「无损」，不该播到第二首忽然变成 100MB 的环绕声。
 */
const onPlay = async (_row: MusicSearchRow, tier: string, list: MusicSearchRow[], index: number) => {
  await setQueue(list.map(r => rowToTrack(r, tier)), index)
}

const onFavorite = (row: MusicSearchRow) => {
  toggleFavorite(rowToTrack(row))
}

/**
 * 下载。走的是同一个取址闸门，所以点了不一定立刻开始 —— 面板里有排队状态。
 * 下载默认用该站点的第一个音质档；要另一个档就先播那个档再下（播过之后 locator 记住了）。
 */
const onDownload = (row: MusicSearchRow, tier: string) => {
  downloadTrack(rowToTrack(row, tier))
  showDownloads.value = true
}

/**
 * 取址失败时把闸门的措辞接过来。
 * 引擎那句是通用文案，闸门这句知道「这首是哪个源的、那个源最近连续失败了几次、它有几个档」，
 * 能判断该说「换个档」还是「换个源」还是「被限流了」—— 而这些在响应上完全无法区分。
 */
watch(errorKind, (k) => {
  if (k === 'resolve') {
    errorMessage.value = gate.failureMessage(current.value?.resolver, current.value?.name)
  }
})

onMounted(mount)
onBeforeUnmount(unmount)
</script>

<template>
  <!--
    左边距给常驻侧边栏让位（窄屏它是盖上来的抽屉，不占位）。
    padding 挂在**外层**、`max-w-4xl mx-auto` 留在内层：写在同一个元素上会和 `px-4` 打架，
    而两者谁赢取决于 Tailwind 生成的顺序，不取决于这里写的先后。
  -->
  <div
    class="transition-[padding] duration-300 ease-out"
    :class="showFavorites ? 'lg:pl-72' : 'lg:pl-14'"
  >
    <!-- pb 给底部那条常驻播放条让位，否则页面最后一屏内容会被永久盖住 -->
    <div class="max-w-4xl mx-auto px-4 py-6 pb-32 space-y-6">
      <div>
        <h1 class="text-2xl font-semibold">音乐</h1>
        <p class="text-sm text-gray-500 mt-1">
          搜索、在线播放与下载 mp3 / flac。播放与下载都由浏览器直连音源，不经过服务器中转。
        </p>
      </div>

      <MusicSearchBar :searching="searching" @search="search" />

      <!--
        这些提示常驻（toast 会消失，而这两个状态要持续很久），且必须**按音乐源分开**：
        配额用完是「这个源今天到此为止」，限速是「等几分钟」，出路完全不同，
        混成一句「暂时不可用」等于什么都没说，还会把另一个照常能用的源一起否掉。
      -->
      <template v-for="t in troubles" :key="t.site.id">
        <!--
          「停手」有两种理由，**措辞不能共用一句**：24bit 是每日配额（明天见、登录可续），
          fangpi 是站点要人机验证（过一次校验或等几分钟就能继续，它压根没有配额这回事）。
          理由原文由服务端给（`gate.stopReason`），这里只负责摆出来。
        -->
        <UAlert
          v-if="t.quota"
          :icon="t.site.quotaHint ? 'i-heroicons-clock' : 'i-heroicons-shield-exclamation'"
          color="orange"
          variant="soft"
          :title="t.site.quotaHint ? `${t.site.name} 今日配额已用完` : `${t.site.name} 暂时停手了`"
          :actions="t.site.loginUrl
            ? [{ label: `去 ${t.site.name} 登录`, color: 'orange', variant: 'ghost', to: t.site.loginUrl, target: '_blank' }]
            : []"
        >
          <template #description>
            <template v-if="t.site.quotaHint">
              该源对<strong>匿名访问按天限量</strong>，明天会自动恢复。
              搜索不受影响，其他音乐源也照常可用。
            </template>
            <template v-else>
              {{ t.reason || '这个源暂时不肯给地址了，等几分钟再试。搜索不受影响，其他音乐源也照常可用。' }}
            </template>
          </template>
        </UAlert>

        <UAlert
          v-else
          icon="i-heroicons-hand-raised"
          color="amber"
          variant="soft"
          :title="`${t.site.name} 连续几首都取不到地址`"
          description="可能是这个源在限速，等几分钟再试。搜索仍然可用，也可以换另一个音乐源。"
        />
      </template>

      <MusicResultList
        :sections="sections"
        :keyword="keyword"
        :empty-result="emptyResult"
        :resolving-key="resolvingKey"
        :current-key="currentKey"
        :favorite-keys="favoriteKeys"
        @play="onPlay"
        @download="onDownload"
        @favorite="onFavorite"
        @load-more="(site: MusicSiteId) => loadMore(site)"
        @retry="(site: MusicSiteId) => retry(site)"
      />

      <!-- 歌词和下载留在页面流里：一个是要整段读的长文，一个是要盯着进度的任务，
           两者都不是「看一眼就关」。收藏在左侧常驻栏、队列在右侧抽屉，各自的理由见那两个组件 -->
      <MusicLyrics v-if="showLyrics" />
      <MusicDownloadPanel v-if="showDownloads" />

      <!--
        直链框收进折叠区：它是「播放器不绑定任何站点」的实证（也是排查入口），
        但日常用不到，摆在上面会把搜索这个主角挤下去。
      -->
      <details class="group">
        <summary class="cursor-pointer text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 select-none">
          <UIcon name="i-heroicons-link" class="w-4 h-4 inline-block align-text-bottom" />
          播放音频直链（mp3 / flac / m4a…）
        </summary>
        <div class="mt-3 flex gap-2">
          <UInput
            v-model="urlInput"
            placeholder="https://example.com/song.flac"
            class="flex-1"
            size="sm"
            @keyup.enter="playDirectUrl(urlInput)"
          />
          <UButton size="sm" color="gray" :disabled="!urlInput.trim()" @click="playDirectUrl(urlInput)">
            播放
          </UButton>
        </div>
        <p class="mt-2 text-xs text-gray-400">
          任何浏览器能解的音频地址都能播，与上面的搜索无关。
        </p>
      </details>

    </div>
  </div>

  <!-- 侧边栏和播放条都是 fixed 的，摆在内容外层：放进上面那个带左内边距的容器里，
       等于让它自己给自己让位，展开时会越推越远 -->
  <MusicSideLibrary />
  <MusicQueuePanel />
  <MusicPlayerBar />
  <MusicImmersive />
</template>
