<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        JSON 对比
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        对比两个 JSON 数据的差异，支持多层嵌套数组的字段匹配
      </p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          JSON A (原始)
        </label>
        <UTextarea
          v-model="inputA"
          :rows="10"
          placeholder="粘贴第一个 JSON..."
          class="font-mono text-sm"
          @input="debouncedAnalyze"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          JSON B (新值)
        </label>
        <UTextarea
          v-model="inputB"
          :rows="10"
          placeholder="粘贴第二个 JSON..."
          class="font-mono text-sm"
          @input="debouncedAnalyze"
        />
      </div>
    </div>

    <UCard class="mb-4">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="font-medium text-gray-900 dark:text-white">数组匹配配置</h3>
          <div class="flex gap-2">
            <UButton @click="compareJson" color="primary">
              <UIcon name="i-heroicons-scale" class="w-4 h-4 mr-1" />
              对比
            </UButton>
            <UButton @click="swapInputs" variant="outline">
              <UIcon name="i-heroicons-arrows-right-left" class="w-4 h-4 mr-1" />
              交换
            </UButton>
            <UButton @click="clearAll" variant="ghost" color="red">
              <UIcon name="i-heroicons-trash" class="w-4 h-4 mr-1" />
              清空
            </UButton>
            <UDropdown :items="historyMenuItems" :popper="{ placement: 'bottom-start' }" :ui="{ width: 'w-[640px]', container: 'w-[640px]' }">
              <UButton variant="outline" size="sm" :disabled="historyList.length === 0">
                <UIcon name="i-heroicons-clock" class="w-4 h-4 mr-1" />
                历史 ({{ historyList.length }})
              </UButton>
              <template #item="{ item }">
                <div class="w-[640px]">
                  <UTooltip v-if="item.preview" :text="item.preview" :popper="{ placement: 'right' }">
                    <span class="block truncate max-w-[640px]">{{ item.label }}</span>
                  </UTooltip>
                  <span v-else class="block truncate max-w-[640px]">{{ item.label }}</span>
                </div>
              </template>
            </UDropdown>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <p class="text-sm text-gray-500">
          为数组路径指定匹配字段，相同字段值的元素会进行对比（而非按索引对比）
        </p>

        <div v-if="arrayPaths.length > 0" class="space-y-3">
          <div 
            v-for="ap in arrayPaths" 
            :key="ap.path"
            class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
          >
            <div class="flex-1">
              <div class="font-mono text-sm text-gray-900 dark:text-white">{{ ap.path }}</div>
              <div class="text-xs text-gray-500 mt-1">
                共 {{ ap.countA }} / {{ ap.countB }} 项
                <span v-if="ap.suggestedKeys.length > 0" class="ml-2">
                  可用字段: {{ ap.suggestedKeys.slice(0, 5).join(', ') }}{{ ap.suggestedKeys.length > 5 ? '...' : '' }}
                </span>
              </div>
            </div>
            <div class="w-48">
              <USelectMenu
                v-model="ap.matchKey"
                :options="getKeyOptions(ap)"
                placeholder="选择匹配字段"
                size="sm"
                searchable
                clear-search-on-close
              />
            </div>
          </div>
        </div>

        <div v-else-if="inputA.trim() && inputB.trim()" class="text-sm text-gray-500 text-center py-4">
          未检测到数组结构，将按对象键名进行对比
        </div>

        <div v-else class="text-sm text-gray-500 text-center py-4">
          请输入 JSON 数据，将自动分析数组结构
        </div>
      </div>
    </UCard>

    <UAlert v-if="error" color="red" class="mb-4">
      <template #title>错误</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <div v-if="diffResult.length > 0">
      <div class="flex justify-between items-center mb-2">
        <div class="flex items-center gap-4">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
            对比结果
            <span class="text-gray-500 font-normal ml-2">({{ diffStats }})</span>
          </label>
          <div class="flex items-center gap-2">
            <span class="text-sm text-gray-500">排序:</span>
            <USelect v-model="sortOrder" :options="sortOptions" size="xs" class="w-36" />
          </div>
        </div>
        <UButton @click="copyDiff" variant="outline" size="sm">
          <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
          复制结果
        </UButton>
      </div>

      <div class="flex gap-2 mb-3">
        <UButton 
          v-for="filter in filterOptions" 
          :key="filter.value"
          size="xs"
          :variant="activeFilters.includes(filter.value) ? 'solid' : 'outline'"
          :color="filter.color"
          @click="toggleFilter(filter.value)"
        >
          {{ filter.label }} ({{ getCountByType(filter.value) }})
        </UButton>
      </div>
      
      <UCard>
        <div class="max-h-[500px] overflow-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
              <tr>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">路径</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300 w-20">类型</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">A 值</th>
                <th class="px-3 py-2 text-left font-medium text-gray-700 dark:text-gray-300">B 值</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr
                v-for="(diff, index) in sortedAndFilteredResult"
                :key="index"
                :class="getDiffRowClass(diff.type)"
              >
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[300px]">{{ diff.path }}</td>
                <td class="px-3 py-2">
                  <UBadge :color="getDiffBadgeColor(diff.type)" size="xs">
                    {{ getDiffTypeLabel(diff.type) }}
                  </UBadge>
                </td>
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[250px]">
                  <span :class="diff.type === 'removed' || diff.type === 'changed' ? 'text-red-600 dark:text-red-400' : ''">
                    {{ formatValue(diff.valueA) }}
                  </span>
                </td>
                <td class="px-3 py-2 font-mono text-xs break-all max-w-[250px]">
                  <span :class="diff.type === 'added' || diff.type === 'changed' ? 'text-green-600 dark:text-green-400' : ''">
                    {{ formatValue(diff.valueB) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </div>

    <UCard v-else-if="compared && diffResult.length === 0" class="text-center py-8">
      <UIcon name="i-heroicons-check-circle" class="w-12 h-12 text-green-500 mx-auto mb-2" />
      <p class="text-gray-600 dark:text-gray-300">两个 JSON 完全相同</p>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useJsonDiffPage } from '~/composables/useJsonDiffPage'

const {
  getKeyOptions, inputA, inputB, error, diffResult, compared, arrayPaths, sortOrder,
  activeFilters, sortOptions, filterOptions, historyList, historyMenuItems, debouncedAnalyze,
  compareJson, getCountByType, toggleFilter, sortedAndFilteredResult, diffStats,
  swapInputs, clearAll, getDiffRowClass, getDiffBadgeColor, getDiffTypeLabel,
  formatValue, copyDiff,
} = useJsonDiffPage()
</script>
