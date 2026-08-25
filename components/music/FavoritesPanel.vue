<script setup lang="ts">
/**
 * 收藏面板。
 *
 * 不传 props，自己从 ctx 解构（同 PlayerBar / videoPlayer 那套约定）——
 * 但**收藏数据不走 ctx**：`useMusicFavorites` 是独立 composable、模块级单例，
 * 搜索结果里的收藏心和这里读的是同一份状态，不必经播放器中转。
 *
 * 点一首的行为是「把整份收藏当队列、从这一首开始播」而不是只播这一首：
 * 收藏本来就是个歌单，只播一首会让「下一首」无处可去，播完就停。
 */
import type { Track } from '~/composables/musicPlayer/types'

const { setQueue, showFavorites } = useMusicPlayerCtx()
const { favorites, removeFavorite, clearFavorites } = useMusicFavorites()

/** 从第 index 首开始播整份收藏 */
const playFrom = (index: number) => {
  if (!favorites.value.length) return
  // 收藏里存的是剥掉 url 的占位，播放器会自己按 resolver 取址，这里不需要（也不能）预先补地址
  void setQueue(favorites.value.slice() as Track[], index)
}

/**
 * 清空做成两步确认，但不用 `window.confirm`：
 * 收藏是用户一首首攒的，误点一下全没了没有撤销；而每次都弹系统弹窗又太重。
 * 5 秒没点第二下就自己撤销——一直亮着「确认清空」也是一种误点风险。
 */
const confirmingClear = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

const askClear = () => {
  if (confirmingClear.value) {
    clearFavorites()
    confirmingClear.value = false
    return
  }
  confirmingClear.value = true
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => { confirmingClear.value = false }, 5000)
}

onBeforeUnmount(() => { if (confirmTimer) clearTimeout(confirmTimer) })

/** 副标题：歌手 · 专辑。没有的项直接不占位，别显示一串「—」（同 PlayerBar 的 subtitle） */
const sub = (t: { artist?: string; album?: string }) => [t.artist, t.album].filter(Boolean).join(' · ')
</script>

<template>
  <div class="border border-gray-200 dark:border-gray-800 rounded-xl bg-white dark:bg-gray-900 overflow-hidden">
    <!-- 标题栏：条数写在标题里，用户不用自己数 -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
      <UIcon name="i-heroicons-heart" class="w-5 h-5 text-primary-500" />
      <span class="font-medium">我的收藏</span>
      <span class="text-xs text-gray-500 tabular-nums">{{ favorites.length }}</span>

      <div class="flex-1" />

      <UButton
        icon="i-heroicons-play"
        color="primary"
        variant="soft"
        size="xs"
        :disabled="!favorites.length"
        @click="playFrom(0)"
      >
        全部播放
      </UButton>
      <UButton
        :icon="confirmingClear ? 'i-heroicons-exclamation-triangle' : 'i-heroicons-trash'"
        :color="confirmingClear ? 'red' : 'gray'"
        variant="ghost"
        size="xs"
        :disabled="!favorites.length"
        @click="askClear"
      >
        {{ confirmingClear ? '确认清空' : '清空' }}
      </UButton>
      <UButton
        icon="i-heroicons-x-mark"
        color="gray"
        variant="ghost"
        size="xs"
        aria-label="关闭收藏"
        @click="showFavorites = false"
      />
    </div>

    <!-- 空态要把「怎么才会有东西」说清楚，只留一片空白等于让用户猜是不是坏了 -->
    <div v-if="!favorites.length" class="px-4 py-10 text-center">
      <UIcon name="i-heroicons-heart" class="w-8 h-8 text-gray-300 dark:text-gray-700" />
      <p class="mt-2 text-sm text-gray-500">还没有收藏任何歌曲</p>
      <p class="mt-1 text-xs text-gray-400">
        在搜索结果或播放条上点一下爱心就能收藏。收藏只记歌曲信息、不记播放地址，所以换天再来也不会失效。
      </p>
    </div>

    <!-- 收藏可能有几百首，给一个滚动区，别把整页撑长 -->
    <div v-else class="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
      <div
        v-for="(t, i) in favorites"
        :key="t.key"
        class="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/60"
      >
        <div class="w-10 h-10 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0 grid place-items-center">
          <!-- 这些封面多半带防盗链，不加 no-referrer 就是一排裂图 -->
          <img
            v-if="t.cover"
            :src="t.cover"
            referrerpolicy="no-referrer"
            class="w-full h-full object-cover"
            alt=""
          >
          <UIcon v-else name="i-heroicons-musical-note" class="w-5 h-5 text-gray-400" />
        </div>

        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ t.name }}</div>
          <div class="truncate text-xs text-gray-500">{{ sub(t) || '未知歌手' }}</div>
        </div>

        <UButton
          icon="i-heroicons-play"
          color="gray"
          variant="ghost"
          size="xs"
          :title="`播放《${t.name}》`"
          aria-label="播放"
          @click="playFrom(i)"
        />
        <UButton
          icon="i-heroicons-heart"
          color="primary"
          variant="ghost"
          size="xs"
          title="取消收藏"
          aria-label="取消收藏"
          @click="removeFavorite(t.key)"
        />
      </div>
    </div>
  </div>
</template>
