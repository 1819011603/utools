<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <!-- 这两项管的是 JS 预取缓存的深度，不是 MSE。给 hls.js 的 MSE 上限被写死在 30/60s
           （见 useVideoEngine：append 几百 MB 会触发浏览器配额/驱逐），所以这里填 600 也不会让 MSE 窗口变深 -->
      <UFormGroup label="预加载时长" help="预取缓存提前下多少秒（JS 侧；MSE 窗口固定 ≤60s）。缓存越接近它，预取线程越少">
        <div class="flex items-center gap-2">
          <UInput v-model.number="hlsConfig.maxBufferLength" type="number" :min="10" :max="7200" class="flex-1" />
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
      <!-- 这条是「起播/拖进度/快卡了」三种场景共用的收敛线，见 useHlsPrefetch 的 SAFE_WALL_SECS。
           单位是「够播几秒」而不是「缓存几秒」——3x 倍速下缓存 15 秒才等于这里的 5 秒 -->
      <UFormGroup label="存货保险线" help="手上缓存够播的秒数低于此 → 预取线程收敛到 2~3，先保住眼前这一片（0=关闭）">
        <div class="flex items-center gap-2">
          <UInput v-model.number="hlsConfig.safeWallSecs" type="number" :min="0" :max="60" class="flex-1" />
          <span class="text-sm text-gray-500">秒</span>
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
        留空 = 用档位预设（灰字）；改动即覆盖当前档位。档位由引擎按实测自动分档，并按 host 记忆。
      </p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <!-- 阈值判的是「有效可播」(MSE + 预取缓存)，不是 MSE 前向：后者有天花板，深缓存时
             长期停在几十秒平台，按它分档会把稳态误判成吃紧（见 CLAUDE.md 那条踩坑） -->
        <UFormGroup label="濒卡阈值(秒)" help="有效可播低于此=濒卡→降速/跳片">
          <UInput v-model.number="tierOverrides.panicSecs" type="number" :min="2" :max="30" size="xs" :placeholder="String(tierDefaults.panicSecs)" />
        </UFormGroup>
        <UFormGroup label="吃紧阈值(秒)" help="有效可播低于此=吃紧→并发爬坡">
          <UInput v-model.number="tierOverrides.lowSecs" type="number" :min="5" :max="90" size="xs" :placeholder="String(tierDefaults.lowSecs)" />
        </UFormGroup>
        <UFormGroup label="安全系数" help="供给带宽相对消耗的冗余倍数（并发与最高流畅倍速都按它算）">
          <UInput v-model.number="tierOverrides.safety" type="number" :min="1" :max="3" :step="0.1" size="xs" :placeholder="String(tierDefaults.safety)" />
        </UFormGroup>
        <!-- 这里曾有「并发下限」(concurrencyFloor)，已随档位参数一起删除：起播那一刻缓存为 0，
             必然先被「存货不够就少开线程」压到 2 条，它想保证的事做不到；剩下的效果只是在缓存
             已经很足时把线程数硬抬上去（缓存 98/100 还跑 6 条）。慢源该开几条由实测算，不用预设猜。
             对冲延迟(hedgeMs)/竞速上限(maxRacers) 同样不开放覆盖：调它们只是在换「多快开始浪费连接」。 -->
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
