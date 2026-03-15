<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">视频播放器 V2</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">Plyr + hls.js + useStorage + hotkeys-js，支持 M3U8/MP4 播放与下载</p>
      </div>
      <UButton variant="ghost" size="sm" to="/video-player">
        <UIcon name="i-heroicons-arrow-left" class="w-4 h-4 mr-1" />
        返回原版
      </UButton>
    </div>

    <!-- 视频输入 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-heroicons-link" class="w-5 h-5 text-violet-500" />
          <span class="font-semibold">视频源</span>
          <UBadge v-if="playlist.length > 1" color="green" variant="soft" size="xs">
            播放列表: {{ currentIndex + 1 }}/{{ playlist.length }}
          </UBadge>
        </div>
      </template>

      <div class="space-y-4">
        <UFormGroup label="视频地址" help="支持多个链接，每行一个">
          <UTextarea
            v-model="videoUrlInput"
            placeholder="输入 m3u8 或 mp4 视频地址...&#10;支持多个链接，每行一个"
            :rows="3"
            @keydown.ctrl.enter="parseAndLoad"
          />
        </UFormGroup>

        <div class="flex gap-2 flex-wrap">
          <UButton color="primary" @click="parseAndLoad" :disabled="!videoUrlInput.trim()" :loading="isLoading">
            <UIcon name="i-heroicons-play" class="w-4 h-4 mr-1" />
            解析并播放
          </UButton>
          <UCheckbox v-model="autoFullscreen" label="加载后自动全屏" />
          <UCheckbox v-model="useProxy" label="使用跨域代理" />
        </div>

        <!-- Origin / Referer -->
        <div class="flex gap-4 flex-wrap items-end">
          <UFormGroup label="Origin" help="注入请求头 Origin">
            <UInput v-model="requestOrigin" placeholder="https://example.com" class="w-52" />
          </UFormGroup>
          <UFormGroup label="Referer" :help="refererHelp">
            <UInput v-model="requestReferer" :placeholder="effectiveReferer || 'https://example.com/'" class="w-64" />
          </UFormGroup>
          <UFormGroup label=" " class="pt-1">
            <UCheckbox v-model="manifestOnly" label="仅代理 Manifest（推荐）" />
          </UFormGroup>
        </div>

        <!-- 片头片尾 -->
        <div class="flex gap-4 flex-wrap items-end">
          <UFormGroup label="跳过片头">
            <div class="flex items-center gap-2">
              <UInput v-model.number="skipIntro" type="number" :min="0" :max="300" :step="5" class="w-24" />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
          <UFormGroup label="跳过片尾">
            <div class="flex items-center gap-2">
              <UInput v-model.number="skipOutro" type="number" :min="0" :max="300" :step="5" class="w-24" />
              <span class="text-sm text-gray-500">秒</span>
            </div>
          </UFormGroup>
        </div>

        <!-- 播放列表 -->
        <div v-if="playlist.length > 1" class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">播放列表</span>
            <div class="flex gap-2">
              <UButton size="xs" variant="soft" @click="clearAllProgress">清除进度</UButton>
              <UButton size="xs" variant="ghost" color="red" @click="clearPlaylist">清空列表</UButton>
            </div>
          </div>
          <div class="max-h-40 overflow-y-auto space-y-1 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div
              v-for="(item, index) in playlist"
              :key="index"
              class="flex items-center gap-2 p-2 rounded cursor-pointer transition-colors text-sm group/item"
              :class="index === currentIndex ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'hover:bg-gray-100 dark:hover:bg-gray-700'"
              @click="playByIndex(index)"
            >
              <UIcon
                :name="index === currentIndex && isPlaying ? 'i-heroicons-speaker-wave' : 'i-heroicons-play'"
                class="w-4 h-4 shrink-0"
              />
              <span class="flex-1 truncate">{{ getVideoName(item, index) }}</span>
              <span v-if="getSavedProgress(item) > 0" class="text-xs text-gray-400">
                {{ formatTime(getSavedProgress(item)) }}
              </span>
              <button
                v-if="item.startsWith('http') && !isDownloading"
                class="opacity-0 group-hover/item:opacity-100 p-1 rounded hover:bg-violet-500/30 transition-all shrink-0"
                title="下载"
                @click.stop="downloadVideo(item)"
              >
                <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4" />
              </button>
              <UBadge v-if="index === currentIndex" color="violet" variant="soft" size="xs">当前</UBadge>
            </div>
          </div>
        </div>

        <!-- 本地文件 -->
        <div class="text-center text-sm text-gray-500 dark:text-gray-400">或</div>
        <FileUpload
          accept="video/*,.m3u8,.mp4,.webm,.mkv"
          accept-text="视频文件 (MP4, WebM, MKV, M3U8)"
          icon="i-heroicons-film"
          :multiple="true"
          @files="handleLocalFiles"
        />

        <!-- 示例 -->
        <div class="flex flex-wrap gap-2">
          <span class="text-sm text-gray-500">示例：</span>
          <UButton v-for="ex in exampleUrls" :key="ex.url" size="xs" variant="soft" @click="loadExample(ex.url)">
            {{ ex.name }}
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- 播放器 -->
    <UCard v-if="isVideoLoaded" class="overflow-hidden">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-play-circle" class="w-5 h-5 text-emerald-500" />
            <span class="font-semibold">播放器</span>
            <UBadge :color="isHls ? 'violet' : 'blue'" variant="soft" size="xs">
              {{ isHls ? 'HLS/M3U8' : 'MP4' }}
            </UBadge>
          </div>
          <div v-if="isHls && prefetchInfo.cached > 0" class="flex gap-2 text-sm">
            <UBadge color="green" variant="soft" size="xs">缓存: {{ prefetchInfo.cached }} 片</UBadge>
            <UBadge color="cyan" variant="soft" size="xs">缓冲: {{ prefetchInfo.bufferSecs }}s</UBadge>
          </div>
        </div>
      </template>

      <div ref="playerContainer" class="relative bg-black rounded-lg overflow-hidden">
        <video
          ref="videoEl"
          :key="videoKey"
          class="video-js"
          :crossorigin="isLocalFile ? undefined : 'anonymous'"
          playsinline
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoadedMetadata"
          @play="isPlaying = true"
          @pause="isPlaying = false"
          @ended="onVideoEnded"
          @waiting="isBuffering = true"
          @canplay="onCanPlay"
          @canplaythrough="isBuffering = false"
          @seeking="isBuffering = true"
          @seeked="onSeeked"
          @playing="isBuffering = false"
          @volumechange="onVolumeChange"
          @error="onVideoError"
        />

        <!-- 加载中 -->
        <div v-if="isBuffering" class="absolute inset-0 flex items-center justify-center bg-black/30">
          <UIcon name="i-heroicons-arrow-path" class="w-12 h-12 text-white animate-spin" />
        </div>

        <!-- 自定义控制：上下集、下载 -->
        <div class="absolute bottom-14 left-0 right-0 flex justify-center gap-2 z-10 px-4">
          <template v-if="playlist.length > 1">
            <UButton
              size="sm"
              color="white"
              variant="soft"
              :disabled="!hasPrev"
              @click="playPrev"
            >
              <UIcon name="i-heroicons-backward-solid" class="w-4 h-4" />
            </UButton>
            <UButton
              size="sm"
              color="white"
              variant="soft"
              :disabled="!hasNext"
              @click="playNext"
            >
              <UIcon name="i-heroicons-forward-solid" class="w-4 h-4" />
            </UButton>
          </template>
          <UButton
            v-if="canDownload"
            size="sm"
            color="white"
            variant="soft"
            :loading="isDownloading"
            :disabled="isDownloading"
            @click="downloadVideo()"
          >
            <template v-if="isDownloading">{{ downloadProgress }}%</template>
            <template v-else>
              <UIcon name="i-heroicons-arrow-down-tray" class="w-4 h-4" />
            </template>
          </UButton>
        </div>
      </div>

      <p v-if="errorMessage" class="mt-2 text-sm text-red-500">{{ errorMessage }}</p>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import Plyr from 'plyr'
import 'plyr/dist/plyr.css'
import Hls from 'hls.js'
import hotkeys from 'hotkeys-js'
import { useStorage } from '@vueuse/core'
import { Parser as M3u8Parser } from 'm3u8-parser'

const route = useRoute()

// useStorage 持久化
const videoUrlInput = useStorage('vp2-url', '')
const playlist = useStorage<string[]>('vp2-playlist', [])
const currentIndex = useStorage('vp2-index', 0)
const progress = useStorage<Record<string, number>>('vp2-progress', {})
const volume = useStorage('vp2-volume', 1)
const playbackRate = useStorage('vp2-rate', 1)
const useProxy = useStorage('vp2-proxy', false)
const autoFullscreen = useStorage('vp2-autofs', true)
const skipIntro = useStorage('vp2-skipIntro', 0)
const skipOutro = useStorage('vp2-skipOutro', 0)
const requestOrigin = useStorage('vp2-origin', '')
const requestReferer = useStorage('vp2-referer', '')
const manifestOnly = useStorage('vp2-manifestOnly', true)

const effectiveReferer = computed(() => {
  const r = requestReferer.value.trim()
  if (r) return r
  const o = requestOrigin.value.trim()
  return o ? o.replace(/\/$/, '') + '/' : ''
})
const refererHelp = computed(() => {
  const o = requestOrigin.value.trim()
  return o ? `留空时自动填 ${o.replace(/\/$/, '')}/` : '注入 Referer'
})

const videoUrl = ref('')
const isVideoLoaded = ref(false)
const isHls = ref(false)
const isLocalFile = ref(false)
const errorMessage = ref('')
const isLoading = ref(false)
const isPlaying = ref(false)
const isBuffering = ref(false)
const videoKey = ref(0)
const hasSkippedIntro = ref(false)
const isDownloading = ref(false)
const downloadProgress = ref(0)
const corsProxies = ['https://corsproxy.io/?']

const hasPrev = computed(() => currentIndex.value > 0)
const hasNext = computed(() => currentIndex.value < playlist.value.length - 1)

const prefetchInfo = ref({ bufferSecs: 0, cached: 0, pending: 0 })
const segPrefetchCache = new Map<string, ArrayBuffer>()
const segPrefetching = new Map<string, Promise<ArrayBuffer>>()
let hls: Hls | null = null
let plyr: Plyr | null = null

const videoEl = ref<HTMLVideoElement>()
const playerContainer = ref<HTMLDivElement>()
const exampleUrls = [
  { name: 'Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Sintel (HLS)', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { name: 'Tears of Steel (MP4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' }
]

const localFileUrls = new Map<string, string>()
let downloadCancelled = false

const isHlsUrl = (url: string) => url.includes('.m3u8') || url.includes('m3u8')
const getProxyUrl = (url: string): string => {
  if (url.includes('/api/proxy?')) return url
  const o = requestOrigin.value.trim()
  const r = effectiveReferer.value
  if (o || r) {
    if (manifestOnly.value && !isHlsUrl(url)) return url
    const params = new URLSearchParams({ url })
    if (o) params.set('origin', o)
    if (r) params.set('referer', r)
    if (manifestOnly.value) params.set('noseg', '1')
    return '/api/proxy?' + params.toString()
  }
  if (useProxy.value) return corsProxies[0] + encodeURIComponent(url)
  return url
}

const getVideoName = (url: string, index: number): string => {
  try {
    const pathname = new URL(url).pathname
    const name = decodeURIComponent(pathname.split('/').pop() || '')
    return name || `视频 ${index + 1}`
  } catch {
    return `视频 ${index + 1}`
  }
}

const formatTime = (s: number): string => {
  if (!isFinite(s) || isNaN(s)) return '00:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

const getSavedProgress = (url: string) => progress.value[url] || 0
const saveCurrentProgress = () => {
  if (videoUrl.value && videoEl.value && videoEl.value.currentTime > 0 && !isLocalFile.value) {
    progress.value[videoUrl.value] = videoEl.value.currentTime
  }
}

const canDownload = computed(() =>
  isVideoLoaded.value && !isLocalFile.value && videoUrl.value && (videoUrl.value.startsWith('http') || videoUrl.value.startsWith('//'))
)

// 解析 M3U8 获取分片 URL（使用 m3u8-parser）
const resolveUrl = (base: string, rel: string) => {
  if (rel.startsWith('http')) return rel
  try {
    return new URL(rel, base).href
  } catch {
    return rel
  }
}

const getM3u8SegmentUrls = async (m3u8Url: string): Promise<string[]> => {
  const proxyUrl = m3u8Url.startsWith('/api/proxy') ? m3u8Url : getProxyUrl(m3u8Url)
  const res = await fetch(proxyUrl)
  if (!res.ok) throw new Error(`获取 M3U8 失败: ${res.status}`)
  const text = await res.text()
  const actualUrl = res.url || proxyUrl
  let baseUrl: string
  try {
    const u = new URL(actualUrl, window.location.href)
    baseUrl = u.origin + u.pathname.replace(/\/[^/]*$/, '/')
  } catch {
    baseUrl = actualUrl.replace(/\/[^/]*$/, '/')
  }

  const parser = new M3u8Parser({ uri: baseUrl || 'https://a.com/' })
  parser.push(text)
  parser.end()
  const manifest = (parser as any).manifest

  if (manifest.playlists?.length) {
    const best = manifest.playlists.sort((a: any, b: any) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0))[0]
    return getM3u8SegmentUrls(resolveUrl(baseUrl, best.uri))
  }

  const segments = manifest.segments || []
  if (segments.length === 0) throw new Error('M3U8 解析失败，未找到分片')
  return segments.map((s: any) => resolveUrl(baseUrl, s.uri))
}

const triggerDownload = (blob: Blob, filename: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const cancelDownload = () => {
  downloadCancelled = true
  isDownloading.value = false
  downloadProgress.value = 0
}

const downloadVideo = async (targetUrl?: string) => {
  const url = (targetUrl || videoUrl.value)?.trim()
  if (!url || (!url.startsWith('http') && !url.startsWith('//'))) {
    errorMessage.value = '无可下载的视频地址'
    return
  }
  const normalizedUrl = url.startsWith('//') ? 'https:' + url : url
  isDownloading.value = true
  downloadProgress.value = 0
  downloadCancelled = false
  errorMessage.value = ''
  const idx = playlist.value.indexOf(url)
  const filename = getVideoName(normalizedUrl, idx >= 0 ? idx : currentIndex.value) || `video_${Date.now()}`

  try {
    if (isHlsUrl(normalizedUrl)) {
      const segmentUrls = await getM3u8SegmentUrls(normalizedUrl)
      if (downloadCancelled) return
      const total = segmentUrls.length
      const CONCURRENCY = 6
      const cache = new Map<string, ArrayBuffer>()
      let completed = 0
      const fetchOne = async (segUrl: string) => {
        if (downloadCancelled) return
        if (!cache.has(segUrl)) {
          const r = await fetch(getProxyUrl(segUrl))
          const buf = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0)
          if (buf.byteLength > 0) cache.set(segUrl, buf)
        }
        completed++
        downloadProgress.value = Math.round((completed / total) * 100)
      }
      for (let i = 0; i < total; i += CONCURRENCY) {
        if (downloadCancelled) return
        await Promise.all(segmentUrls.slice(i, i + CONCURRENCY).map(fetchOne))
      }
      if (downloadCancelled) return
      const totalSize = segmentUrls.reduce((s, u) => s + (cache.get(u)?.byteLength ?? 0), 0)
      const merged = new Uint8Array(totalSize)
      let offset = 0
      for (const u of segmentUrls) {
        const buf = cache.get(u)
        if (buf?.byteLength) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
      }
      const isFmp4 = segmentUrls.some(u => u.includes('.m4s') || u.includes('.mp4'))
      const mime = isFmp4 ? 'video/mp4' : 'video/mp2t'
      const ext = isFmp4 ? '.mp4' : '.ts'
      triggerDownload(new Blob([merged], { type: mime }), filename.replace(/\.m3u8.*$/, '') + ext)
    } else {
      const res = await fetch(getProxyUrl(normalizedUrl))
      if (!res.ok) throw new Error(`下载失败: ${res.status}`)
      const blob = await res.blob()
      downloadProgress.value = 100
      const ext = filename.includes('.') ? '' : '.mp4'
      triggerDownload(blob, filename.includes('.mp4') ? filename : filename + ext)
    }
    useToast().add({ title: '下载完成', color: 'green', timeout: 3000 })
  } catch (e: any) {
    if (downloadCancelled) {
      useToast().add({ title: '下载已取消', color: 'amber', timeout: 2000 })
      return
    }
    errorMessage.value = e instanceof Error ? e.message : String(e)
    useToast().add({ title: '下载失败', color: 'red', timeout: 3000 })
  } finally {
    isDownloading.value = false
    downloadProgress.value = 0
  }
}

// 自定义 HLS FragLoader + 预取
const getAdaptivePrefetchCount = (bufferSecs: number) => {
  if (bufferSecs < 8) return 4
  if (bufferSecs < 25) return 2
  return 0
}

const createHlsFragLoader = () => {
  return class PrefetchFragLoader {
    context: any
    stats: any = {
      aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 }
    }
    private ctrl: AbortController | null = null

    load(context: any, config: any, callbacks: any) {
      this.context = context
      const url: string = context.url
      const t0 = performance.now()
      Object.assign(this.stats, {
        aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
        loading: { ...this.stats.loading, start: t0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 }
      })
      const succeed = (data: ArrayBuffer) => {
        this.stats.loaded = data.byteLength
        this.stats.total = data.byteLength
        this.stats.chunkCount = 1
        if (!this.stats.loading.first) this.stats.loading.first = t0 + 1
        this.stats.loading.end = performance.now()
        callbacks.onSuccess({ data, url }, this.stats, context)
      }
      const fail = (e: Error) => {
        this.stats.loading.end = performance.now()
        callbacks.onError({ code: 0, text: e.message }, context, null, this.stats)
      }
      if (segPrefetchCache.has(url)) {
        const buf = segPrefetchCache.get(url)!
        segPrefetchCache.delete(url)
        segPrefetchCache.set(url, buf)
        prefetchInfo.value.cached = segPrefetchCache.size
        succeed(buf)
        return
      }
      if (segPrefetching.has(url)) {
        segPrefetching.get(url)!.then(b => b.byteLength ? succeed(b) : this.doFetch(url, config, succeed, fail)).catch(() => this.doFetch(url, config, succeed, fail))
        return
      }
      this.doFetch(url, config, succeed, fail)
    }

    private doFetch(url: string, config: any, succeed: (b: ArrayBuffer) => void, fail: (e: Error) => void) {
      this.ctrl = new AbortController()
      const timeout = config?.timeout ?? 30000
      const timer = setTimeout(() => this.ctrl?.abort(), timeout)
      fetch(getProxyUrl(url), { signal: this.ctrl.signal })
        .then(r => { clearTimeout(timer); if (!r.ok) throw new Error(`HTTP ${r.status}`); this.stats.loading.first = performance.now(); return r.arrayBuffer() })
        .then(succeed)
        .catch(e => { clearTimeout(timer); if (e?.name !== 'AbortError') fail(e instanceof Error ? e : new Error(String(e))) })
    }

    abort() { this.ctrl?.abort(); this.stats.aborted = true }
    destroy() { this.abort() }
  }
}

const triggerAdaptivePrefetch = (lastFragSn: number) => {
  if (!hls || !videoEl.value || (requestOrigin.value.trim() || effectiveReferer.value) && !manifestOnly.value) return
  const video = videoEl.value
  const bufferSecs = video.buffered.length > 0 ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0
  const count = getAdaptivePrefetchCount(bufferSecs)
  prefetchInfo.value = { bufferSecs: Math.round(bufferSecs * 10) / 10, cached: segPrefetchCache.size, pending: segPrefetching.size }
  if (count === 0) return
  const level = hls!.currentLevel >= 0 ? hls!.currentLevel : 0
  const levelDetails = (hls as any)?.levels?.[level]?.details
  if (!levelDetails) return
  const frags: any[] = levelDetails.fragments
  const startIdx = frags.findIndex((f: any) => f.sn === lastFragSn) + 1
  if (startIdx <= 0) return
  const canStart = Math.max(0, count - segPrefetching.size)
  if (canStart === 0) return
  const candidates = frags.slice(startIdx, startIdx + count * 3)
  let started = 0
  for (const frag of candidates) {
    if (started >= canStart) break
    const u = frag.url
    if (!u || segPrefetchCache.has(u) || segPrefetching.has(u)) continue
    started++
    const p = fetch(getProxyUrl(u)).then(r => r.ok ? r.arrayBuffer() : new ArrayBuffer(0))
    segPrefetching.set(u, p)
    p.then(buf => {
      segPrefetching.delete(u)
      if (buf.byteLength > 0) {
        segPrefetchCache.set(u, buf)
        prefetchInfo.value = { ...prefetchInfo.value, cached: segPrefetchCache.size }
      }
    }).catch(() => segPrefetching.delete(u))
  }
}

const destroyHls = () => {
  if (hls) { hls.destroy(); hls = null }
  segPrefetchCache.clear()
  segPrefetching.clear()
  prefetchInfo.value = { bufferSecs: 0, cached: 0, pending: 0 }
}

const parseAndLoad = async () => {
  const urls = videoUrlInput.value.trim().split(/[\n\r]+/).map(l => l.trim()).filter(l => l && (l.startsWith('http') || l.startsWith('//')))
  if (urls.length === 0) { errorMessage.value = '未找到有效链接'; return }
  playlist.value = urls
  currentIndex.value = 0
  await playByIndex(0)
}

const playByIndex = async (index: number) => {
  if (index < 0 || index >= playlist.value.length) return
  saveCurrentProgress()
  currentIndex.value = index
  videoUrl.value = playlist.value[index]
  hasSkippedIntro.value = false
  await loadVideo()
}

const playPrev = () => hasPrev.value && playByIndex(currentIndex.value - 1)
const playNext = () => hasNext.value && playByIndex(currentIndex.value + 1)
const clearAllProgress = () => { progress.value = {} }
const clearPlaylist = () => { playlist.value = []; currentIndex.value = 0; videoUrlInput.value = '' }
const loadExample = async (url: string) => { videoUrlInput.value = url; await parseAndLoad() }

const loadVideo = async () => {
  const url = videoUrl.value.trim()
  if (!url) return
  plyr?.destroy()
  plyr = null
  destroyHls()
  errorMessage.value = ''
  isVideoLoaded.value = true
  isLocalFile.value = false
  isHls.value = isHlsUrl(url)
  videoKey.value++

  await nextTick()
  await new Promise(r => setTimeout(r, 100))
  if (!videoEl.value) return

  try {
    if (isHls.value) {
      if (!Hls.isSupported()) {
        if (videoEl.value.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.value.src = getProxyUrl(url)
          videoEl.value.load()
          return
        }
        throw new Error('浏览器不支持 HLS')
      }
      hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 600 * 1024 * 1024,
        fLoader: createHlsFragLoader() as any
      })
      hls.loadSource(getProxyUrl(url))
      hls.attachMedia(videoEl.value)
      hls.on(Hls.Events.MANIFEST_PARSED, () => { isLoading.value = false })
      hls.on(Hls.Events.ERROR, (_, data: any) => {
        if (data.fatal) {
          errorMessage.value = data.details || 'HLS 加载失败'
          isLoading.value = false
          destroyHls()
        }
      })
      hls.on(Hls.Events.FRAG_BUFFERED, (_, data: any) => {
        isBuffering.value = false
        if (data?.frag) triggerAdaptivePrefetch(data.frag.sn)
      })
      hls.on(Hls.Events.FRAG_LOADING, () => {
        if (videoEl.value?.buffered.length && videoEl.value.buffered.end(videoEl.value.buffered.length - 1) - videoEl.value.currentTime < 2) isBuffering.value = true
      })
    } else {
      videoEl.value.src = getProxyUrl(url)
      videoEl.value.load()
      isLoading.value = false
    }
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    isLoading.value = false
  }
  nextTick(() => initPlyr())
}

const handleLocalFiles = async (files: File[]) => {
  const videoFiles = files.filter(f => !f.name.endsWith('.m3u8'))
  if (videoFiles.length === 0) { errorMessage.value = '本地 M3U8 请用 URL 加载'; return }
  destroyHls()
  localFileUrls.forEach(u => URL.revokeObjectURL(u))
  localFileUrls.clear()
  const urls: string[] = []
  for (const f of videoFiles) {
    const url = URL.createObjectURL(f)
    localFileUrls.set(f.name, url)
    urls.push(url)
  }
  playlist.value = urls
  currentIndex.value = 0
  videoUrl.value = videoFiles[0].name
  isHls.value = false
  isLocalFile.value = true
  isVideoLoaded.value = true
  videoKey.value++
  await nextTick()
  if (videoEl.value) {
    videoEl.value.src = urls[0]
    videoEl.value.load()
  }
  nextTick(() => initPlyr())
}

const onTimeUpdate = () => {
  if (!videoEl.value) return
  if (videoUrl.value && !isLocalFile.value && videoEl.value.currentTime > 0) {
    progress.value[videoUrl.value] = videoEl.value.currentTime
  }
  if (skipOutro.value > 0 && videoEl.value.duration > 0 && hasNext.value) {
    const remain = videoEl.value.duration - videoEl.value.currentTime
    if (remain > 0 && remain <= skipOutro.value) playNext()
  }
}

const onLoadedMetadata = () => {
  if (!videoEl.value) return
  const saved = getSavedProgress(videoUrl.value)
  if (saved > 0 && saved < videoEl.value.duration - 5) {
    videoEl.value.currentTime = saved
    hasSkippedIntro.value = true
  } else if (skipIntro.value > 0 && !hasSkippedIntro.value) {
    videoEl.value.currentTime = skipIntro.value
    hasSkippedIntro.value = true
  }
  videoEl.value.playbackRate = playbackRate.value
  videoEl.value.volume = volume.value
}

const onVolumeChange = () => {
  if (videoEl.value) { volume.value = videoEl.value.volume }
}

const onCanPlay = () => {
  isLoading.value = false
  if (videoEl.value) {
    videoEl.value.playbackRate = playbackRate.value
    videoEl.value.volume = volume.value
  }
  setTimeout(() => videoEl.value?.play().catch(() => {}), 500)
  if (autoFullscreen.value && playerContainer.value && !document.fullscreenElement) {
    setTimeout(() => playerContainer.value?.requestFullscreen().catch(() => {}), 200)
  }
}

const onSeeked = () => {
  segPrefetchCache.clear()
  segPrefetching.clear()
  prefetchInfo.value.cached = 0
  prefetchInfo.value.pending = 0
  setTimeout(() => { isBuffering.value = false }, 200)
}

const onVideoError = (e: Event) => {
  const err = (e.target as HTMLVideoElement)?.error
  errorMessage.value = err ? `加载失败: ${err.code}` : '视频加载失败'
  isLoading.value = false
  isBuffering.value = false
  isVideoLoaded.value = false
  destroyHls()
}

const onVideoEnded = () => {
  if (hasNext.value) playNext()
}

// Plyr 初始化
const initPlyr = () => {
  if (!videoEl.value || plyr) return
  plyr = new Plyr(videoEl.value, {
    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
    settings: ['speed'],
    speed: { selected: 1, options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] }
  })
  plyr.on('ratechange', () => { if (plyr) playbackRate.value = plyr.playbackRate })
  plyr.on('volumechange', () => { if (plyr) volume.value = plyr.volume })
}

// hotkeys-js
const setupHotkeys = () => {
  hotkeys.setScope('video-player-v2')
  hotkeys('space', 'video-player-v2', (e) => { e.preventDefault(); videoEl.value?.paused ? videoEl.value.play() : videoEl.value?.pause() })
  hotkeys('f', 'video-player-v2', () => playerContainer.value && (document.fullscreenElement ? document.exitFullscreen() : playerContainer.value.requestFullscreen()))
  hotkeys('left', 'video-player-v2', () => { if (videoEl.value) videoEl.value.currentTime -= 10 })
  hotkeys('right', 'video-player-v2', () => { if (videoEl.value) videoEl.value.currentTime += 10 })
  hotkeys('j', 'video-player-v2', () => hasPrev.value && playByIndex(currentIndex.value - 1))
  hotkeys('k', 'video-player-v2', () => hasNext.value && playByIndex(currentIndex.value + 1))
}

onMounted(async () => {
  setupHotkeys()
  window.addEventListener('beforeunload', saveCurrentProgress)
  const urlParam = route.query.url as string
  if (urlParam) {
    videoUrlInput.value = urlParam
    await nextTick()
    parseAndLoad()
  } else if (playlist.value.length) {
    const idx = currentIndex.value
    const url = playlist.value[idx]
    if (url?.startsWith('http')) {
      await nextTick()
      playByIndex(idx)
    }
  } else if (videoUrlInput.value.trim()) {
    await nextTick()
    parseAndLoad()
  }
})

onUnmounted(() => {
  saveCurrentProgress()
  destroyHls()
  hotkeys.deleteScope('video-player-v2')
  window.removeEventListener('beforeunload', saveCurrentProgress)
  plyr?.destroy()
  plyr = null
  localFileUrls.forEach(u => URL.revokeObjectURL(u))
  localFileUrls.clear()
})

</script>
