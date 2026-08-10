<template>
  <div class="space-y-3">
    <p class="text-xs text-gray-500 dark:text-gray-400">
      清单与分片各自实测直连/代理是否可达，自动选最优；没有手动模式。
      填 Origin/Referer 只是多给探测一个候选值，试不通照样降级。
    </p>

    <!-- 连接设置：Origin/Referer 是喂给探测的候选值；其余项只读反映引擎当前选择 -->
    <div class="flex gap-4 flex-wrap items-end p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
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
        <ProbeMatrix :rows="probeRows" :total-ms="probeResult?.totalMs" />
        <!-- 已实测证伪（如分片四条通道全 403）时把原因摆在矩阵下面：矩阵是给会看的人的，
             这一句是给不想数格子的人的。起播时的 toast 会消失，这里常驻 -->
        <p v-if="probeVerdict.severity === 'fatal'" class="mt-1.5 text-xs text-red-500">
          {{ probeVerdict.title }}——{{ probeVerdict.detail }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 连接策略与防盗链设置。原先摊在「视频源」卡片正中间，
 * 但它是排查问题才看的东西，日常只需要播放器标题栏那个策略徽标，所以整块挪进页面下方的折叠区。
 */
const {
  manifestOnly, dualChannel,
  originHint, refererHint, hintStatus, refererHintHelp, onHeaderHintChange,
  isProbing, probeRows, probeResult, probeVerdict, dualChannelHint, deadLaneLabel,
  originSuggestions, refererSuggestions, reprobeNow,
} = useVideoPlayerCtx()
</script>
