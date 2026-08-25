<script setup lang="ts">
/**
 * 搜索结果：**每个音乐源一段**。
 *
 * 不混排的理由是音质：24bit 是无损 flac，fangpi 是 128K MP3 ——
 * 这不是「来源」的差别（来源对用户没意义），而是他要拿来做选择的东西。
 * 混在一张网格里，用户没法一眼看出「上面那批大而好、下面那批小而快」。
 *
 * 段**内部**仍然把该站点的几条泳道交替混排（24bit 的「音源一/二」就此退到幕后），
 * 那一层合并在 `useMusicSearch` 里做完了，这里只管画。
 *
 * 每张卡片上直接摆**该段站点自己的**音质档按钮，点哪个档就用哪个档取址。
 * 播放/收藏/下载一律 emit 给页面 —— 收藏和下载是页面级能力，不属于播放器上下文。
 */
import type { MusicSearchRow, MusicSiteId } from '~/composables/musicSites/types'
import type { MusicSection } from '~/composables/useMusicSearch'
import { trackKeyOf } from '~/composables/musicSites'

const props = defineProps<{
  sections: MusicSection[]
  keyword: string
  /** 所有音乐源都搜完了且一条都没有。这时候只说一句话，别摆一排空段落 */
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
 * 用户点的是哪一档。**只让被点的那颗转圈** ——
 * 早先只按 `resolvingKey === keyOf(row)` 判断，同一行的两颗按钮都成立，
 * 于是点「无损音质」时「高清环绕声」也跟着转，看着像两个档同时在取址（并没有）。
 */
const pickedTier = ref<{ key: string; tier: string } | null>(null)

const isTierLoading = (row: MusicSearchRow, tier: string) =>
  props.resolvingKey === keyOf(row)
  && pickedTier.value?.key === keyOf(row)
  && pickedTier.value?.tier === tier

const onPickTier = (section: MusicSection, row: MusicSearchRow, tier: string, index: number) => {
  pickedTier.value = { key: keyOf(row), tier }
  // 整段装进队列（不是只放这一首），这样「播完自动下一首」立刻可用
  emit('play', row, tier, section.rows, index)
}

// 取址结束（不论成败）就把转圈状态收掉，否则那颗按钮会一直转下去
watch(() => props.resolvingKey, (k) => { if (!k) pickedTier.value = null })

/** 有内容或者还在搜的段才画。全空时由 emptyResult 那一句统一交代 */
const visible = computed(() =>
  props.sections.filter(s => s.rows.length || s.searching || s.failed),
)
</script>

<template>
  <div v-if="keyword" class="space-y-6">
    <!-- 所有源都没有 → 一句话说完，别摆一排「这个源没有」 -->
    <div v-if="emptyResult" class="py-12 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300" />
      <p>没有找到「{{ keyword }}」，换个关键词试试</p>
    </div>

    <section v-for="section in visible" :key="section.site.id" class="space-y-3">
      <!-- 段头：站名 + 音质一句话。两段的差别要在这儿一眼看出来 -->
      <div class="flex items-baseline gap-2 flex-wrap">
        <h2 class="text-sm font-semibold">{{ section.site.name }}</h2>
        <span class="text-xs text-gray-400">{{ section.site.tagline }}</span>
        <span v-if="section.rows.length" class="text-xs text-gray-500 ml-auto">
          {{ section.rows.length }} 首
        </span>
        <span v-if="section.searching" class="text-xs text-gray-400 flex items-center gap-1" :class="section.rows.length ? '' : 'ml-auto'">
          <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 animate-spin" />
          还在搜…
        </span>
      </div>

      <!-- 这一段整个挂了。另一段的结果照常能用，所以只在自己这段里报 -->
      <div
        v-if="section.failed"
        class="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 p-4 flex items-center gap-3 text-sm"
      >
        <UIcon name="i-heroicons-exclamation-triangle" class="w-5 h-5 text-amber-500 shrink-0" />
        <span class="text-gray-600 dark:text-gray-300 min-w-0 flex-1">{{ section.error }}</span>
        <UButton size="2xs" color="gray" @click="emit('retry', section.site.id)">重试</UButton>
      </div>

      <div v-else-if="section.searching && !section.rows.length" class="py-8 text-center text-sm text-gray-500">
        <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin" />
      </div>

      <div v-else-if="!section.rows.length" class="py-4 text-center text-xs text-gray-400">
        这个音乐源没有「{{ keyword }}」
      </div>

      <div v-else class="grid gap-3 sm:grid-cols-2">
        <div
          v-for="(row, i) in section.rows"
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
              v-for="q in section.site.tiers"
              :key="q.tier"
              size="2xs"
              :color="q.color"
              variant="soft"
              :loading="isTierLoading(row, q.tier)"
              :title="q.hint"
              @click="onPickTier(section, row, q.tier, i)"
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
                @click="emit('download', row, section.site.tiers[0].tier)"
              />
            </div>
          </div>
        </div>
      </div>

      <!--
        「加载更多」按段走。**不分页的源（pageSize 0）一个字都不写**：
        画一颗按了没反应的按钮，比没有更让人以为坏了。
      -->
      <div v-if="section.rows.length && section.site.pageSize > 0" class="text-center">
        <UButton
          v-if="section.hasMore"
          size="sm"
          color="gray"
          variant="soft"
          :loading="section.searching"
          @click="emit('loadMore', section.site.id)"
        >
          加载更多
        </UButton>
        <span v-else class="text-xs text-gray-400">没有更多了</span>
      </div>
    </section>
  </div>
</template>
