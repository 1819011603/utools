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

      <!-- 连接策略：起播前实测「清单 / 分片」两轴各自能走哪条通道。没有手动模式，一律自动 -->
      <div class="flex gap-2 flex-wrap items-center text-sm">
        <UBadge :color="isProbing ? 'gray' : 'sky'" variant="soft" size="xs">
          连接策略：{{ strategyLabel }}
        </UBadge>
        <span class="text-xs text-gray-400">
          清单与分片各自实测直连/代理是否可达，自动选最优；填 Origin 只是多给它一个候选
        </span>
        <button class="text-xs text-violet-500 hover:text-violet-700" @click="showAdvancedProxy = !showAdvancedProxy">
          {{ showAdvancedProxy ? '收起' : '展开设置…' }}
        </button>
      </div>

      <!-- 连接设置：Origin/Referer 是喂给探测的候选值；其余项只读反映引擎当前选择 -->
      <div v-if="showAdvancedProxy" class="flex gap-4 flex-wrap items-end p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
        <UFormGroup label="Origin">
          <UInput
            v-model="originHint"
            list="vp-origin-history"
            placeholder="https://example.com"
            class="w-52"
            @change="onHeaderHintChange"
          />
          <template #help>
            <span class="flex items-center gap-1">
              <span>防盗链候选值，探测会拿它去试（可下拉选历史）</span>
              <UBadge v-if="hintStatus === 'adopted'" color="green" variant="subtle" size="xs">已采用</UBadge>
              <UBadge
                v-else-if="hintStatus === 'unused'" color="gray" variant="subtle" size="xs"
                title="实测有更省的通道可达（直连/代理·伪装），不需要注入这对头"
              >
                未采用
              </UBadge>
            </span>
          </template>
        </UFormGroup>
        <UFormGroup label="Referer" :help="refererHintHelp">
          <UInput
            v-model="refererHint"
            list="vp-referer-history"
            placeholder="https://example.com/"
            class="w-64"
            @change="onHeaderHintChange"
          />
        </UFormGroup>
        <datalist id="vp-origin-history">
          <option v-for="o in originSuggestions" :key="o" :value="o" />
        </datalist>
        <datalist id="vp-referer-history">
          <option v-for="r in refererSuggestions" :key="r" :value="r" />
        </datalist>
        <!-- 这两项由引擎算出，只作状态显示。做成可点的复选框会让人以为能覆盖，
             实际下一次加载又会被探测结论写回去，白白制造「改了没用」的困惑 -->
        <UFormGroup label=" " class="pt-1">
          <div class="flex items-center gap-1.5 text-sm">
            <UIcon
              :name="manifestOnly ? 'i-heroicons-check-circle-solid' : 'i-heroicons-minus-circle'"
              class="w-4 h-4" :class="manifestOnly ? 'text-green-500' : 'text-gray-400'"
            />
            <span :class="manifestOnly ? '' : 'text-gray-400'" title="代理 manifest 补 CORS/绕防盗链，分片仍直连 CDN（更快、省服务器流量）">
              代理 Manifest
            </span>
          </div>
        </UFormGroup>
        <UFormGroup label=" " class="pt-1">
          <div class="flex items-center gap-1.5 text-sm">
            <UIcon
              :name="dualChannel ? 'i-heroicons-check-circle-solid' : 'i-heroicons-minus-circle'"
              class="w-4 h-4" :class="dualChannel ? 'text-green-500' : 'text-gray-400'"
            />
            <span :class="dualChannel ? '' : 'text-gray-400'" :title="dualChannelHint">直连+代理双通道</span>
            <!-- 开着但某条 lane 被真实请求证伪 → 明说已降为单通道，否则用户只会看到满屏 403 -->
            <UBadge
              v-if="dualChannel && deadLaneLabel"
              color="amber" variant="subtle" size="xs"
              :title="`${deadLaneLabel}通道连续请求失败（多为 403/CORS），已自动停用，当前只跑另一条`"
            >
              {{ deadLaneLabel }}不通·已降单通道
            </UBadge>
          </div>
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
  manifestOnly, dualChannel, skipIntro, skipOutro,
  originHint, refererHint, hintStatus, refererHintHelp, onHeaderHintChange,
  isProbing, strategyLabel, probeRows,
  dualChannelHint, deadLaneLabel,
  originSuggestions, refererSuggestions,
  playlist, currentIndex,
  parseAndLoad, loadExample, saveState, reprobeNow,
  copyDeepLink, deepLinkCopied,
} = useVideoPlayerCtx()

// 只有这一处用到，就近放着
const EXAMPLE_URLS = [
  { name: 'Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Sintel (HLS)', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  { name: 'Tears of Steel (MP4)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
]
</script>
