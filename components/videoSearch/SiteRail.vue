<template>
  <div>
    <!--
      一行小标题 + 折叠钮。没有小标题的话，左边那一列看着像一段说明文字，而不是「这里要选一个」。
      折叠钮只在 md+ 出现：窄屏这一列本来就是横排滚动条，没有「宽度」可省
    -->
    <div class="hidden md:flex items-center gap-1 pb-2 transition-all duration-300" :class="collapsed ? 'justify-center' : 'px-1'">
      <span
        class="flex-1 text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500
               overflow-hidden whitespace-nowrap transition-all duration-300"
        :class="collapsed ? 'opacity-0 w-0 flex-none' : 'opacity-100'"
      >站点</span>
      <button
        type="button"
        :title="collapsed ? '钉住展开' : '收起站点列表'"
        :aria-label="collapsed ? '展开站点列表' : '收起站点列表'"
        class="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer
               text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-white/10
               transition-colors duration-200"
        @click="$emit('toggle')"
      >
        <UIcon
          name="i-heroicons-chevron-left-20-solid"
          class="w-4 h-4 transition-transform duration-500 ease-out"
          :class="collapsed ? 'rotate-180' : ''"
        />
      </button>
    </div>

    <!--
      站点列表放**左侧竖排**而不是顶部横排 tab：五个站名加上条数横着摆一行会被挤成省略号，
      竖排一屏就能全看见，加站也不会撑爆。
      窄屏退回横向滚动条：那时纵向空间比横向金贵，竖排会把结果顶到屏幕外。
      **所有折叠相关的类都带 md: 前缀**：窄屏没有折叠这回事，漏一个前缀就是「手机上站名全没了」
    -->
    <div class="flex md:flex-col gap-1.5 overflow-x-auto md:overflow-visible pb-2 md:pb-0 -mx-1 px-1 md:mx-0 md:px-0">
      <!--
        **md 上格子高度写死，两种状态必须一样高**（`md:h-12` + `md:py-0`）：
        折叠态是「缩写 + 数字」两行、展开态是一行，靠内容撑高的话整列会矮七十多像素。
        而 hover 展开正是靠外层的 mouseenter/mouseleave 驱动的 —— 列表一变矮，
        光标底下那一格就跑到列表外面去了 → mouseleave → 收起 → 又长回来 → mouseenter，
        表现是**鼠标停在最下面那几格上一直闪个不停**（越靠底部越明显，上面几格因为位移小不会触发）。
        高度锁死之后展开只往右撑宽，纵向不再位移，这个环就断了
      -->
      <button
        v-for="(s, i) in states"
        :key="s.siteId"
        type="button"
        :aria-pressed="s.siteId === modelValue"
        class="wf-fade-up group relative shrink-0 md:w-full flex items-center gap-2.5 rounded-xl
               py-2.5 md:py-0 md:h-12 text-sm text-left cursor-pointer select-none
               transition-all duration-300 hover:-translate-y-px active:translate-y-0 active:scale-[0.985]
               focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        :class="[
          collapsed ? 'pl-3.5 pr-2.5 md:px-0 md:flex-col md:gap-0.5 md:justify-center' : 'pl-3.5 pr-2.5',
          s.siteId === modelValue
            ? 'bg-gradient-to-r from-rose-500/[0.14] via-pink-500/[0.09] to-violet-500/[0.07] text-rose-600 dark:text-rose-300 font-medium ring-1 ring-inset ring-rose-300/70 dark:ring-rose-400/25 shadow-sm shadow-rose-100/70 dark:shadow-none'
            : 'bg-white/60 dark:bg-white/[0.03] text-gray-600 dark:text-gray-300 ring-1 ring-inset ring-gray-200/70 dark:ring-white/[0.07] hover:bg-white hover:text-rose-600 dark:hover:text-rose-300 hover:ring-rose-200 dark:hover:bg-white/[0.07] dark:hover:ring-rose-400/20 hover:shadow-sm',
        ]"
        :style="{ animationDelay: i * 40 + 'ms' }"
        @click="$emit('update:modelValue', s.siteId)"
      >
        <!-- 选中态的那根竖条：光靠底色变化太轻，扫一眼看不出选的是谁；一根渐变小竖条最省地方。
             未选中时不是直接隐藏而是 h-0 → hover 时探出一小截，给「这一格能选」一个预告 -->
        <span
          class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full
                 bg-gradient-to-b from-rose-400 to-violet-400 transition-all duration-300"
          :class="s.siteId === modelValue ? 'h-5 opacity-100' : 'h-0 opacity-0 group-hover:h-3 group-hover:opacity-60'"
        />

        <!-- 折叠后只剩缩写。宽度和透明度一起过渡，字是「被挤没的」而不是「啪一下消失」 -->
        <span
          class="flex-1 truncate transition-all duration-300"
          :class="collapsed ? 'md:opacity-0 md:w-0 md:flex-none' : 'opacity-100'"
        >{{ s.name }}</span>
        <!-- 取**两个字**不是一个：站名首字重合的不少（网飞猫/奈飞工厂都能缩成一个字），
             而「4k影视」缩成「4」根本读不出是哪家。两个 CJK 字在 3.5rem 的列里绰绰有余 -->
        <span
          v-if="collapsed"
          class="hidden md:block wf-fade-in text-[13px] font-semibold leading-none"
        >{{ s.name.slice(0, 2) }}</span>

        <!-- 状态角标：搜索中/出错/只能去源站 三种各有形，剩下的一律显示条数。
             折叠后排到缩写**下面**（flex-col），不做成浮在角上的小圆点：
             那样它会压住相邻格子的圆角，看着像掉出来的 -->
        <span class="flex items-center transition-all duration-300">
          <UIcon v-if="s.status === 'searching'" name="i-heroicons-arrow-path" class="w-3.5 h-3.5 shrink-0 animate-spin text-rose-400" />
          <UIcon v-else-if="s.status === 'error'" name="i-heroicons-exclamation-triangle" class="w-3.5 h-3.5 shrink-0 text-red-500" />
          <UIcon v-else-if="s.status === 'blocked' || s.status === 'manual'" name="i-heroicons-shield-exclamation" class="w-3.5 h-3.5 shrink-0 text-amber-500" />
          <span
            v-else-if="s.items.length"
            class="shrink-0 min-w-[1.375rem] px-1.5 py-0.5 rounded-md text-[11px] font-semibold tabular-nums text-center transition-colors"
            :class="[
              s.siteId === modelValue
                ? 'bg-rose-500 text-white shadow-sm shadow-rose-300/50'
                : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-300 group-hover:bg-rose-100 group-hover:text-rose-600 dark:group-hover:bg-rose-400/15 dark:group-hover:text-rose-300',
              // 折叠态下角标退成一行纯数字：底色和文字色都交还给按钮本身（md: 变体一定排在基础类之后，
              // 所以能盖掉选中态那句 bg-rose-500/text-white，不必写 !important）
              collapsed ? 'md:min-w-0 md:px-1 md:py-0 md:text-[10px] md:bg-transparent md:dark:bg-transparent md:shadow-none md:text-current' : '',
            ]"
          >{{ s.items.length }}</span>
          <span
            v-else-if="s.status === 'done'"
            class="shrink-0 min-w-[1.375rem] px-1.5 py-0.5 rounded-md text-[11px] text-center text-gray-400 dark:text-gray-500 bg-gray-100/70 dark:bg-white/5"
            :class="collapsed ? 'md:hidden' : ''"
          >0</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SiteSearchState } from '~/composables/useVideoSearch'

defineProps<{ states: SiteSearchState[]; modelValue: string; collapsed?: boolean }>()
defineEmits<{ 'update:modelValue': [string]; toggle: [] }>()
</script>
