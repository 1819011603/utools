<script setup lang="ts">
/**
 * 登录 / 注册弹窗。挂在布局根上（不是挂在按钮里）——`/video-search` 那一页不出 header，
 * 按钮跟着不渲染，弹窗要是嵌在按钮里就一起没了。
 *
 * 三件必须在界面上说清的事，不然用户会误解：
 *   ① **登录要等一秒多**：口令拉伸（12 万次 PBKDF2）在本机算，服务端做不了
 *      （CF 免费版每请求 10ms CPU）。所以按钮必须有 loading，否则会被连点几下。
 *   ② **忘了密码找不回**：没有邮箱、没有短信，我们手上压根没有能验证「你是你」的东西。
 *      不说的话用户会等一个不存在的「忘记密码」链接。
 *   ③ **同步了什么、没同步什么**：清单信息会上传，播放地址和第三方站的凭证不会。
 *
 * 注册面板一打开就先问一次名额（`/api/user/quota`）：满了的话让用户填完表、
 * 等完那一秒拉伸、最后才被拒，是最难受的顺序。
 */
const { authOpen, busy, authError, register, login, fetchQuota } = useUserAuth()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const password2 = ref('')
const localError = ref('')
const quota = ref<{ used: number; max: number } | null>(null)

const isFull = computed(() => !!quota.value && quota.value.used >= quota.value.max)
const errorText = computed(() => localError.value || authError.value)

watch(authOpen, async (open) => {
  if (!open) return
  localError.value = ''
  authError.value = ''
  password.value = ''
  password2.value = ''
  quota.value = null
  // 拿不到就当没这回事：名额提示是锦上添花，不该拦住登录
  try { quota.value = await fetchQuota() } catch { /* 忽略 */ }
})

const submit = async () => {
  localError.value = ''
  const u = username.value.trim()
  if (!u) { localError.value = '请填用户名'; return }
  if (password.value.length < 8) { localError.value = '密码至少 8 位'; return }
  if (mode.value === 'register' && password.value !== password2.value) {
    localError.value = '两次输入的密码不一样'
    return
  }
  const ok = mode.value === 'login' ? await login(u, password.value) : await register(u, password.value)
  if (ok) { username.value = ''; password.value = ''; password2.value = '' }
}
</script>

<template>
  <UModal v-model="authOpen" :ui="{ width: 'sm:max-w-md' }">
    <div class="p-6 space-y-5">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">
          {{ mode === 'login' ? '登录' : '注册' }}
        </h3>
        <UButton variant="ghost" color="gray" icon="i-heroicons-x-mark" @click="authOpen = false" />
      </div>

      <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        登录后，<span class="text-gray-700 dark:text-gray-200">追剧进度、片名与音乐搜索历史、音乐收藏、每部剧的倍速与片头片尾</span>
        会同步到云端，换设备能接着用。播放地址和第三方站的登录凭证一律不上传。
      </p>

      <template v-if="mode === 'register' && isFull">
        <UAlert
          color="orange"
          variant="soft"
          icon="i-heroicons-user-group"
          title="注册名额已满"
          :description="`目前只开放 ${quota?.max} 个账号（已用 ${quota?.used} 个）。已有账号请直接登录。`"
        />
      </template>

      <template v-else>
        <div class="space-y-3">
          <UFormGroup label="用户名" size="lg">
            <UInput
              v-model="username"
              placeholder="2~24 个中英文、数字或 . _ - @"
              autocomplete="username"
              :disabled="busy"
              @keyup.enter="submit"
            />
          </UFormGroup>

          <UFormGroup label="密码" size="lg" :hint="mode === 'register' ? '至少 8 位' : undefined">
            <UInput
              v-model="password"
              type="password"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              :disabled="busy"
              @keyup.enter="submit"
            />
          </UFormGroup>

          <UFormGroup v-if="mode === 'register'" label="再输一次" size="lg">
            <UInput
              v-model="password2"
              type="password"
              autocomplete="new-password"
              :disabled="busy"
              @keyup.enter="submit"
            />
          </UFormGroup>
        </div>

        <p v-if="errorText" class="text-sm text-rose-500">{{ errorText }}</p>

        <UButton
          block
          size="lg"
          :loading="busy"
          :disabled="busy"
          @click="submit"
        >
          {{ busy ? '正在本机计算密码…' : (mode === 'login' ? '登录' : '注册') }}
        </UButton>

        <p class="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
          密码在你的浏览器里先做一遍 12 万次的哈希拉伸再上传，服务器全程看不到明文
          —— 所以点下去会算一到两秒，这是正常的。
          <span v-if="mode === 'register'" class="text-gray-500 dark:text-gray-400">
            没有邮箱验证，<span class="text-rose-500/90">密码忘了找不回来</span>，请自己记牢。
          </span>
        </p>
      </template>

      <div class="pt-1 border-t border-gray-100 dark:border-white/5 text-center">
        <UButton
          variant="link"
          color="gray"
          size="xs"
          :disabled="busy"
          @click="mode = mode === 'login' ? 'register' : 'login'; localError = ''; authError = ''"
        >
          {{ mode === 'login' ? '还没有账号？去注册' : '已有账号？去登录' }}
        </UButton>
      </div>
    </div>
  </UModal>
</template>
