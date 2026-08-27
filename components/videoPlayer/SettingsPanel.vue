<template>
  <Transition name="drawer">
    <div
      v-if="showSettings"
      data-no-gesture
      class="absolute inset-y-0 right-0 z-30 w-[70%] min-w-[15rem] max-w-[19rem]
             flex flex-col bg-black/80 backdrop-blur-xl ring-1 ring-white/10 text-white"
      @contextmenu.prevent
    >
      <div class="shrink-0 flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span class="text-[15px] font-semibold">播放设置</span>
        <button class="ml-auto p-1 rounded-lg text-white/60 hover:bg-white/10" title="关闭" @click="showSettings = false">
          <UIcon name="i-heroicons-x-mark" class="w-4 h-4" />
        </button>
      </div>

      <div class="no-sb flex-1 overflow-y-auto px-3.5 pb-4 space-y-3 text-[13px]">
        <!-- 声音 / 亮度：竖滑手势改的就是这两个值，这里给一份能精确调的入口 -->
        <div class="flex items-center gap-2.5">
          <span class="w-14 shrink-0 text-white/70">声音</span>
          <input
            type="range" min="0" max="100" step="1" :value="Math.round(volume * 100)"
            class="flex-1 h-1 rounded-full appearance-none bg-white/20 accent-rose-500"
            @input="onVolume"
          >
          <span class="w-8 shrink-0 text-right tabular-nums text-white/80">{{ Math.round(volume * 100) }}</span>
        </div>

        <div class="flex items-center gap-2.5">
          <span class="w-14 shrink-0 text-white/70">亮度</span>
          <input
            type="range" min="25" max="160" step="1" :value="Math.round(brightness * 100)"
            class="flex-1 h-1 rounded-full appearance-none bg-white/20 accent-rose-500"
            @input="onBright"
          >
          <span class="w-8 shrink-0 text-right tabular-nums text-white/80">{{ Math.round(brightness * 100) }}</span>
        </div>

        <div class="space-y-1.5">
          <span class="text-white/70">画面尺寸</span>
          <div class="flex rounded-lg overflow-hidden ring-1 ring-white/10">
            <button
              v-for="f in FIT_MODES"
              :key="f.id"
              class="flex-1 py-1.5 text-[12px] transition-colors"
              :class="fitMode === f.id ? 'bg-rose-500/85 font-medium' : 'bg-white/5 hover:bg-white/10 text-white/75'"
              @click="pickFit(f.id)"
            >{{ f.label }}</button>
          </div>
        </div>

        <!-- 片头片尾用滑条而不是数字框：这两个值是「凑着画面调」的，边拖边看比敲数字准 -->
        <div class="flex items-center gap-2.5" title="从第 N 秒开始播（有进度记录时以进度为准）">
          <span class="w-14 shrink-0 text-white/70">跳过片头</span>
          <input
            v-model.number="skipIntro" type="range" min="0" max="300" step="5"
            class="flex-1 h-1 rounded-full appearance-none bg-white/20 accent-rose-500"
            @change="saveState"
          >
          <span class="w-10 shrink-0 text-right tabular-nums text-white/80">{{ mmss(skipIntro) }}</span>
        </div>

        <div class="flex items-center gap-2.5" title="剩余时间少于此值自动跳下一集（00:00 = 关）">
          <span class="w-14 shrink-0 text-white/70">跳过片尾</span>
          <input
            v-model.number="skipOutro" type="range" min="0" max="300" step="5"
            class="flex-1 h-1 rounded-full appearance-none bg-white/20 accent-rose-500"
            @change="saveState"
          >
          <span class="w-10 shrink-0 text-right tabular-nums text-white/80">{{ mmss(skipOutro) }}</span>
        </div>
        <div class="flex items-center gap-2.5">
          <span class="flex-1 text-white/70">长按加速</span>
          <button class="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 active:scale-90 transition-all" @click="stepBoost(-0.25)">
            <UIcon name="i-heroicons-minus" class="w-3.5 h-3.5" />
          </button>
          <span class="w-11 text-center tabular-nums font-medium">{{ boostRatePref }}x</span>
          <button class="w-7 h-7 rounded-lg bg-rose-500/80 hover:bg-rose-500 active:scale-90 transition-all" @click="stepBoost(0.25)">
            <UIcon name="i-heroicons-plus" class="w-3.5 h-3.5" />
          </button>
        </div>

        <div class="pt-2.5 border-t border-white/10 space-y-2.5">
          <!-- 详细说明一律进 title：面板上只留标签，几行小字堆起来比开关本身还占地方 -->
          <div
            class="flex items-center gap-2"
            title="浏览器不提供关闭硬解的开关；关掉它 = 只用 H.264/SDR 的档"
          >
            <span class="flex-1">
              硬件解码
              <span
                v-if="hwProbe"
                class="ml-1 px-1 py-px rounded text-[10px] align-middle"
                :class="hwProbe === 'hw' ? 'bg-emerald-500/25 text-emerald-300' : 'bg-amber-500/25 text-amber-300'"
              >{{ hwProbe === 'hw' ? '硬解' : '软解' }}</span>
            </span>
            <button :class="swClass(hwDecode)" @click="toggleHw">
              <span :class="knobClass(hwDecode)" />
            </button>
          </div>
          <!-- 只留这一句：不写的话「关了这个开关有什么用」压根没人猜得到 -->
          <p class="text-[11px] text-amber-300/70 -mt-1.5">音画不同步、不能快进时试着关掉</p>

          <div class="flex items-center gap-2" title="竖屏不生效——竖屏全屏的黑边比不全屏还大">
            <span class="flex-1">加载后自动全屏</span>
            <button :class="swClass(autoFullscreen)" @click="autoFullscreen = !autoFullscreen; saveState()">
              <span :class="knobClass(autoFullscreen)" />
            </button>
          </div>

          <div class="flex items-center gap-2" :title="`在 1x ~ ${autoRateCap}x 内按带宽取值，流畅提速、卡了降回`">
            <span class="flex-1">自动最佳倍速 <span class="text-white/40">≤{{ autoRateCap }}x</span></span>
            <button :class="swClass(autoBestRate)" @click="autoBestRate = !autoBestRate; saveState()">
              <span :class="knobClass(autoBestRate)" />
            </button>
          </div>

          <div class="flex items-center gap-2" title="解锁 3.5x ~ 5x。要几倍码率的带宽，4x 以上多数浏览器会静音">
            <span class="flex-1">超快倍速 <span class="text-white/40">3.5~5x</span></span>
            <button :class="swClass(turboRate)" @click="turboRate = !turboRate; saveState()">
              <span :class="knobClass(turboRate)" />
            </button>
          </div>
        </div>

        <!-- 按剧记住那件事只留一行：不提一句的话「换部剧倍速自己变了」无从排查 -->
        <div
          v-if="showLabel"
          class="pt-2.5 border-t border-white/10 flex items-center gap-2 text-[11px] text-white/45"
          title="倍速、跳过片头、跳过片尾这几项按剧单独记"
        >
          <span class="min-w-0 flex-1 truncate">《{{ showLabel }}》{{ hasShowPrefs ? '已单独记住' : '未单独设置' }}</span>
          <button
            v-if="hasShowPrefs"
            class="shrink-0 hover:text-white underline decoration-dotted"
            @click="forgetShowPrefs"
          >恢复默认</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 画面内的右侧设置抽屉（版式参照安卓客户端的「播放设置」）。
 *
 * **做成抽屉而不是控制栏上的气泡菜单**：竖屏时播放器只有 200 多 px 高，
 * 而容器是 `overflow-hidden` —— 往上展开的菜单会被裁掉一半（原来那版就是）。
 * 抽屉占满画面高度、自己滚动，任何尺寸下都摆得开。
 */
import type { VideoFitMode } from '~/composables/videoPlayer/types'

const {
  showSettings, volume, brightness, fitMode, videoEl, isHls, mediaInfo,
  skipIntro, skipOutro, boostRatePref, hwDecode,
  autoFullscreen, autoBestRate, autoRateCap, turboRate, saveState,
  showLabel, hasShowPrefs, forgetShowPrefs,
  saveCurrentProgress, loadVideo,
} = useVideoPlayerCtx()

const FIT_MODES: { id: VideoFitMode; label: string }[] = [
  { id: 'default', label: '默认' },
  { id: 'cover', label: '填充' },
  { id: 'fill', label: '拉伸' },
  { id: '16-9', label: '16:9' },
  { id: '4-3', label: '4:3' },
]

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`

// 开关皮肤收成两个函数：十来个开关各写一遍 class 只会漂移
const swClass = (on: boolean) =>
  ['relative shrink-0 w-9 h-5 rounded-full transition-colors', on ? 'bg-rose-500' : 'bg-white/20']
const knobClass = (on: boolean) =>
  ['absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4' : '']

const onVolume = (e: Event) => {
  volume.value = Number((e.target as HTMLInputElement).value) / 100
  if (videoEl.value) {
    videoEl.value.volume = volume.value
    videoEl.value.muted = false
  }
  saveState()
}

const onBright = (e: Event) => { brightness.value = Number((e.target as HTMLInputElement).value) / 100 }

const pickFit = (id: VideoFitMode) => { fitMode.value = id; saveState() }

const stepBoost = (d: number) => {
  boostRatePref.value = Math.max(1.25, Math.min(4, Math.round((boostRatePref.value + d) * 100) / 100))
  saveState()
}

/**
 * 切换硬件解码要**重载视频**：档位偏好是 hls.js 的构造配置，实例建好之后改不了。
 * 先落一次进度，否则重载会退回上一次保存的位置。
 */
const toggleHw = () => {
  hwDecode.value = !hwDecode.value
  saveState()
  if (!isHls.value) return
  saveCurrentProgress()
  void loadVideo()
}

/**
 * 「现在到底是硬解还是软解」。`mediaCapabilities.decodingInfo` 的 `powerEfficient`
 * 是浏览器唯一肯说的一句，且它只是「这套参数能不能走硬解通路」，不是运行时实测——
 * 所以标签用「硬解/软解」而不敢写成结论性的百分比。
 */
const hwProbe = ref<'' | 'hw' | 'sw'>('')
const probeHw = async () => {
  const mc = (navigator as any).mediaCapabilities
  const codec = mediaInfo.value.videoCodec
  const v = videoEl.value
  if (!mc?.decodingInfo || !codec || !v?.videoWidth) { hwProbe.value = ''; return }
  const bps = Math.round(Number(mediaInfo.value.bitrateMbps) * 1e6)
  try {
    const info = await mc.decodingInfo({
      type: isHls.value ? 'media-source' : 'file',
      video: {
        contentType: `video/mp4; codecs="${codec}"`,
        width: v.videoWidth,
        height: v.videoHeight,
        bitrate: bps > 0 ? bps : 3_000_000,
        framerate: mediaInfo.value.fps || 25,
      },
    })
    hwProbe.value = info?.supported ? (info.powerEfficient ? 'hw' : 'sw') : ''
  } catch {
    hwProbe.value = ''
  }
}
// 只在抽屉打开时问一次：这是个异步查询，挂 computed 上会每次重渲染都发一发
watch(showSettings, open => { if (open) void probeHw() }, { immediate: true })
</script>

<style scoped>
.drawer-enter-active { transition: transform .26s cubic-bezier(.22, 1, .36, 1), opacity .2s ease; }
.drawer-leave-active { transition: transform .18s ease-in, opacity .18s ease; }
.drawer-enter-from,
.drawer-leave-to { transform: translateX(100%); opacity: 0; }

/* 滑条的圆钮：范围输入框的原生钮在深色浮层上几乎看不见 */
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 5px rgba(0, 0, 0, .5);
}
</style>
