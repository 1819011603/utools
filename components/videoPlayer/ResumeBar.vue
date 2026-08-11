<template>
  <!--
    「上次看到第 N 集」。摆在播放器**下面**紧贴信息行，不做成浮在画面上的层：
    画面上那块地方归手势和控制栏，盖一条提示等于抢走用户的第一次点击（他多半是想点播放）。
    只在「进来时没指定集数」时出现（见 useVideoPlaylistCtl.findResumeHint），点一下就走人。
  -->
  <Transition name="resume">
    <div
      v-if="resumeHint"
      class="mx-4 sm:mx-0 flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl text-sm
             bg-gradient-to-r from-violet-50 to-rose-50 dark:from-violet-500/10 dark:to-rose-500/10
             ring-1 ring-violet-200/70 dark:ring-violet-400/20"
    >
      <UIcon name="i-heroicons-clock" class="w-4 h-4 shrink-0 text-violet-500" />
      <span class="min-w-0">
        上次看到
        <b class="text-violet-600 dark:text-violet-300">第 {{ resumeHint.index + 1 }} 集</b>
        <!-- 集名常常就是「10」这种纯数字，跟集数重复时不必再念一遍 -->
        <span
          v-if="resumeHint.epName && resumeHint.epName !== String(resumeHint.index + 1)"
          class="text-gray-500 dark:text-gray-400"
        >（{{ resumeHint.epName }}）</span>
      </span>
      <div class="flex items-center gap-2 ml-auto shrink-0">
        <UButton size="xs" icon="i-heroicons-play" :loading="isSwitching" @click="resumeToHint">继续观看</UButton>
        <UButton size="xs" variant="ghost" color="gray" @click="dismissResumeHint">从头开始</UButton>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
const { resumeHint, resumeToHint, dismissResumeHint, isSwitching } = useVideoPlayerCtx()
</script>

<style scoped>
.resume-enter-active { transition: opacity .3s ease, transform .3s cubic-bezier(.22, 1, .36, 1); }
.resume-leave-active { transition: opacity .2s ease, transform .2s ease-in; }
.resume-enter-from,
.resume-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
