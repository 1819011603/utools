<template>
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
      <UFormGroup label="视频地址" help="支持多个链接，每行一个，自动按顺序播放">
        <UTextarea
          v-model="videoUrlInput"
          placeholder="输入 m3u8 或 mp4 视频地址...&#10;支持多个链接，每行一个"
          :rows="3"
          @keydown.ctrl.enter="parseAndLoad"
        />
      </UFormGroup>

      <div class="flex gap-2 flex-wrap">
        <UButton color="primary" :disabled="!videoUrlInput.trim()" :loading="isLoading" @click="parseAndLoad">
          <UIcon name="i-heroicons-play" class="w-4 h-4 mr-1" />
          解析并播放
        </UButton>
        <UCheckbox v-model="autoFullscreen" label="加载后自动全屏" />
        <UCheckbox
          v-model="autoBestRate"
          :label="`自动最佳倍速（1x ~ ${autoRateCap}x，流畅就提速，卡了就降回）`"
          @change="saveState"
        />
      </div>

      <!-- 连接策略：起播前实测探测「清单 / 分片」两轴各自能走哪条通道，可展开手动覆盖 -->
      <div class="flex gap-2 flex-wrap items-center text-sm">
        <UBadge :color="manualStrategyOverride ? 'amber' : (isProbing ? 'gray' : 'sky')" variant="soft" size="xs">
          连接策略：{{ strategyLabel }}
        </UBadge>
        <span class="text-xs text-gray-400">
          {{ manualStrategyOverride
            ? '你已手动调整，改任一项即生效；点“恢复自动”交回引擎'
            : '清单与分片各自实测直连/代理是否可达，改任一项即转手动' }}
        </span>
        <button v-if="manualStrategyOverride" class="text-xs text-violet-500 hover:text-violet-700" @click="resetToAuto">
          恢复自动
        </button>
        <button class="text-xs text-violet-500 hover:text-violet-700" @click="showAdvancedProxy = !showAdvancedProxy">
          {{ showAdvancedProxy ? '收起' : '展开设置…' }}
        </button>
      </div>

      <!-- 连接设置：自动时反映引擎当前选择；改任一项即转手动 -->
      <div v-if="showAdvancedProxy" class="flex gap-4 flex-wrap items-end p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
        <UFormGroup label="Origin" help="注入请求头 Origin，用于绕过防盗链（可下拉选历史）">
          <UInput
            v-model="requestOrigin"
            list="vp-origin-history"
            placeholder="https://example.com"
            class="w-52"
            @change="onManualProxyChange"
          />
        </UFormGroup>
        <UFormGroup label="Referer" :help="refererHelp">
          <UInput
            v-model="requestReferer"
            list="vp-referer-history"
            :placeholder="effectiveReferer || 'https://example.com/'"
            class="w-64"
            @change="onManualProxyChange"
          />
        </UFormGroup>
        <datalist id="vp-origin-history">
          <option v-for="o in originSuggestions" :key="o" :value="o" />
        </datalist>
        <datalist id="vp-referer-history">
          <option v-for="r in refererSuggestions" :key="r" :value="r" />
        </datalist>
        <UFormGroup label=" " class="pt-1">
          <UCheckbox
            v-model="manifestOnly"
            label="仅代理 Manifest"
            :disabled="manifestOnlyDisabled"
            :title="manifestOnlyDisabled
              ? '需先启用代理（伪装下载器或注入 Origin/Referer），否则代理不介入，此项无效'
              : '代理 manifest 补 CORS/绕防盗链，分片仍直连 CDN（更快、省服务器流量）'"
            @change="onManualProxyChange"
          />
        </UFormGroup>
        <UFormGroup label=" " class="pt-1">
          <UCheckbox
            v-model="dualChannel"
            label="直连+代理双通道"
            :disabled="dualChannelUnavailable"
            :title="dualChannelHint"
            @change="saveState"
          />
        </UFormGroup>

        <!-- 可达性探测矩阵：排查源站为什么走这条路（✓ 通 / ✗ 不通 / ? 超时未判定） -->
        <div v-if="probeRows.length" class="w-full pt-2 border-t border-gray-200 dark:border-gray-700">
          <div class="flex items-center gap-2 mb-1.5">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400">可达性探测</span>
            <button class="text-xs text-violet-500 hover:text-violet-700" :disabled="isProbing" @click="reprobeNow">
              {{ isProbing ? '探测中…' : '重新探测' }}
            </button>
          </div>
          <div class="space-y-1">
            <div v-for="row in probeRows" :key="row.name" class="flex items-center gap-2 text-xs">
              <span class="w-8 text-gray-500 dark:text-gray-400">{{ row.name }}</span>
              <span
                v-for="cell in row.cells"
                :key="cell.channel"
                class="px-1.5 py-0.5 rounded font-mono"
                :class="{
                  'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300': cell.reach === 'ok',
                  'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300': cell.reach === 'fail',
                  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': cell.reach === 'unknown',
                  'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500': cell.reach === 'skip',
                }"
                :title="cell.reach === 'unknown' ? '超时，未判定'
                  : (cell.reach === 'skip' ? '未探测：已有更优通道可用' : '')"
              >
                {{ cell.reach === 'ok' ? '✓' : cell.reach === 'fail' ? '✗' : cell.reach === 'unknown' ? '?' : '–' }}
                {{ cell.label }}
                <span v-if="cell.ms" class="opacity-60">{{ cell.ms }}ms</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 片头片尾跳过设置 -->
      <div class="flex gap-4 flex-wrap items-end">
        <UFormGroup label="跳过片头" help="视频开始时自动跳过的时间">
          <div class="flex items-center gap-2">
            <UInput v-model.number="skipIntro" type="number" :min="0" :max="300" :step="5" class="w-24" @change="saveState" />
            <span class="text-sm text-gray-500">秒</span>
          </div>
        </UFormGroup>
        <UFormGroup label="跳过片尾" help="剩余时间少于此值时自动下一集">
          <div class="flex items-center gap-2">
            <UInput v-model.number="skipOutro" type="number" :min="0" :max="300" :step="5" class="w-24" @change="saveState" />
            <span class="text-sm text-gray-500">秒</span>
          </div>
        </UFormGroup>
      </div>

      <VideoPlayerPlaylistPanel v-if="playlist.length > 1" />

      <div class="flex justify-end">
        <UButton size="xs" variant="soft" :color="deepLinkCopied ? 'green' : 'gray'" @click="copyDeepLink">
          <UIcon :name="deepLinkCopied ? 'i-heroicons-check' : 'i-heroicons-link'" class="w-4 h-4 mr-1" />
          {{ deepLinkCopied ? '已复制' : '复制当前直链' }}
        </UButton>
      </div>

      <div class="flex flex-wrap gap-2">
        <span class="text-sm text-gray-500">示例：</span>
        <UButton v-for="example in EXAMPLE_URLS" :key="example.url" size="xs" variant="soft" @click="loadExample(example.url)">
          {{ example.name }}
        </UButton>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
// 解构出来当顶层 setup 绑定：模板里自动解包 ref，v-model 也能直接写
const {
  videoUrlInput, isLoading, autoFullscreen, autoBestRate, autoRateCap, showAdvancedProxy,
  requestOrigin, requestReferer, manifestOnly, dualChannel, skipIntro, skipOutro,
  manualStrategyOverride, isProbing, strategyLabel, probeRows,
  manifestOnlyDisabled, dualChannelUnavailable, dualChannelHint,
  refererHelp, effectiveReferer, originSuggestions, refererSuggestions,
  playlist, currentIndex,
  parseAndLoad, loadExample, saveState, onManualProxyChange, resetToAuto, reprobeNow,
  copyDeepLink, deepLinkCopied,
} = useVideoPlayerCtx()

// 只有这一处用到，就近放着
const EXAMPLE_URLS = [
  { name: 'Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Sintel (HLS)', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { name: 'Tears of Steel (MP4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
]
</script>
