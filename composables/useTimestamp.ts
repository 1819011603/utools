/**
 * 时间戳转换页面逻辑（从 `pages/timestamp.vue` 下沉，纯搬运、行为不变）。
 */
import { useDebounceFn } from '@vueuse/core'

const STORAGE_KEY = 'timestamp-settings'

export function useTimestamp() {
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

  return {
    input,
    timezone,
    error,
    result,
    relativeTime,
    timezoneOptions,
    extraFormats,
    convert,
    debouncedConvert,
    useNow,
    copyValue
  }
}
