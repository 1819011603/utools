<script setup lang="ts">
/**
 * 音乐：搜索、播放、下载 mp3 / flac。
 *
 * 本文件只做装配（建控制器 → provide → 接生命周期），逻辑在 composables/musicPlayer/，
 * UI 在 components/music/（同 video-player 那套样板）。
 *
 * **单页 + 底部常驻播放条**，不做「搜索页 + 播放页」两页：
 * 音乐是边听边干别的的事，搜下一首不该把正在听的打断。
 */
import type { MusicSearchRow, MusicSourceId } from '~/composables/music24bit'
import { rowToTrack } from '~/composables/music24bit'
import { MUSIC_PLAYER_KEY, useMusicPlayerController } from '~/composables/musicPlayer/useMusicPlayerController'
import { useMusicResolveGate } from '~/composables/musicPlayer/useMusicResolveGate'

useHead({ title: '音乐 · 晚风' })

// ── 取址闸门 ──
// 站点限流是**静默**的（照常回 200、只是不给地址），所以只能从发送侧下手：
// 全站所有取址都从这一个闸门过，串行 + 退避。详见 useMusicResolveGate 的文件注释。
const gate = useMusicResolveGate({
  fetchOne: (id, src, signal) =>
    // 详情页 HTML 没有 ACAO，浏览器跨域取不到 → 这一段必须经服务端。
    // （搜索接口和 CDN 都是 ACAO:*，那两段前端直连，见 music24bit.ts 的分层说明）
    $fetch(`/api/music/resolve`, { query: { id, src }, signal }),
})

const player = useMusicPlayerController({ resolve: gate.resolveTrack })
provide(MUSIC_PLAYER_KEY, player)

const { urlInput, playDirectUrl, setQueue, current, isResolving, errorMessage, errorKind, mount, unmount } = player

// ── 搜索 ──
const { keyword, states, searching, emptyResult, search, loadMore, retry } = useMusicSearch()

/** 正在取址的那首，用来在结果行上画转圈 */
const resolvingKey = computed(() => (isResolving.value ? current.value?.key : undefined))
const currentKey = computed(() => current.value?.key)

/**
 * 点一行就播。**整个音源列表都装进队列**（不是只放这一首），
 * 这样「播完自动下一首」立刻可用——用户点第 3 首，后面 27 首自然接着播。
 */
const onPlay = async (_row: MusicSearchRow, _source: MusicSourceId, list: MusicSearchRow[], index: number) => {
  await setQueue(list.map(rowToTrack), index)
}

/**
 * 取址失败时把闸门的措辞接过来。
 * 引擎那句是通用文案，闸门这句知道「最近连续失败了几次」，能判断该偏向
 * 「这个音源没资源」还是「被限流了」—— 而这两种情况在响应上完全无法区分。
 */
watch(errorKind, (k) => {
  if (k === 'resolve') errorMessage.value = gate.failureMessage(current.value?.name)
})

const searchBar = ref<{ submit: (kw?: string) => void }>()

onMounted(mount)
onBeforeUnmount(unmount)
</script>

<template>
  <!-- pb 给底部那条常驻播放条让位，否则页面最后一屏内容会被永久盖住 -->
  <div class="max-w-4xl mx-auto px-4 py-6 pb-32 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">音乐</h1>
      <p class="text-sm text-gray-500 mt-1">
        搜索、在线播放与下载 mp3 / flac。播放与下载都由浏览器直连音源，不经过服务器中转。
      </p>
    </div>

    <MusicSearchBar ref="searchBar" :searching="searching" @search="search" />

    <!-- 限流提示常驻：toast 会消失，而这个状态要持续好几分钟 -->
    <UAlert
      v-if="gate.rateLimited.value"
      icon="i-heroicons-hand-raised"
      color="amber"
      variant="soft"
      title="可能被站点限流了"
      description="连续几首都取不到播放地址。等几分钟再试，期间搜索仍然可用。"
    />

    <MusicResultList
      :states="states"
      :keyword="keyword"
      :empty-result="emptyResult"
      :resolving-key="resolvingKey"
      :current-key="currentKey"
      @play="onPlay"
      @load-more="loadMore"
      @retry="retry"
    />

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

  <MusicPlayerBar />
</template>
