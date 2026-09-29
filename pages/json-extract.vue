<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        JSON 字段提取
      </h1>
      <p class="text-gray-600 dark:text-gray-300">
        使用 JQ 风格语法提取 JSON 字段，支持排序、去重等操作
      </p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            输入 JSON
          </label>
          <UTextarea
            v-model="input"
            :rows="12"
            placeholder="粘贴 JSON 数据..."
            class="font-mono text-sm"
            @input="debouncedExtract"
          />
        </div>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="font-medium text-gray-900 dark:text-white">字段路径</h3>
              <UButton @click="showHelp = true" variant="ghost" size="xs">
                <UIcon name="i-heroicons-question-mark-circle" class="w-4 h-4 mr-1" />
                语法帮助
              </UButton>
            </div>
          </template>

          <div class="space-y-3">
            <UInput
              v-model="fieldPath"
              placeholder="如: .data[].id 或 .users[].name"
              class="font-mono"
              @input="debouncedExtract"
            />

            <div v-if="suggestedPaths.length > 0">
              <div class="text-xs text-gray-500 mb-2">推荐路径:</div>
              <div class="flex flex-wrap gap-1">
                <UBadge
                  v-for="path in suggestedPaths"
                  :key="path"
                  color="gray"
                  variant="soft"
                  class="cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700"
                  @click="usePath(path)"
                >
                  {{ path }}
                </UBadge>
              </div>
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3 class="font-medium text-gray-900 dark:text-white">处理选项</h3>
          </template>
          
          <div class="space-y-3">
            <div class="flex flex-wrap gap-4">
              <UCheckbox v-model="options.unique" label="去重" @change="autoExtract" />
              <UCheckbox v-model="options.sort" label="排序" @change="autoExtract" />
              <UCheckbox v-model="options.reverse" label="倒序" @change="autoExtract" />
              <UCheckbox v-model="options.compact" label="过滤空值" @change="autoExtract" />
            </div>

            <div class="flex gap-2 items-center">
              <span class="text-sm text-gray-600 dark:text-gray-400">输出格式:</span>
              <URadioGroup v-model="outputFormat" :options="formatOptions" @change="() => { autoExtract(); saveSettings() }" />
            </div>

            <div class="flex gap-2">
              <UButton @click="extract" color="primary">
                <UIcon name="i-heroicons-funnel" class="w-4 h-4 mr-1" />
                提取
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
        </UCard>
      </div>

      <div class="space-y-4">
        <UAlert v-if="error" color="red">
          <template #title>错误</template>
          <template #description>{{ error }}</template>
        </UAlert>

        <div>
          <div class="flex justify-between items-center mb-2">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
              提取结果
              <span v-if="resultCount >= 0" class="text-gray-500 font-normal ml-2">
                ({{ resultCount }} 项)
              </span>
            </label>
            <UButton @click="copyResult" variant="outline" size="sm" :disabled="!output">
              <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4 mr-1" />
              复制
            </UButton>
          </div>
          <UTextarea
            v-model="output"
            :rows="20"
            readonly
            placeholder="提取结果..."
            class="font-mono text-sm"
          />
        </div>
      </div>
    </div>

    <UModal v-model="showHelp">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg">JQ 语法参考</h3>
            <UButton @click="showHelp = false" variant="ghost" icon="i-heroicons-x-mark" />
          </div>
        </template>

        <div class="space-y-4 text-sm">
          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">基本语法</h4>
            <table class="w-full">
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="example in syntaxExamples" :key="example.syntax">
                  <td class="py-2 font-mono text-primary-600 dark:text-primary-400">{{ example.syntax }}</td>
                  <td class="py-2 pl-4 text-gray-600 dark:text-gray-300">{{ example.desc }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">示例数据</h4>
            <pre class="bg-gray-100 dark:bg-gray-800 p-3 rounded text-xs overflow-auto">{{ exampleJson }}</pre>
          </div>

          <div>
            <h4 class="font-medium text-gray-900 dark:text-white mb-2">提取示例</h4>
            <table class="w-full">
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr v-for="ex in extractExamples" :key="ex.path">
                  <td class="py-2 font-mono text-primary-600 dark:text-primary-400">{{ ex.path }}</td>
                  <td class="py-2 pl-4 font-mono text-gray-600 dark:text-gray-300">{{ ex.result }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <UButton @click="loadExample" block variant="soft">
            加载示例数据
          </UButton>
        </div>
      </UCard>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { useJsonExtractPage } from '~/composables/useJsonExtractPage'

const {
  input, fieldPath, output, error, showHelp, resultCount, options, outputFormat, formatOptions,
  suggestedPaths, syntaxExamples, exampleJson, extractExamples, historyList, historyMenuItems,
  debouncedExtract, extract, usePath, autoExtract, loadExample, copyResult, clearAll, saveSettings,
} = useJsonExtractPage()
</script>
