<script setup lang="ts">
/**
 * 播放条中间那两行滚动歌词（网易云 / QQ 音乐的做法：只亮当前这句，下一句压暗跟在后面）。
 *
 * 为什么值得单独一个组件：它是**常驻**的，歌词面板却可以收起来。放在播放条里，
 * 用户不展开任何面板也一直看得见词——这正是「听歌时想看词」的默认姿势。
 *
 * 两行而不是一行：只留当前句时，句与句之间的空档（间奏、长句尾）会整块空掉，
 * 看着像坏了；把下一句压暗放着，既填了空档又能提前看到要唱什么。
 *
 * 状态判读的分寸：**这里不承担任何错误提示**。查不到词只显示一句浅灰提示并把用户
 * 引到面板去贴——歌词是锦上添花，绝不该在播放条上喊出一个错误（同 useMusicLyrics 的立场）。
 */
import { activeLrcIndex } from '~/composables/musicPlayer/lrc'

const { current, currentTime, showLyrics } = useMusicPlayerCtx()
// 取词由 PlayerBar 统一驱动，这里只读（模块级单例，两处拿到的是同一份）
const { parsed, loading } = useMusicLyrics()

const synced = computed(() => parsed.value.synced)

/** 当前该亮哪一句。没有时间轴时恒为 -1（那种词只能整块看，跟不了唱） */
const index = computed(() =>
  synced.value ? activeLrcIndex(parsed.value.lines, currentTime.value) : -1,
)

/** 前奏期间 `index` 是 -1，当前句为空——此时只把第一句压暗摆出来，别显示空白 */
const cur = computed(() => (index.value >= 0 ? parsed.value.lines[index.value]?.text || '' : ''))
const next = computed(() => parsed.value.lines[index.value + 1]?.text || '')

/** 没词可滚时的一句浅灰提示。空串 = 有词在滚，什么都不用说 */
const hint = computed(() => {
  if (!current.value) return ''
  if (loading.value) return '正在找歌词…'
  if (!parsed.value.lines.length) return '暂无歌词 · 点这里贴一份'
  if (!synced.value) return '这份歌词没有时间轴 · 点开看全文'
  return ''
})
</script>

<template>
  <!--
    整块可点：点一下开合下面的歌词面板（和右侧那枚歌词按钮同一个开关）。
    固定高度而不是让内容撑开——句子有长有短，撑开会让整条播放条随着唱词一跳一跳。
  -->
  <div
    v-if="current"
    class="h-11 flex flex-col justify-center items-center text-center cursor-pointer select-none
           px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
    :title="showLyrics ? '收起歌词' : '展开歌词'"
    @click="showLyrics = !showLyrics"
  >
    <template v-if="hint">
      <p class="truncate w-full text-xs text-gray-400">{{ hint }}</p>
    </template>

    <template v-else>
      <!--
        换句时上滑淡入，模仿滚动歌词的观感。用 `mode="out-in"` 是因为两句同时在场会
        把固定高度顶开（那正是上面不让内容撑开的原因）。
        `:key` 必须带下标：副歌里同一句词会反复出现，只用文本当 key 时它不会重新入场。
      -->
      <Transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="opacity-0 translate-y-1.5"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="opacity-0 -translate-y-1.5"
        mode="out-in"
      >
        <p
          :key="index"
          class="truncate w-full text-sm font-medium text-primary-600 dark:text-primary-400"
        >
          {{ cur || '♪' }}
        </p>
      </Transition>
      <p v-if="next" class="truncate w-full text-xs text-gray-400 dark:text-gray-500">
        {{ next }}
      </p>
    </template>
  </div>
</template>
