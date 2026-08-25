<script setup lang="ts">
/**
 * 搜索结果：两个来源**混排在一个网格里**，不再分「音源一/音源二」两个页签。
 *
 * 来源对用户没有意义 —— 他要的是「这首歌有哪些音质可选」。所以来源退到幕后，
 * 每张卡片上直接摆音质档位按钮，点哪个档就用哪个档取址（见 music24bit.ts 的 QUALITY_TIERS）。
 *
 * **交替混排而不是首尾相接**：两个来源是两个不同的库，谁的结果更贴切事先不知道，
 * 顺次拼接会让第二个来源的东西全被压到 30 条以后，等于白搜一次。
 *
 * 播放/收藏/下载一律 emit 给页面 —— 收藏和下载是页面级能力，不属于播放器上下文。
 */
import type { MusicSearchRow, MusicSourceId } from '~/composables/music24bit'
import type { DetailPrefix } from '~/composables/music24bit'
import { QUALITY_TIERS } from '~/composables/music24bit'
import type { MusicSourceState } from '~/composables/useMusicSearch'

const props = defineProps<{
  states: MusicSourceState[]
  keyword: string
  emptyResult: boolean
  /** 正在取址的那首的 key，用来在对应卡片上画转圈 */
  resolvingKey?: string
  favoriteKeys?: Set<string>
  currentKey?: string
}>()

const emit = defineEmits<{
  (e: 'play', row: MusicSearchRow, tier: DetailPrefix, list: MusicSearchRow[], index: number): void
  (e: 'download', row: MusicSearchRow, tier: DetailPrefix): void
  (e: 'favorite', row: MusicSearchRow): void
  (e: 'loadMore'): void
  (e: 'retry', id: MusicSourceId): void
}>()

const keyOf = (row: MusicSearchRow) => `24bit:${row.id}`

/** 交替取，两个来源的结果都能靠前露脸 */
const merged = computed<MusicSearchRow[]>(() => {
  const lists = props.states.map(s => s.rows)
  const out: MusicSearchRow[] = []
  const seen = new Set<string>()
  const max = Math.max(0, ...lists.map(l => l.length))
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const row = l[i]
      // 同一个 id 在两个库里都出现时只留一条（罕见，但留两条看着像界面出了 bug）
      if (row && !seen.has(row.id)) { seen.add(row.id); out.push(row) }
    }
  }
  return out
})

const anySearching = computed(() => props.states.some(s => s.status === 'searching'))
const anyMore = computed(() => props.states.some(s => s.hasMore))
/** 全都失败了才算失败；只挂一个来源时另一个的结果照常能用 */
const allFailed = computed(() =>
  props.states.length > 0 && props.states.every(s => s.status === 'error'),
)
const firstError = computed(() => props.states.find(s => s.status === 'error')?.error)
</script>

<template>
  <div v-if="keyword" class="space-y-4">
    <div v-if="merged.length" class="flex items-center justify-between text-sm">
      <span class="text-gray-500">找到 {{ merged.length }} 首</span>
      <span v-if="anySearching" class="text-gray-400 flex items-center gap-1">
        <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 animate-spin" />
        还在搜…
      </span>
    </div>

    <div v-if="allFailed" class="py-10 text-center space-y-3">
      <UIcon name="i-heroicons-exclamation-triangle" class="w-8 h-8 text-amber-500" />
      <p class="text-sm text-gray-500">{{ firstError }}</p>
      <UButton size="sm" color="gray" @click="emit('retry', states[0].id)">重试</UButton>
    </div>

    <div v-else-if="anySearching && !merged.length" class="py-12 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-arrow-path" class="w-6 h-6 animate-spin mb-2" />
      <p>正在搜索…</p>
    </div>

    <div v-else-if="!merged.length" class="py-12 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300" />
      <p>没有找到「{{ keyword }}」，换个关键词试试</p>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="(row, i) in merged"
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
          <div v-if="row.album" class="truncate text-xs text-gray-400" :title="row.album">
            专辑：{{ row.album }}
          </div>
          <div class="truncate text-xs text-primary-600 dark:text-primary-400" :title="row.player">
            {{ row.player }}
          </div>
        </div>

        <div class="shrink-0 flex flex-col items-end gap-1">
          <span class="text-[11px] text-gray-400">请选择音质</span>
          <!--
            两个档都摆出来，点了才取址。事先探测「哪个档有资源」要对每首发两次请求，
            一页 30 首就是 60 发，必被静默限流（见 QUALITY_TIERS 的说明）。
          -->
          <UButton
            v-for="q in QUALITY_TIERS"
            :key="q.tier"
            size="2xs"
            :color="q.color"
            variant="soft"
            :loading="resolvingKey === keyOf(row)"
            :title="q.hint"
            @click="emit('play', row, q.tier, merged, i)"
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
              @click="emit('download', row, QUALITY_TIERS[0].tier)"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="merged.length" class="text-center">
      <UButton
        v-if="anyMore"
        size="sm"
        color="gray"
        variant="soft"
        :loading="anySearching"
        @click="emit('loadMore')"
      >
        加载更多
      </UButton>
      <span v-else class="text-xs text-gray-400">没有更多了</span>
    </div>
  </div>
</template>
