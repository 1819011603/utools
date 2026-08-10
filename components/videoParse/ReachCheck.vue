<template>
  <div class="p-3 rounded-lg bg-gray-50 dark:bg-gray-800 space-y-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="text-sm font-medium text-gray-700 dark:text-gray-300">
        可达性检测
        <span class="font-normal text-gray-400">
          （自动拿{{ epTitle ? `「${epTitle}」` : '其中一集' }}的地址实测直连/代理四条通道，切线路会重测）
        </span>
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
      <ProbeMatrix :rows="rows" />
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
  probeReachability, diagnoseProbe, probeMatrixRows,
  type ProbeResult, type ProbeVerdict,
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

const run = async () => {
  if (!props.url) return
  const mine = ++seq
  inflight?.abort()
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
    result.value = r
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
onUnmounted(() => inflight?.abort())

// 上报用 watchEffect 而不是在 run() 里手动 emit：状态有三处会变（开始探、拿到结论、换线路清空），
// 漏一处页面就会拿着过期结论放行播放
watchEffect(() => emit('status', {
  probing: probing.value,
  verdict: result.value ? verdict.value : null,
}))
</script>
