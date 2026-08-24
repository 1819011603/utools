<template>
  <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-2 flex-wrap">
        <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
          可达性检测
          <span class="font-normal text-gray-400">
            （自动拿{{ epTitle ? `「${epTitle}」` : '其中一集' }}的地址实测直连/代理四条通道，切线路会重测）
          </span>
        </div>
        <!--
          清晰度挪到标题这一行、做成实色徽标——原来是行尾一句灰字，扫一眼扫不到。
          **优先用解码实测**（`decodedRes`，拉隐藏播放器真解一帧读 `<video>` 的实际像素）：
          清单声明的 `result.variantRes` 只在解码还没跑完时先顶个位，它不总是准
          （实测过 FF 线路清单写 `RESOLUTION=1080x608`，ffprobe 解密真实分片一看编码其实是 `1280x720`，
          源站清单本身就标错了），解码一出结果立刻让位
        -->
        <UBadge
          v-if="decodedRes || result?.variantRes"
          color="violet" variant="solid" size="sm"
          class="gap-1"
          :title="decodedRes ? '解码实测（真实像素）' : '清单声明的档，解码还没出结果时的临时值'"
        >
          <UIcon name="i-heroicons-tv" class="w-3.5 h-3.5" />
          {{ decodedRes || result?.variantRes }}
        </UBadge>
        <UBadge v-else-if="decodingRes" color="gray" variant="soft" size="sm" class="gap-1">
          <UIcon name="i-heroicons-arrow-path" class="w-3.5 h-3.5 animate-spin" />
          清晰度检测中…
        </UBadge>
      </div>
      <UButton size="xs" variant="soft" icon="i-heroicons-signal" :loading="probing" @click="run">
        {{ probing ? '检测中…' : '重新检测' }}
      </UButton>
    </div>

    <template v-if="result">
      <div class="flex items-start gap-1.5 text-xs" :class="verdictClass">
        <UIcon :name="verdictIcon" class="w-4 h-4 shrink-0 mt-px" />
        <span>
          <b>{{ verdict.title }}</b>
          <template v-if="verdict.detail">——{{ verdict.detail }}</template>
        </span>
      </div>
      <ProbeMatrix :rows="rows" :total-ms="result.totalMs" />
      <!-- 把实测的那条地址摊开：一条线路里各集可能不同源（实测 4kvm 最新一集走网盘直链），
           不写清测的是哪条，结论就没法归因 -->
      <p class="text-xs text-gray-400 break-all">测的是：{{ url }}</p>
    </template>
    <p v-else-if="error" class="text-xs text-red-500">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 解析页的「可达性检测」：解析出地址 ≠ 播得动。
 *
 * 这两件事在解析页是完全分开的——服务端只负责从播放页把地址抠出来，能不能取到分片
 * 取决于浏览器这边的 CORS / 防盗链 / 端口 / 出口 IP，而那些只有实测才知道。
 * 原来只能「送进播放器 → 转圈一分钟 → 加载超时 → 回来换线路」，一条线路试一轮。
 * 这里直接把播放器起播前那一轮探测搬到解析页，26 条线路挑得动的那种站点尤其省事。
 *
 * 判读和矩阵渲染都复用播放器那份（diagnoseProbe / ProbeMatrix），
 * 各写一遍必然和播放器的结论对不上。
 */
import {
  probeReachability, diagnoseProbe, probeMatrixRows, buildChannelUrl, resolveConnConfig,
  type ProbeResult, type ProbeVerdict, type Channel,
} from '~/composables/videoPlayer/useReachabilityProbe'

const props = defineProps<{
  /** 被测地址（必须是已解析出的真实播放地址，占位地址测不了） */
  url: string
  epTitle?: string
  /** 防盗链候选值，与 playAll 送进播放器的那一对保持一致，否则测出来的结论跟播的时候不是一回事 */
  origin?: string
  referer?: string
}>()

/**
 * 结论上报给页面：播放按钮要据此决定「直接播」还是「先二次确认」。
 * `verdict` 为 null = 还没测出结论（刚换线路 / 正在跑 / 检测本身报错），
 * 页面把这几种都当「没过」处理——「没测过」和「测出来不通」对用户的意义是一样的：进去可能白等。
 */
const emit = defineEmits<{ status: [{ probing: boolean; verdict: ProbeVerdict | null }] }>()

const probing = ref(false)
const result = ref<ProbeResult | null>(null)
const error = ref('')

const rows = computed(() => probeMatrixRows(result.value))
const verdict = computed(() => diagnoseProbe(result.value))
const verdictClass = computed(() => ({
  ok: 'text-green-600 dark:text-green-400',
  warn: 'text-amber-600 dark:text-amber-400',
  fatal: 'text-red-500',
}[verdict.value.severity]))
const verdictIcon = computed(() => ({
  ok: 'i-heroicons-check-circle',
  warn: 'i-heroicons-exclamation-triangle',
  fatal: 'i-heroicons-x-circle',
}[verdict.value.severity]))

/**
 * 换线路时**后点的作废先点的**：探测一轮最长 12s，而用户在 26 条线路的站点上会连着点。
 * 掐掉上一轮（`abort` 让它的请求立刻收手，别白占浏览器那 6 条连接），再用自增序号认领结果——
 * 光靠 abort 不够：被中止的那一轮不抛异常，而是带着一堆 `unknown` 正常返回（见 probeUrl 里
 * 「超时/外部中止 → unknown」），照收就会把上一条线路的假结论盖在这一条上。
 */
let seq = 0
let inflight: AbortController | null = null

/**
 * 拉起一个隐藏的 <video> + hls.js，跟真播放器走同一套连接配置
 * （`resolveConnConfig` 算出来的通道/防盗链头），让它把第一个分片真的解出一帧，
 * 读 `<video>` 的 videoWidth/videoHeight——这是浏览器吐出来的实测像素。
 *
 * **不管清单有没有声明分辨率都要跑这一遍**，不是只在没声明时兜底：声明值不总是准
 * （见模板里那句注释，FF 线路清单写 608 实测编码是 720），解码实测才是唯一可信的数。
 * 只在探测已经给出「清单可达 + 分片可达」结论时才做——没结论时拉播放器也是白折腾。
 */
const decodedRes = ref('')
const decodingRes = ref(false)
let probeHls: any = null
let probeVideoEl: HTMLVideoElement | null = null

const cleanupDecodeProbe = () => {
  if (probeHls) { try { probeHls.destroy() } catch {} probeHls = null }
  if (probeVideoEl) { try { probeVideoEl.remove() } catch {} probeVideoEl = null }
}

const runDecodeProbe = async (r: ProbeResult, mine: number) => {
  if (!r.isHls || !r.manifestChannel || !r.segmentChannel) {
    console.log('[清晰度探测] 跳过：非 HLS 或清单/分片没有可达通道', { isHls: r.isHls, manifestChannel: r.manifestChannel, segmentChannel: r.segmentChannel })
    return
  }
  decodingRes.value = true
  try {
    const { default: Hls } = await import('hls.js')
    if (mine !== seq) return
    if (!Hls.isSupported()) { console.log('[清晰度探测] 跳过：浏览器不支持 hls.js（MSE 不可用）'); return }
    // selfOrigin 只是没记 hdrOrigin 时的兜底（老缓存场景），probeReachability 当场测出的
    // 结论恒带 hdrOrigin，这里传什么基本不影响，不用再解析一遍
    const cfg = resolveConnConfig(r, props.origin?.trim() ?? '')
    if (!cfg) { console.log('[清晰度探测] 跳过：resolveConnConfig 凑不出可用的连接组合'); return }
    /*
     * **manifest 走哪条通道必须听 `cfg`，不能直接拿 `r.manifestChannel`**——两者可能不一致：
     * 探测阶段清单自己直连就通了（`r.manifestChannel === 'direct'`），但分片直连 CORS/403，
     * 分片轴选了代理；`resolveConnConfig` 的归一化规则是「分片要代理 → manifest 也必须走同一种代理」
     * （分片 URL 的重写只发生在服务端 `rewriteM3u8`，manifest 不过代理就没法把分片指向代理）。
     * 曾经直接用 `r.manifestChannel` 建 manifestUrl，manifest 走了裸直连，hls.js 按清单里的
     * 原始相对路径解出**未代理的分片地址**，实测这条线路（HN 系）分片直连 403/CORS，
     * 于是每一片都 `fragLoadError`，画质数虽然对但压根没帧可读——跟真播放器用
     * `useVideoProxy.getProxyUrl()` 的判断逻辑本该完全一致，这里必须照抄同一套判据。
     */
    const channel: Channel = cfg.disguiseAsDownloader
      ? 'disguise'
      : (cfg.requestOrigin || cfg.requestReferer ? 'headers' : 'direct')
    const manifestUrl = buildChannelUrl(props.url, channel, {
      origin: cfg.requestOrigin, referer: cfg.requestReferer, noseg: cfg.manifestOnly,
    })
    console.log('[清晰度探测] 开始解码:', manifestUrl)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    // 挂进 DOM 但完全不可见：部分浏览器对没挂进文档的 <video> 不给解码资源
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px'
    document.body.appendChild(video)
    if (mine !== seq) { video.remove(); return }
    probeVideoEl = video
    const hls = new Hls({ maxBufferLength: 2, maxMaxBufferLength: 4, startFragPrefetch: true })
    probeHls = hls
    // 静默失败会把「到底卡在哪一步」全藏起来——这里只做诊断日志，不影响可达性结论本身
    hls.on(Hls.Events.ERROR, (_: unknown, data: any) => {
      console.log('[清晰度探测] hls.js 报错:', data?.details, data?.fatal ? '(致命)' : '', data?.response?.code ?? '')
    })
    hls.attachMedia(video)
    hls.loadSource(manifestUrl)
    await new Promise<void>(resolve => {
      const done = () => { video.removeEventListener('loadedmetadata', done); resolve() }
      video.addEventListener('loadedmetadata', done)
      setTimeout(resolve, 8000)   // 兜底：拿不到就算了，别让检测卡在这一步；与探测本身的单通道超时对齐
    })
    if (mine === seq && video.videoWidth && video.videoHeight) {
      decodedRes.value = `${video.videoHeight}p`
    } else if (mine === seq) {
      console.log('[清晰度探测] 超时未解出尺寸:', { videoWidth: video.videoWidth, videoHeight: video.videoHeight, readyState: video.readyState })
    }
  } catch (e) {
    console.log('[清晰度探测] 异常（不影响可达性结论）:', e)
  } finally {
    cleanupDecodeProbe()
    if (mine === seq) decodingRes.value = false
  }
}

const run = async () => {
  if (!props.url) return
  const mine = ++seq
  inflight?.abort()
  cleanupDecodeProbe()
  decodedRes.value = ''
  const ctrl = new AbortController()
  inflight = ctrl
  probing.value = true
  error.value = ''
  result.value = null
  try {
    const r = await probeReachability(props.url, {
      origin: props.origin, referer: props.referer, signal: ctrl.signal,
    })
    if (mine !== seq) return
    // 结论只服务本页这块 UI（进播放器前先知道能不能播）。**不再落一份给播放器复用**——
    // 那份跨页缓存已按需求删掉，播放器起播时一律自己当场实测一轮
    result.value = r
    void runDecodeProbe(r, mine)
  } catch (e: any) {
    if (mine !== seq) return
    error.value = '检测失败：' + (e?.message || String(e))
  } finally {
    // 已被新一轮接管时绝不能碰它，否则会把那一轮的转圈提前抹掉
    if (mine === seq) probing.value = false
  }
}

// **点到哪条线路就自动测哪条**（`immediate` 让解析一出结果就测第一条）。
// 不做成「手动点一下」：每条线路的视频域名和防盗链都可能不一样（实测 kpkuang 26 条线路各认一个域名），
// 上一条线路的结论摆在那儿只会被当成这一条的；而这块 UI 的意义就是「进播放器前先知道能不能播」，
// 还要多点一下的话多数时候就直接跳过了
watch(() => props.url, () => { void run() }, { immediate: true })
// 组件卸下（换成内嵌线路 / 离开本页）时把还在跑的那轮收掉，别留一串没人要的请求
onUnmounted(() => { inflight?.abort(); cleanupDecodeProbe() })

// 上报用 watchEffect 而不是在 run() 里手动 emit：状态有三处会变（开始探、拿到结论、换线路清空），
// 漏一处页面就会拿着过期结论放行播放
watchEffect(() => emit('status', {
  probing: probing.value,
  verdict: result.value ? verdict.value : null,
}))
</script>
