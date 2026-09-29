<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        时间戳转换
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        时间戳与日期时间互转，自动识别输入格式
      </p>
    </div>

    <div class="max-w-4xl mx-auto space-y-6">
      <UCard>
        <div class="space-y-4">
          <div class="flex gap-4 items-end flex-wrap">
            <div class="flex-1 min-w-[300px]">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                输入时间戳或日期时间
              </label>
              <UInput
                v-model="input"
                size="lg"
                class="font-mono"
                placeholder="如: 1740383605, 1740383605000, 2026-02-24 15:53:25"
                @input="debouncedConvert"
                @keyup.enter="convert"
              />
            </div>
            <div class="w-40">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                时区
              </label>
              <USelect v-model="timezone" :options="timezoneOptions" size="lg" @change="convert" />
            </div>
            <UButton @click="convert" color="primary" size="lg">
              转换
            </UButton>
            <UButton @click="useNow" variant="outline" size="lg">
              当前时间
            </UButton>
          </div>

          <div class="text-xs text-gray-500">
            支持格式: 秒级/毫秒时间戳、2026-02-24、2026/02/24 15:53:25、2026-02-24T15:53:25Z、Feb 24 2026 等
          </div>
        </div>
      </UCard>

      <UAlert v-if="error" color="red">
        <template #title>无法解析</template>
        <template #description>{{ error }}</template>
      </UAlert>

      <div v-if="result" class="space-y-3">
        <ResultRow label="秒级时间戳" :value="result.seconds" />
        <ResultRow label="毫秒时间戳" :value="result.milliseconds" />
        <ResultRow label="日期时间" :value="result.datetime" />
        <ResultRow label="日期时间 (毫秒)" :value="result.datetimeMs" />
        <ResultRow label="日期" :value="result.date" />
        <ResultRow label="时间" :value="result.time" />
        <ResultRow label="ISO 8601" :value="result.iso" />
        <ResultRow label="UTC" :value="result.utc" />
        <ResultRow label="相对时间" :value="relativeTime" :highlight="true" />
      </div>

      <UCard v-if="result">
        <template #header>
          <h3 class="font-medium text-gray-900 dark:text-white">更多格式</h3>
        </template>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div v-for="fmt in extraFormats" :key="fmt.label" class="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-800 rounded">
            <span class="text-gray-600 dark:text-gray-400">{{ fmt.label }}</span>
            <div class="flex items-center gap-2">
              <span class="font-mono text-gray-900 dark:text-white">{{ fmt.value }}</span>
              <UButton @click="copyValue(fmt.value)" variant="ghost" size="xs">
                <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4" />
              </UButton>
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTimestamp } from '~/composables/useTimestamp'

const {
  input,
  timezone,
  timezoneOptions,
  error,
  result,
  relativeTime,
  extraFormats,
  convert,
  debouncedConvert,
  useNow,
  copyValue
} = useTimestamp()
</script>
