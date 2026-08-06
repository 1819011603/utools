<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-heroicons-cog-6-tooth" class="w-5 h-5 text-gray-500" />
        <span class="font-semibold">HLS 配置</span>
      </div>
    </template>

    <div class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <UFormGroup label="预加载时长" help="提前缓冲多少秒视频">
          <div class="flex items-center gap-2">
            <UInput v-model.number="hlsConfig.maxBufferLength" type="number" :min="10" :max="120" class="flex-1" />
            <span class="text-sm text-gray-500">秒</span>
          </div>
        </UFormGroup>
        <UFormGroup label="最大缓冲时长" help="缓冲区最大存储时长">
          <div class="flex items-center gap-2">
            <UInput v-model.number="hlsConfig.maxMaxBufferLength" type="number" :min="30" :max="300" class="flex-1" />
            <span class="text-sm text-gray-500">秒</span>
          </div>
        </UFormGroup>
        <UFormGroup label="缓冲内存" help="预取缓存内存上限（JS 侧，非 MSE）">
          <div class="flex items-center gap-2">
            <UInput v-model.number="hlsConfig.maxBufferSizeMB" type="number" :min="30" :max="8000" class="flex-1" />
            <span class="text-sm text-gray-500">MB</span>
          </div>
        </UFormGroup>
      </div>

      <!-- 抗卡策略（服务器档位参数）：留空=用当前档位预设（灰字占位） -->
      <div class="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium">抗卡策略</span>
          <UBadge :color="tierBadgeColor" variant="subtle" size="xs">
            当前档位：{{ tierLabel }}{{ tierIsAuto ? '（自动）' : '（锁定）' }}
          </UBadge>
          <UButton v-if="hasTierOverride" size="2xs" variant="ghost" color="gray" @click="clearTierOverrides">
            清除覆盖 · 跟随档位
          </UButton>
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          留空 = 用档位预设（灰字）；改动即覆盖当前档位。档位在「站点规则」里可手动锁定「好/中/差」或让引擎自动分档。
        </p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <UFormGroup label="濒卡阈值(秒)" help="MSE 前向低于此=濒卡→降速/跳片">
            <UInput v-model.number="tierOverrides.panicSecs" type="number" :min="2" :max="30" size="xs" :placeholder="String(tierDefaults.panicSecs)" />
          </UFormGroup>
          <UFormGroup label="吃紧阈值(秒)" help="MSE 前向低于此=吃紧→并发爬坡">
            <UInput v-model.number="tierOverrides.lowSecs" type="number" :min="5" :max="90" size="xs" :placeholder="String(tierDefaults.lowSecs)" />
          </UFormGroup>
          <UFormGroup label="安全系数" help="供给带宽相对消耗的冗余倍数">
            <UInput v-model.number="tierOverrides.safety" type="number" :min="1" :max="3" :step="0.1" size="xs" :placeholder="String(tierDefaults.safety)" />
          </UFormGroup>
          <UFormGroup label="并发下限" help="起播即保证的最小并行连接数">
            <UInput v-model.number="tierOverrides.concurrencyFloor" type="number" :min="1" :max="6" size="xs" :placeholder="String(tierDefaults.concurrencyFloor)" />
          </UFormGroup>
          <!-- 对冲延迟(hedgeMs)/竞速上限(maxRacers) 不开放覆盖：调它们只是在换「多快开始浪费连接」，
               实际抗卡效果由档位预设 + 并发爬坡决定，逐项手调帮不上忙，反倒占满这一屏。 -->
          <UFormGroup label="跳片超时(ms)" help="关键分片超此→跳过（先降速后才跳）">
            <UInput v-model.number="tierOverrides.skipMs" type="number" :min="5000" :max="60000" :step="1000" size="xs" :placeholder="String(tierDefaults.skipMs)" />
          </UFormGroup>
        </div>
      </div>

      <div class="flex flex-wrap gap-x-8 gap-y-3">
        <div class="space-y-1">
          <UCheckbox v-model="hlsConfig.enableWorker" label="启用 Web Worker" />
          <p class="text-xs text-gray-500 dark:text-gray-400 pl-6">分片解析放到后台线程，播放更流畅、界面不卡顿（建议开启）</p>
        </div>
        <div class="space-y-1">
          <UCheckbox v-model="hlsConfig.lowLatencyMode" label="低延迟模式（直播）" />
          <p class="text-xs text-gray-500 dark:text-gray-400 pl-6">仅对 LL-HLS 直播源有效，压低直播延迟；点播请保持关闭</p>
        </div>
      </div>

      <VideoPlayerStatsPanel v-if="hlsStats" />

      <div class="flex gap-2">
        <UButton color="primary" variant="soft" @click="applyAndSave">
          <UIcon name="i-heroicons-check" class="w-4 h-4 mr-1" />
          应用配置
        </UButton>
        <UButton variant="ghost" @click="resetAndSave">
          <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 mr-1" />
          重置默认
        </UButton>
      </div>
    </div>
  </UCard>
</template>

<script setup lang="ts">
const {
  hlsConfig, hlsStats,
  tierLabel, tierBadgeColor, tierIsAuto, tierDefaults, tierOverrides, hasTierOverride, clearTierOverrides,
  applyHlsConfig, resetHlsConfig, saveState,
} = useVideoPlayerCtx()

// 引擎只管重载/回默认值，持久化留在装配层，所以这里各补一次 saveState
const applyAndSave = async () => {
  await applyHlsConfig()
  saveState()
}
const resetAndSave = () => {
  resetHlsConfig()
  saveState()
}
</script>
