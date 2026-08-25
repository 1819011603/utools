<script setup lang="ts">
/**
 * header 右侧那枚账号按钮。未登录 = 一个「登录」按钮；已登录 = 用户名首字 + 下拉菜单。
 *
 * 时间**显示绝对值不显示「几分钟前」**：相对时间要么挂个定时器每分钟重算，
 * 要么就会停在「刚刚」不动（比不显示更让人误解「同步是不是卡住了」）。
 * 一个定时器换一行文案不值得。
 *
 * 「立即同步」绕过 5 分钟节流：那是用户明确的动作，而他点它往往正是因为想把
 * 另一台设备的改动拉过来 —— 这时候回一句「请 4 分钟后再试」毫无道理。
 */
const { isLoggedIn, user, authOpen, logout } = useUserAuth()
const { syncing, lastOkAt, syncError, pendingChanges, storeKind, syncNow } = useCloudSync()
const toast = useToast()

const pad = (n: number) => String(n).padStart(2, '0')

const timeText = computed(() => {
  if (!lastOkAt.value) return '还没同步过'
  const d = new Date(lastOkAt.value)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? `上次同步 ${hm}` : `上次同步 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
})

const stateText = computed(() => {
  if (syncing.value) return '正在同步…'
  if (syncError.value) return syncError.value
  if (pendingChanges.value) return '有改动待上传（最快 5 分钟一次）'
  return timeText.value
})

const doSync = async () => {
  // 后台那一轮正在跑时点它会被引擎挡掉（返回 false），照 false 弹「同步失败」是误报
  if (syncing.value) return
  const ok = await syncNow({ force: true })
  toast.add(ok
    ? { title: '已同步', icon: 'i-heroicons-check-circle', color: 'green' }
    : { title: '同步失败', description: syncError.value || '未登录', icon: 'i-heroicons-exclamation-triangle', color: 'red' })
}

const items = computed(() => [
  [{
    label: user.value?.username || '未登录',
    // 存储落在哪儿是排查「本地存进去了线上却没有」的第一个线索，只在开发兜底时才提
    hint: storeKind.value === 'local' ? '本地开发存储（.data/）' : '',
    icon: 'i-heroicons-user-circle',
    disabled: true,
  }],
  [{
    label: syncing.value ? '正在同步…' : '立即同步',
    hint: stateText.value,
    icon: syncing.value ? 'i-heroicons-arrow-path' : 'i-heroicons-cloud-arrow-up',
    click: () => { void doSync() },
  }],
  [{
    label: '退出登录',
    hint: '本机的记录和收藏不会被删',
    icon: 'i-heroicons-arrow-right-on-rectangle',
    click: () => logout(),
  }],
])
</script>

<template>
  <UButton
    v-if="!isLoggedIn"
    variant="ghost"
    color="gray"
    size="sm"
    icon="i-heroicons-cloud-arrow-up"
    @click="authOpen = true"
  >
    登录
  </UButton>

  <UDropdown v-else :items="items" :popper="{ placement: 'bottom-end' }">
    <UButton variant="ghost" color="gray" size="sm" class="gap-1.5">
      <span
        class="w-6 h-6 rounded-full bg-gradient-to-br from-rose-400 to-violet-400
               text-white text-xs flex items-center justify-center shrink-0"
      >{{ (user?.username || '?').slice(0, 1) }}</span>
      <UIcon
        v-if="syncing"
        name="i-heroicons-arrow-path"
        class="w-3.5 h-3.5 animate-spin text-gray-400"
      />
      <!-- 有待上传的改动时点一颗小点：不然「改了但还没传」这个状态在界面上完全不可见 -->
      <span v-else-if="pendingChanges" class="w-1.5 h-1.5 rounded-full bg-amber-400" />
      <span v-else-if="syncError" class="w-1.5 h-1.5 rounded-full bg-rose-400" />
    </UButton>

    <template #item="{ item }">
      <div class="flex items-start gap-2 min-w-0">
        <UIcon :name="item.icon" class="w-4 h-4 shrink-0 mt-0.5" />
        <div class="min-w-0 text-left">
          <div class="truncate">{{ item.label }}</div>
          <div v-if="item.hint" class="text-[11px] text-gray-400 dark:text-gray-500 whitespace-normal">
            {{ item.hint }}
          </div>
        </div>
      </div>
    </template>
  </UDropdown>
</template>
