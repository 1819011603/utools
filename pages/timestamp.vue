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
import { useDebounceFn } from '@vueuse/core'

const STORAGE_KEY = 'timestamp-settings'

const loadSettings = () => {
  if (typeof window === 'undefined') return null
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}

const saveSettings = () => {
  if (typeof window === 'undefined') return
  try {
    const settings = {
      timezone: timezone.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('保存设置失败:', e)
  }
}

const savedSettings = loadSettings()

const input = ref('')
const timezone = ref(savedSettings?.timezone ?? 'local')
const error = ref('')
const result = ref<{
  seconds: string
  milliseconds: string
  datetime: string
  datetimeMs: string
  date: string
  time: string
  iso: string
  utc: string
  timestamp: number
} | null>(null)

watch(timezone, saveSettings)

const relativeTime = ref('')
let relativeTimer: ReturnType<typeof setInterval> | null = null

const timezoneOptions = [
  { label: '本地时区', value: 'local' },
  { label: 'UTC+0', value: 'UTC' },
  { label: 'UTC+8 (中国)', value: 'Asia/Shanghai' },
  { label: 'UTC+9 (日本)', value: 'Asia/Tokyo' },
  { label: 'UTC-5 (美东)', value: 'America/New_York' },
  { label: 'UTC-8 (美西)', value: 'America/Los_Angeles' },
  { label: 'UTC+1 (欧洲)', value: 'Europe/Paris' },
]

const extraFormats = computed(() => {
  if (!result.value) return []
  const ts = result.value.timestamp
  const date = new Date(ts)
  const tz = timezone.value === 'local' ? undefined : timezone.value
  
  return [
    { label: 'YYYY-MM-DD', value: formatWithTimezone(date, 'date-only', tz) },
    { label: 'YYYY/MM/DD', value: formatWithTimezone(date, 'date-slash', tz) },
    { label: 'MM/DD/YYYY', value: formatWithTimezone(date, 'date-us', tz) },
    { label: 'DD/MM/YYYY', value: formatWithTimezone(date, 'date-eu', tz) },
    { label: 'YYYYMMDD', value: formatWithTimezone(date, 'date-compact', tz) },
    { label: 'HH:mm:ss', value: formatWithTimezone(date, 'time-only', tz) },
    { label: '周几', value: formatWithTimezone(date, 'weekday', tz) },
    { label: '第几周', value: `第 ${getWeekNumber(date)} 周` },
  ]
})

const formatWithTimezone = (date: Date, format: string, tz?: string): string => {
  const options: Intl.DateTimeFormatOptions = { timeZone: tz }
  
  switch (format) {
    case 'date-only':
      return date.toLocaleDateString('sv-SE', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' })
    case 'date-slash':
      return date.toLocaleDateString('sv-SE', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/-/g, '/')
    case 'date-us': {
      const parts = new Intl.DateTimeFormat('en-US', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
      const m = parts.find(p => p.type === 'month')?.value
      const d = parts.find(p => p.type === 'day')?.value
      const y = parts.find(p => p.type === 'year')?.value
      return `${m}/${d}/${y}`
    }
    case 'date-eu': {
      const parts = new Intl.DateTimeFormat('en-GB', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
      const m = parts.find(p => p.type === 'month')?.value
      const d = parts.find(p => p.type === 'day')?.value
      const y = parts.find(p => p.type === 'year')?.value
      return `${d}/${m}/${y}`
    }
    case 'date-compact':
      return date.toLocaleDateString('sv-SE', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/-/g, '')
    case 'time-only':
      return date.toLocaleTimeString('en-GB', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    case 'weekday':
      return date.toLocaleDateString('zh-CN', { ...options, weekday: 'long' })
    default:
      return ''
  }
}

const getWeekNumber = (date: Date): number => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

const parseInput = (str: string): Date | null => {
  const trimmed = str.trim()
  if (!trimmed) return null

  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed)
    if (trimmed.length === 13) {
      return new Date(num)
    } else {
      return new Date(num * 1000)
    }
  }

  const normalized = trimmed
    .replace(/[年月]/g, '-')
    .replace(/[日号]/g, ' ')
    .replace(/[时點点]/g, ':')
    .replace(/[分秒]/g, (m, i, s) => i < s.length - 1 ? ':' : '')
    .replace(/\s+/g, ' ')
    .trim()

  let date = new Date(normalized)
  if (!isNaN(date.getTime())) return date

  const formats = [
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT](\d{1,2}):(\d{1,2}):(\d{1,2})\.(\d{1,3})/,
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT](\d{1,2}):(\d{1,2}):(\d{1,2})/,
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT](\d{1,2}):(\d{1,2})/,
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/,
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/,
  ]

  for (const fmt of formats) {
    const match = normalized.match(fmt)
    if (match) {
      if (fmt === formats[4]) {
        const [, m, d, y] = match
        date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
      } else {
        const [, y, m, d, h = '0', min = '0', s = '0', ms = '0'] = match
        date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(h), parseInt(min), parseInt(s), parseInt(ms))
      }
      if (!isNaN(date.getTime())) return date
    }
  }

  return null
}

const formatDateTime = (date: Date, tz?: string): string => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: tz
  }
  
  const parts = new Intl.DateTimeFormat('zh-CN', options).formatToParts(date)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  const h = parts.find(p => p.type === 'hour')?.value
  const min = parts.find(p => p.type === 'minute')?.value
  const s = parts.find(p => p.type === 'second')?.value
  
  return `${y}/${m}/${d} ${h}:${min}:${s}`
}

const formatDateTimeMs = (date: Date, tz?: string): string => {
  const base = formatDateTime(date, tz)
  const ms = date.getMilliseconds().toString().padStart(3, '0')
  return `${base}.${ms}`
}

const updateRelativeTime = () => {
  if (!result.value) return
  
  const now = Date.now()
  const diff = result.value.timestamp - now
  const absDiff = Math.abs(diff)
  const isPast = diff < 0

  const seconds = Math.floor(absDiff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const months = Math.floor(days / 30)
  const years = Math.floor(days / 365)

  let text = ''
  if (years > 0) text = `${years} 年 ${days % 365} 天`
  else if (months > 0) text = `${months} 个月 ${days % 30} 天`
  else if (days > 0) text = `${days} 天 ${hours % 24} 小时`
  else if (hours > 0) text = `${hours} 小时 ${minutes % 60} 分钟`
  else if (minutes > 0) text = `${minutes} 分钟 ${seconds % 60} 秒`
  else text = `${seconds} 秒`

  relativeTime.value = isPast ? `${text}前` : `${text}后`
}

const convert = () => {
  error.value = ''
  result.value = null
  
  if (relativeTimer) {
    clearInterval(relativeTimer)
    relativeTimer = null
  }

  const date = parseInput(input.value)
  if (!date) {
    if (input.value.trim()) {
      error.value = '无法识别的时间格式，请检查输入'
    }
    return
  }

  const ts = date.getTime()
  const tz = timezone.value === 'local' ? undefined : timezone.value

  result.value = {
    seconds: Math.floor(ts / 1000).toString(),
    milliseconds: ts.toString(),
    datetime: formatDateTime(date, tz),
    datetimeMs: formatDateTimeMs(date, tz),
    date: formatWithTimezone(date, 'date-only', tz),
    time: formatWithTimezone(date, 'time-only', tz),
    iso: date.toISOString(),
    utc: date.toUTCString(),
    timestamp: ts
  }

  updateRelativeTime()
  relativeTimer = setInterval(updateRelativeTime, 1000)
}

const debouncedConvert = useDebounceFn(convert, 300)

const useNow = () => {
  input.value = Date.now().toString()
  convert()
}

const copyValue = async (value: string) => {
  await navigator.clipboard.writeText(value)
  useToast().add({ title: '已复制', color: 'green' })
}

onMounted(() => {
  useNow()
})

onUnmounted(() => {
  if (relativeTimer) {
    clearInterval(relativeTimer)
  }
})
</script>

<script lang="ts">
const ResultRow = defineComponent({
  props: {
    label: { type: String, required: true },
    value: { type: String, required: true },
    highlight: { type: Boolean, default: false }
  },
  setup(props) {
    const copyValue = async () => {
      await navigator.clipboard.writeText(props.value)
      useToast().add({ title: '已复制', color: 'green' })
    }

    return () => h(
      'div',
      { class: 'flex items-center justify-between p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700' },
      [
        h('span', { class: 'text-sm text-gray-600 dark:text-gray-400 min-w-[100px]' }, props.label),
        h('div', { class: 'flex items-center gap-3' }, [
          h('span', { 
            class: [
              'font-mono text-lg',
              props.highlight 
                ? 'text-primary-600 dark:text-primary-400 font-semibold' 
                : 'text-gray-900 dark:text-white'
            ]
          }, props.value),
          h(resolveComponent('UButton'), {
            onClick: copyValue,
            variant: 'ghost',
            size: 'sm'
          }, () => h(resolveComponent('UIcon'), { name: 'i-heroicons-clipboard-document', class: 'w-4 h-4' }))
        ])
      ]
    )
  }
})
</script>
