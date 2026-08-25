<script setup lang="ts">
/**
 * 搜索结果：两个音源分组展示。
 *
 * **不做去重合并**：One/Two 是两个不同的库，同一首歌在两边常是不同版本
 * （现场版、不同专辑收录），合并会把用户想要的那一版抹掉。
 *
 * 播放/收藏/下载一律 emit 给页面，不直接调 ctx —— 收藏和下载是页面级能力，
 * 不属于播放器上下文，走 emit 才能让这个组件与它们解耦。
 */
import type { MusicSearchRow, MusicSourceId } from '~/composables/music24bit'
import type { MusicSourceState } from '~/composables/useMusicSearch'

const props = defineProps<{
  states: MusicSourceState[]
  keyword: string
  emptyResult: boolean
  /** 正在取址的那首的 key，用来在对应行上画转圈 */
  resolvingKey?: string
  /** 已收藏的 key 集合 */
  favoriteKeys?: Set<string>
  /** 正在播的那首的 key */
  currentKey?: string
}>()

const emit = defineEmits<{
  (e: 'play', row: MusicSearchRow, source: MusicSourceId, list: MusicSearchRow[], index: number): void
  (e: 'download', row: MusicSearchRow): void
  (e: 'favorite', row: MusicSearchRow): void
  (e: 'loadMore', id: MusicSourceId): void
  (e: 'retry', id: MusicSourceId): void
}>()

/** 当前看的是哪个音源。按 id 记不按下标 —— 音源表将来增删时下标会指到别人身上 */
const activeId = ref<MusicSourceId>(props.states[0]?.id ?? 'one')
const active = computed(() => props.states.find(s => s.id === activeId.value) ?? props.states[0])

const keyOf = (row: MusicSearchRow) => `24bit:${row.id}`

/**
 * 结果一落地就把焦点挪到第一个真有结果的音源 —— 但**只挪一次**。
 * 两个音源快慢不一，每来一份就重挑一次的话，用户刚点开某个音源就会被另一份结果抢走。
 */
const autoPicked = ref(false)
watch(() => props.states.map(s => s.rows.length).join(','), () => {
  if (autoPicked.value) return
  const first = props.states.find(s => s.status === 'done' && s.rows.length)
  if (first) { activeId.value = first.id; autoPicked.value = true }
})
watch(() => props.keyword, () => { autoPicked.value = false })
</script>

<template>
  <div v-if="keyword" class="space-y-4">
    <!-- 音源切换。只有两个，用按钮组比 tab 组件轻 -->
    <div class="flex items-center gap-2 flex-wrap">
      <UButton
        v-for="s in states"
        :key="s.id"
        size="sm"
        :color="s.id === activeId ? 'primary' : 'gray'"
        :variant="s.id === activeId ? 'solid' : 'soft'"
        @click="activeId = s.id"
      >
        {{ s.name }}
        <template v-if="s.status === 'searching'">
          <UIcon name="i-heroicons-arrow-path" class="w-3 h-3 animate-spin" />
        </template>
        <span v-else-if="s.rows.length" class="text-xs tabular-nums opacity-75">{{ s.rows.length }}</span>
      </UButton>
    </div>

    <UCard v-if="active">
      <!-- 错误：给重试，别只报一句失败 -->
      <div v-if="active.status === 'error'" class="py-8 text-center space-y-3">
        <UIcon name="i-heroicons-exclamation-triangle" class="w-8 h-8 text-amber-500" />
        <p class="text-sm text-gray-500">{{ active.error }}</p>
        <UButton size="sm" color="gray" @click="emit('retry', active.id)">重试</UButton>
      </div>

      <div v-else-if="active.status === 'searching' && !active.rows.length" class="py-10 text-center text-sm text-gray-500">
        <UIcon name="i-heroicons-arrow-path" class="w-6 h-6 animate-spin mb-2" />
        <p>正在搜索…</p>
      </div>

      <div v-else-if="!active.rows.length" class="py-10 text-center text-sm text-gray-500">
        <UIcon name="i-heroicons-musical-note" class="w-8 h-8 mb-2 text-gray-300" />
        <p>这个音源没有找到「{{ keyword }}」</p>
        <p class="text-xs mt-1">换一个音源，或者换个关键词试试</p>
      </div>

      <div v-else class="divide-y divide-gray-100 dark:divide-gray-800 -my-2">
        <div
          v-for="(row, i) in active.rows"
          :key="row.id"
          class="flex items-center gap-3 py-2 group"
          :class="currentKey === keyOf(row) && 'text-primary-600 dark:text-primary-400'"
        >
          <UButton
            :icon="resolvingKey === keyOf(row) ? 'i-heroicons-arrow-path' : 'i-heroicons-play'"
            :class="resolvingKey === keyOf(row) && 'animate-spin'"
            color="gray"
            variant="ghost"
            size="xs"
            :aria-label="`播放 ${row.name}`"
            @click="emit('play', row, active.id, active.rows, i)"
          />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{{ row.name }}</div>
            <div class="truncate text-xs text-gray-500">
              {{ row.player }}<template v-if="row.album"> · {{ row.album }}</template>
            </div>
          </div>
          <!-- 桌面端 hover 才显形，窄屏常显（触摸端没有 hover，藏起来等于没有） -->
          <div class="flex items-center gap-0.5 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
            <UButton
              :icon="favoriteKeys?.has(keyOf(row)) ? 'i-heroicons-heart-solid' : 'i-heroicons-heart'"
              :color="favoriteKeys?.has(keyOf(row)) ? 'primary' : 'gray'"
              variant="ghost"
              size="xs"
              aria-label="收藏"
              @click="emit('favorite', row)"
            />
            <UButton
              icon="i-heroicons-arrow-down-tray"
              color="gray"
              variant="ghost"
              size="xs"
              aria-label="下载"
              @click="emit('download', row)"
            />
          </div>
        </div>
      </div>

      <template v-if="active.rows.length" #footer>
        <div class="flex items-center justify-between text-xs text-gray-500">
          <span>已列出 {{ active.rows.length }} 首</span>
          <UButton
            v-if="active.hasMore"
            size="xs"
            color="gray"
            variant="soft"
            :loading="active.status === 'searching'"
            @click="emit('loadMore', active.id)"
          >
            加载更多
          </UButton>
          <span v-else>没有更多了</span>
        </div>
      </template>
    </UCard>

    <p v-if="emptyResult" class="text-sm text-gray-500 text-center">
      两个音源都没有找到「{{ keyword }}」，换个关键词试试。
    </p>
  </div>
</template>
