<script setup lang="ts">
/**
 * 搜索结果：**音乐源做成横向页签**，点一下切换，一次只显示一个源的结果。
 *
 * 为什么不是「一个源一段、上下堆叠」：24bit 一搜就是几十条，把第二个源顶到几屏以外 ——
 * 用户要的是「这首歌在另一个源上是什么样」，那得是**一次点击**的事，不是滚半天。
 * 页签上直接写着各源的条数，所以不点也知道那边有没有货。
 *
 * 也不混排：两个源音质差一档（无损 flac vs 128K MP3），那正是用户要拿来做选择的东西，
 * 混进一张网格里就分不清哪条是哪个源的了。
 *
 * 源**内部**仍然把它自己的几条泳道交替混排（24bit 的「音源一/二」就此退到幕后），
 * 那一层在 `useMusicSearch` 里合并完了，这里只管画。
 *
 * 播放/收藏/下载一律 emit 给页面 —— 收藏和下载是页面级能力，不属于播放器上下文。
 */
import type { MusicSearchRow, MusicSiteId } from '~/composables/musicSites/types'
import type { MusicSection } from '~/composables/useMusicSearch'
import { trackKeyOf } from '~/composables/musicSites'

const props = defineProps<{
  sections: MusicSection[]
  keyword: string
  /** 所有音乐源都搜完了且一条都没有。这时候只说一句话，别摆一排空页签 */
  emptyResult: boolean
  /** 正在取址的那首的 key，用来在对应卡片上画转圈 */
  resolvingKey?: string
  favoriteKeys?: Set<string>
  currentKey?: string
}>()

const emit = defineEmits<{
  (e: 'play', row: MusicSearchRow, tier: string, list: MusicSearchRow[], index: number): void
  (e: 'download', row: MusicSearchRow, tier: string): void
  (e: 'favorite', row: MusicSearchRow): void
  (e: 'loadMore', site: MusicSiteId): void
  (e: 'retry', site: MusicSiteId): void
}>()

const keyOf = (row: MusicSearchRow) => trackKeyOf(row.site, row.id)

/**
 * 用户手点过的页签。`null` = 还没点过，这时按「第一个有结果的源」自动选。
 *
 * **一旦他点过就不再自动跳**：几个源是陆续回来的，自动跳会在他正看着的时候把页签换掉
 * （同 video-search 那边「自动选中第一个有结果的站」踩过的坑）。
 */
const picked = ref<MusicSiteId | null>(null)

/** 换关键词就重新自动选：上一次选的那个源对新词可能一条都没有 */
watch(() => props.keyword, () => { picked.value = null })

const activeId = computed<MusicSiteId | undefined>(() =>
  picked.value
  ?? props.sections.find(s => s.rows.length)?.site.id
  ?? props.sections[0]?.site.id,
)

const active = computed(() => props.sections.find(s => s.site.id === activeId.value))

/**
 * 用户点的是哪一档。**只让被点的那颗转圈** ——
 * 早先只按 `resolvingKey === keyOf(row)` 判断，同一行的两颗按钮都成立，
 * 于是点「无损音质」时「高清环绕声」也跟着转，看着像两个档同时在取址（并没有）。
 */
const pickedTier = ref<{ key: string; tier: string } | null>(null)

const isTierLoading = (row: MusicSearchRow, tier: string) =>
  props.resolvingKey === keyOf(row)
  && pickedTier.value?.key === keyOf(row)
  && pickedTier.value?.tier === tier

const onPickTier = (row: MusicSearchRow, tier: string, index: number) => {
  pickedTier.value = { key: keyOf(row), tier }
  // 整个页签的列表都装进队列（不是只放这一首），这样「播完自动下一首」立刻可用
  emit('play', row, tier, active.value?.rows ?? [], index)
}

// 取址结束（不论成败）就把转圈状态收掉，否则那颗按钮会一直转下去
watch(() => props.resolvingKey, (k) => { if (!k) pickedTier.value = null })
</script>

<template>
  <div v-if="keyword" class="space-y-4">
    <!-- 所有源都没有 → 一句话说完，别摆一排「这个源没有」 -->
    <div v-if="emptyResult" class="py-12 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300" />
      <p>没有找到「{{ keyword }}」，换个关键词试试</p>
    </div>

    <template v-else>
      <!--
        横向页签。**条数直接写在页签上**：不点也看得出另一个源有没有货，
        否则用户没有理由去点第二下（而那正是接第二个源的全部意义）。
      -->
      <div class="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        <button
          v-for="s in sections"
          :key="s.site.id"
          type="button"
          class="shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors flex items-center gap-1.5"
          :class="s.site.id === activeId
            ? 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300 font-medium'
            : 'border-gray-200 dark:border-gray-800 text-gray-500 hover:border-gray-300 dark:hover:border-gray-700'"
          @click="picked = s.site.id"
        >
          <span>{{ s.site.name }}</span>
          <UIcon v-if="s.searching" name="i-heroicons-arrow-path" class="w-3 h-3 animate-spin" />
          <span v-else-if="s.rows.length" class="text-xs tabular-nums opacity-70">{{ s.rows.length }}</span>
          <UIcon v-else-if="s.failed" name="i-heroicons-exclamation-triangle" class="w-3 h-3 text-amber-500" />
        </button>

        <!-- 当前源的音质一句话。跟着页签走，切换时一眼看出这一档是什么 -->
        <span v-if="active" class="ml-auto shrink-0 text-xs text-gray-400 hidden sm:block">
          {{ active.site.tagline }}
        </span>
      </div>

      <template v-if="active">
        <!-- 窄屏放不下就挪到页签下面，别把它挤掉 -->
        <p class="text-xs text-gray-400 sm:hidden">{{ active.site.tagline }}</p>

        <!-- 这个源整个挂了。别的源照常能用，所以只在它自己的页签里报 -->
        <div
          v-if="active.failed"
          class="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 p-4 flex items-center gap-3 text-sm"
        >
          <UIcon name="i-heroicons-exclamation-triangle" class="w-5 h-5 text-amber-500 shrink-0" />
          <span class="text-gray-600 dark:text-gray-300 min-w-0 flex-1">{{ active.error }}</span>
          <UButton size="2xs" color="gray" @click="emit('retry', active.site.id)">重试</UButton>
        </div>

        <div v-else-if="active.searching && !active.rows.length" class="py-10 text-center text-sm text-gray-500">
          <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin" />
        </div>

        <div v-else-if="!active.rows.length" class="py-10 text-center text-sm text-gray-500">
          这个音乐源没有「{{ keyword }}」，换上面另一个页签试试
        </div>

        <div v-else class="grid gap-3 sm:grid-cols-2">
          <div
            v-for="(row, i) in active.rows"
            :key="row.id"
            class="rounded-xl border p-3 flex gap-3 transition-colors"
            :class="currentKey === keyOf(row)
              ? 'border-primary-300 dark:border-primary-700 bg-primary-50/50 dark:bg-primary-950/20'
              : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'"
          >
            <div class="min-w-0 flex-1 space-y-0.5">
              <div class="truncate font-medium text-sm" :title="row.name">
                {{ row.name }}
              </div>
              <!-- 专辑不是每个源都给（fangpi 的搜索页就没有），所以「有才显示」 -->
              <div v-if="row.album" class="truncate text-xs text-gray-400" :title="row.album">
                专辑：{{ row.album }}
              </div>
              <div class="truncate text-xs text-primary-600 dark:text-primary-400" :title="row.player">
                {{ row.player }}
              </div>
            </div>

            <div class="shrink-0 flex flex-col items-end gap-1">
              <!--
                档位一律都摆出来，点了才取址。事先探测「哪个档有资源」要对每首发多次请求，
                一页 30 首就是 60 发，必被静默限流（见 site24bit.ts 的说明）。
              -->
              <UButton
                v-for="q in active.site.tiers"
                :key="q.tier"
                size="2xs"
                :color="q.color"
                variant="soft"
                :loading="isTierLoading(row, q.tier)"
                :title="q.hint"
                @click="onPickTier(row, q.tier, i)"
              >
                {{ q.label }}
              </UButton>
              <div class="flex gap-0.5 pt-0.5">
                <UButton
                  :icon="favoriteKeys?.has(keyOf(row)) ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'"
                  :color="favoriteKeys?.has(keyOf(row)) ? 'primary' : 'gray'"
                  variant="ghost"
                  size="2xs"
                  aria-label="收藏"
                  @click="emit('favorite', row)"
                />
                <UButton
                  icon="i-heroicons-arrow-down-tray"
                  color="gray"
                  variant="ghost"
                  size="2xs"
                  aria-label="下载"
                  @click="emit('download', row, active.site.tiers[0].tier)"
                />
              </div>
            </div>
          </div>
        </div>

        <!--
          「加载更多」只对分页的源有意义。**不分页的源（pageSize 0）一个字都不写**：
          画一颗按了没反应的按钮，比没有更让人以为坏了。
        -->
        <div v-if="active.rows.length && active.site.pageSize > 0" class="text-center space-y-1.5">
          <!--
            这个源里**只挂了一条泳道**（另一条还有结果，所以整段不算 failed）。
            不说一句的话它就是**静默失败**：用户看着「加载更多」点了没反应，
            而其实是这一条泳道超时/报错了 —— 重试还是有用的，得让他知道。
          -->
          <p v-if="!active.failed && active.error" class="text-xs text-amber-600 dark:text-amber-500">
            {{ active.error }}
          </p>
          <UButton
            v-if="active.hasMore"
            size="sm"
            color="gray"
            variant="soft"
            :loading="active.searching"
            @click="emit('loadMore', active.site.id)"
          >
            加载更多
          </UButton>
          <span v-else class="text-xs text-gray-400">没有更多了</span>
        </div>
      </template>
    </template>
  </div>
</template>
