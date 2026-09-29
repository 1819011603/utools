<template>
  <!-- 突破 layout main 的 padding，横向占满视口；内层与顶栏同款 max-w-7xl + px，左右与导航内容对齐 -->
  <div class="json-format-bleed w-screen ml-[calc(50%-50vw)] max-w-[100vw] min-w-0 box-border">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <UAlert v-if="error" color="red" class="mb-3">
      <template #title>JSON 解析错误</template>
      <template #description>{{ error }}</template>
    </UAlert>

    <div class="grid gap-4 items-start grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <!-- 左栏：设置、操作（宽度与输入框对齐，不占用树形上方区域） -->
      <div class="min-w-0 flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <UCheckbox v-model="smartParseEnabled" label="智能解析" />
          <UCheckbox v-model="unwrapOuterBrackets" label="去外围括号" />
          <UCheckbox v-model="showTree" label="树形预览" />
          <UCheckbox v-model="editorHighlightEnabled" label="左侧语法高亮" />
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-gray-600 dark:text-gray-400">缩进:</span>
            <USelect v-model="indentSize" :options="indentOptions" size="xs" class="w-[4.5rem]" />
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5 text-xs">
          <UButton size="xs" @click="formatJson" color="primary" title="⌘/Ctrl+Shift+F">
            <UIcon name="i-heroicons-code-bracket" class="w-3.5 h-3.5 mr-0.5" />
            格式化
          </UButton>
          <UButton size="xs" @click="compressJson" variant="outline" title="⌘/Ctrl+Shift+M">
            <UIcon name="i-heroicons-arrows-pointing-in" class="w-3.5 h-3.5 mr-0.5" />
            压缩
          </UButton>
          <UButton size="xs" @click="jumpToJsonExtract" variant="outline" :disabled="!input.trim()" title="⌘/Ctrl+Shift+E">
            <UIcon name="i-heroicons-funnel" class="w-3.5 h-3.5 mr-0.5" />
            去JSON提取
          </UButton>
          <UButton size="xs" @click="copyAll" variant="outline" :disabled="!input.trim()" title="⌘/Ctrl+Shift+C">
            <UIcon name="i-heroicons-clipboard-document" class="w-3.5 h-3.5 mr-0.5" />
            复制
          </UButton>
          <UButton size="xs" @click="clearAll" variant="ghost" color="red" title="⌘/Ctrl+Shift+X">
            <UIcon name="i-heroicons-trash" class="w-3.5 h-3.5 mr-0.5" />
            清空
          </UButton>

          <UDropdown :items="historyMenuItems" :popper="{ placement: 'bottom-start' }" :ui="{ width: 'w-[min(640px,100vw-2rem)]', container: 'w-[min(640px,100vw-2rem)]' }">
            <UButton variant="outline" size="xs" :disabled="historyList.length === 0">
              <UIcon name="i-heroicons-clock" class="w-3.5 h-3.5 mr-0.5" />
              历史 ({{ historyList.length }})
            </UButton>
            <template #item="{ item }">
              <div class="max-w-[min(640px,85vw)]">
                <UTooltip v-if="item.preview" :text="item.preview" :popper="{ placement: 'right' }">
                  <span class="block truncate">{{ item.label }}</span>
                </UTooltip>
                <span v-else class="block truncate">{{ item.label }}</span>
              </div>
            </template>
          </UDropdown>
        </div>
        <p class="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
          编辑区聚焦时：⌘/Ctrl+Z 撤销 · ⌘/Ctrl+Shift+Z 或 Ctrl+Y 重做
        </p>

        <div class="flex justify-between items-center mb-1 min-h-[1.25rem] pt-0.5">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 leading-tight">
            JSON 内容
            <span v-if="stats" class="text-gray-500 font-normal ml-2">({{ stats }})</span>
          </label>
        </div>
        <div
          v-if="editorHighlightEnabled"
          class="json-editor-shell relative rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 h-[780px] overflow-hidden ring-offset-0 focus-within:ring-2 focus-within:ring-primary-500"
        >
          <pre
            ref="preRef"
            class="json-editor-layer font-mono text-xs absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-left leading-relaxed pointer-events-none tab-size-4"
            spellcheck="false"
            v-html="editorHighlightHtml"
          />
          <textarea
            ref="textareaRef"
            v-model="input"
            placeholder="粘贴或输入 JSON 数据..."
            spellcheck="false"
            class="json-editor-layer font-mono text-xs absolute inset-0 w-full h-full resize-none overflow-auto whitespace-pre-wrap break-all px-3 py-2 leading-relaxed bg-transparent text-transparent caret-gray-900 dark:caret-gray-100 selection:bg-primary-400/35 dark:selection:bg-primary-500/40 rounded-lg border-0 focus:outline-none z-[1] tab-size-4"
            @scroll="syncEditorScroll"
            @input="onEditorInput"
            @paste="onPaste"
          />
        </div>
        <textarea
          v-else
          ref="textareaRef"
          v-model="input"
          rows="34"
          placeholder="粘贴或输入 JSON 数据..."
          class="font-mono text-xs w-full h-[780px] rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y leading-relaxed whitespace-pre-wrap break-all"
          @input="onEditorInput"
          @paste="onPaste"
        />
      </div>

      <!-- 右侧：候选列表 / 树形预览（占满剩余宽度） -->
      <div class="min-w-0 self-start w-full">
        <!-- 候选 JSON 列表 -->
        <template v-if="candidateJsons.length > 0">
          <div class="flex items-center justify-between mb-1 min-h-[1.25rem]">
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">
              检测到 {{ candidateJsons.length }} 个 JSON，点击卡片选择：
            </span>
          </div>
          <div class="space-y-2 max-h-[860px] overflow-auto pr-1">
            <div
              v-for="(candidate, index) in candidateJsons"
              :key="index"
              class="border rounded-xl p-4 cursor-pointer hover:border-primary-400 dark:hover:border-primary-500 hover:shadow-md transition-all dark:border-gray-700 bg-white dark:bg-gray-900"
              @click="selectCandidateJson(candidate)"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <UBadge :color="candidate.type === 'array' ? 'blue' : 'green'" size="sm">
                    {{ candidate.type === 'array' ? '数组' : '对象' }}
                  </UBadge>
                  <span class="text-sm text-gray-600 dark:text-gray-400">{{ candidate.count }}</span>
                  <span v-if="candidate.source" class="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">{{ candidate.source }}</span>
                </div>
                <UButton size="xs" variant="ghost" @click.stop="copyCandidateJson(candidate)" title="复制">
                  <UIcon name="i-heroicons-clipboard-document" class="w-4 h-4" />
                  复制
                </UButton>
              </div>
              <pre class="text-xs font-mono bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all leading-relaxed" v-html="highlightJson(candidate.formatted)"></pre>
            </div>
          </div>
        </template>

        <!-- 树形预览 -->
        <template v-else-if="showTree && parsed">
          <div class="flex flex-wrap justify-between items-center gap-y-1 mb-1 min-h-[1.25rem]">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 leading-tight">
              树形预览
              <span v-if="currentMaxDepth > 0" class="text-gray-500 font-normal ml-2">
                (当前展开{{ currentMaxDepth >= maxDepth ? '全部' : `到第 ${currentMaxDepth} 层` }})
              </span>
            </label>
            <div class="flex flex-wrap gap-0.5 items-center">
              <div class="flex items-center gap-0.5 mr-1">
                <UButton @click="expandToLevel(currentExpandLevel - 1)" variant="ghost" size="xs" :disabled="currentExpandLevel <= 0">
                  <UIcon name="i-heroicons-minus" class="w-3.5 h-3.5" />
                </UButton>
                <span class="text-[11px] text-gray-600 dark:text-gray-400 min-w-[52px] text-center leading-none">
                  {{ currentExpandLevel === maxDepth ? '全部' : `${currentExpandLevel} 层` }}
                </span>
                <UButton @click="expandToLevel(currentExpandLevel + 1)" variant="ghost" size="xs" :disabled="currentExpandLevel >= maxDepth">
                  <UIcon name="i-heroicons-plus" class="w-3.5 h-3.5" />
                </UButton>
              </div>
              <UButton @click="expandAll" variant="ghost" size="xs" title="全部展开">
                <UIcon name="i-heroicons-arrows-pointing-out" class="w-3.5 h-3.5" />
              </UButton>
              <UButton @click="collapseAll" variant="ghost" size="xs" title="全部收起">
                <UIcon name="i-heroicons-arrows-pointing-in" class="w-3.5 h-3.5" />
              </UButton>
              <UButton @click="undoDelete" variant="ghost" size="xs" :disabled="deletedStack.length === 0" class="!px-1.5 text-[11px]">
                撤销删除
              </UButton>
              <UButton @click="restoreAllDeleted" variant="ghost" size="xs" :disabled="deletedPaths.size === 0" class="!px-1.5 text-[11px]">
                恢复全部
              </UButton>
            </div>
          </div>
          <div class="h-[780px] overflow-auto rounded-lg bg-white dark:bg-gray-900 ring-1 ring-gray-200 dark:ring-gray-800 shadow-sm p-2">
            <div class="font-mono text-xs json-tree">
              <JsonNode
                :data="parsed"
                :path="''"
                :depth="0"
                :expanded-paths="expandedPaths"
                :deleted-paths="deletedPaths"
                @toggle="togglePath"
                @copy="copyNode"
                @locate="locateInJson"
                @delete="deletePath"
              />
            </div>
          </div>
        </template>

        <!-- 空占位 -->
        <template v-else>
          <div class="h-[780px] flex flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100/80 dark:from-gray-900/40 dark:to-gray-800/20 border border-gray-200 dark:border-gray-700/50">
            <div class="text-center space-y-4 px-10">
              <div class="w-20 h-20 mx-auto rounded-2xl bg-white dark:bg-gray-800 shadow-sm flex items-center justify-center">
                <UIcon name="i-heroicons-code-bracket-square" class="w-10 h-10 text-gray-400 dark:text-gray-500" />
              </div>
              <div>
                <p class="text-gray-600 dark:text-gray-400 font-medium text-base mb-1">在左侧输入 JSON 数据</p>
                <p class="text-gray-400 dark:text-gray-600 text-sm">支持格式化、智能提取、树形预览</p>
              </div>
              <div class="flex flex-col gap-2 text-xs text-gray-400 dark:text-gray-600 bg-white/70 dark:bg-gray-800/40 rounded-xl p-4 text-left">
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  标准 JSON 格式化 &amp; 压缩
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  日志文本中自动提取 JSON 候选
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  识别字段中的转义 JSON（最多 3 层嵌套）
                </div>
                <div class="flex items-center gap-2">
                  <UIcon name="i-heroicons-check-circle" class="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  messages+time 日志结构自动解析
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useJsonFormatState } from '~/composables/useJsonFormatState'
import { useJsonFormatTree } from '~/composables/useJsonFormatTree'
import { useJsonFormatEditor } from '~/composables/useJsonFormatEditor'

const state = useJsonFormatState()
const tree = useJsonFormatTree(state)
const editor = useJsonFormatEditor(state, tree)

const {
  input, parsed, error, smartParseEnabled, unwrapOuterBrackets, showTree, editorHighlightEnabled,
  indentSize, indentOptions, historyList, editorHighlightHtml, preRef, textareaRef,
  currentExpandLevel, deletedStack, deletedPaths, expandedPaths, candidateJsons, jumpToJsonExtract,
} = state

const {
  stats, maxDepth, currentMaxDepth, copyAll, syncEditorScroll, expandToLevel, expandAll, collapseAll,
  undoDelete, restoreAllDeleted, togglePath, copyNode, locateInJson, deletePath,
} = tree

const {
  formatJson, compressJson, onEditorInput, onPaste, selectCandidateJson, copyCandidateJson,
  historyMenuItems, clearAll, highlightJson,
} = editor
</script>

<style>
.json-tree {
  line-height: 1.6;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 语法高亮颜色 */
.json-hl-key    { color: #2563eb; font-weight: 600; }
.json-hl-string { color: #059669; }
.json-hl-number { color: #d97706; }
.json-hl-boolean{ color: #7c3aed; }
.json-hl-null   { color: #6b7280; font-style: italic; }

.dark .json-hl-key    { color: #93c5fd; }
.dark .json-hl-string { color: #6ee7b7; }
.dark .json-hl-number { color: #fcd34d; }
.dark .json-hl-boolean{ color: #d8b4fe; }
.dark .json-hl-null   { color: #9ca3af; }
</style>
