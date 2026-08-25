<script setup lang="ts">
/**
 * 歌词面板。
 *
 * 词有三个来源，优先级见 `useMusicLyrics`：手动贴的 > 曲目自带 > 在线匹配。
 *
 * ## 为什么手动那一栏不是可有可无的
 *
 * 音乐站两个源都不给词（实测一个是长度 2 的空占位、一个是空字符串），
 * 只能靠在线匹配；而在线搜索在**版权下架的歌**上只会返回翻唱/AI 版
 * （实测搜「晴天 周杰伦」8 条候选没有一条是原唱）。对这类歌，用户自己贴一份是唯一可靠的路。
 *
 * 匹配到的来源一定要**摆在界面上**：下架歌常匹配到翻唱版，时间轴不一定严丝合缝。
 * 把出处亮出来让用户自己判断可信度，比我们替他打包票强。
 */
import { activeLrcIndex } from '~/composables/musicPlayer/lrc'

const { current, currentTime, seekTo } = useMusicPlayerCtx()
// 状态是模块级单例，和播放条那行滚动歌词共用一份；**取词由播放条驱动**，
// 这里不能再 watch 一遍——面板是 `v-if` 的，两处都取等于每次切歌查两遍网络
const { parsed, source, loading, isManual, fetchFor, saveManual, clearManual, manualOf } = useMusicLyrics()

const hasLyrics = computed(() => parsed.value.lines.length > 0)

/** 当前该高亮哪一行。没有时间轴时恒为 -1（整块显示，不高亮） */
const activeIndex = computed(() =>
  parsed.value.synced ? activeLrcIndex(parsed.value.lines, currentTime.value) : -1,
)

const listEl = ref<HTMLElement>()

// ── 手动贴词 ──
const editing = ref(false)
const draft = ref('')

const openEditor = () => {
  draft.value = current.value ? manualOf(current.value.key) : ''
  editing.value = true
}

const applyDraft = () => {
  if (!current.value) return
  saveManual(current.value.key, draft.value)
  editing.value = false
}

const dropManual = () => {
  if (!current.value) return
  clearManual(current.value.key)
  editing.value = false
  // 清掉手动那份之后回到自动来源，否则界面上会一直空着
  void fetchFor(current.value)
}

/** 换歌把编辑态收掉：留着的话，贴到一半切了歌，保存会落到新的那首上 */
watch(() => current.value?.key, () => { editing.value = false })

/**
 * 高亮行滚进视野。用 `block: 'center'` 而不是 `nearest` —— 跟唱的惯例是当前句居中、
 * 两边各露几句上下文；`nearest` 会让它贴在容器边缘，看不到下一句要唱什么。
 * （这和选集面板的取舍相反，那边是「已经在视野里就别动」。）
 */
watch(activeIndex, async (i) => {
  if (i < 0) return
  await nextTick()
  listEl.value?.querySelector(`[data-lrc="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <UIcon name="i-heroicons-document-text" class="w-5 h-5 text-primary-500 shrink-0" />
          <span class="font-medium shrink-0">歌词</span>
          <UBadge v-if="parsed.synced" color="primary" variant="soft" size="xs">跟唱</UBadge>
          <UBadge v-if="isManual" color="gray" variant="soft" size="xs">手动</UBadge>
        </div>
        <UButton
          v-if="current"
          :icon="editing ? 'i-heroicons-x-mark' : 'i-heroicons-pencil-square'"
          size="2xs"
          color="gray"
          variant="ghost"
          :label="editing ? '取消' : '贴歌词'"
          @click="editing ? (editing = false) : openEditor()"
        />
      </div>
    </template>

    <!-- 来源标注：匹配到的可能是翻唱版，把出处亮出来让用户自己判断 -->
    <p v-if="source && !isManual" class="text-xs text-gray-400 mb-2">
      匹配自：{{ source.name }} — {{ source.artist }}
    </p>

    <div v-if="editing" class="space-y-2">
      <UTextarea
        v-model="draft"
        :rows="10"
        placeholder="粘贴 LRC 文本，支持 [00:12.34] 时间轴；没有时间轴也能整段显示"
        class="font-mono text-xs"
      />
      <div class="flex gap-2">
        <UButton size="sm" :disabled="!draft.trim()" @click="applyDraft">保存</UButton>
        <UButton v-if="isManual" size="sm" color="gray" variant="ghost" @click="dropManual">
          删掉手动歌词
        </UButton>
      </div>
      <p class="text-xs text-gray-400">
        只存在这台机器上，按曲目记。保存后这首歌永远优先用你贴的这份。
      </p>
    </div>

    <div v-else-if="!current" class="py-8 text-center text-sm text-gray-500">
      还没有在播放的曲目
    </div>

    <div v-else-if="loading" class="py-8 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-arrow-path" class="w-6 h-6 animate-spin mb-2" />
      <p>正在找歌词…</p>
    </div>

    <div v-else-if="!hasLyrics" class="py-8 text-center text-sm text-gray-500">
      <UIcon name="i-heroicons-document-text" class="w-8 h-8 mb-2 text-gray-300" />
      <p>没有找到这首歌的歌词</p>
      <p class="text-xs mt-1">
        版权下架的歌基本搜不到原版。点右上角「贴歌词」可以自己放一份。
      </p>
    </div>

    <div v-else ref="listEl" class="max-h-72 overflow-y-auto space-y-1 py-2">
      <p
        v-for="(l, i) in parsed.lines"
        :key="i"
        :data-lrc="i"
        class="text-sm leading-relaxed transition-colors px-2 py-0.5 rounded"
        :class="[
          parsed.synced && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60',
          i === activeIndex
            ? 'text-primary-600 dark:text-primary-400 font-medium'
            : 'text-gray-500 dark:text-gray-400',
        ]"
        @click="parsed.synced && l.time >= 0 && seekTo(l.time)"
      >
        {{ l.text }}
      </p>
    </div>
  </UCard>
</template>
