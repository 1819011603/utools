/**
 * 全屏时画在顶部信息条上的「手机时间 + 电量」。
 *
 * 为什么播放器要自己画这两样：全屏会把系统状态栏一起盖掉，而看片恰恰是最容易看丢时间、
 * 也最怕电量悄悄见底的场景（腾讯/爱奇艺的竖屏播放器都在顶栏补这一行，就是这个道理）。
 *
 * **只在真正要显示时才跑**（`active` 为真 = 全屏）：时钟是个常驻定时器，
 * 不看片的时候没有任何理由每分钟醒一次。
 */
export function useDeviceStatus(active: Ref<boolean>) {
  /** HH:MM，跟系统状态栏一个格式 */
  const clock = ref('')
  /** 0-100；null = 这个浏览器不给电量（Safari/Firefox 都不支持） */
  const batteryLevel = ref<number | null>(null)
  const charging = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = () => {
    const d = new Date()
    clock.value = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    // 睡到**下一次跳分**那一刻，而不是每 10 秒醒一次查一遍：
    // 显示精度只到分钟，多醒的每一次都是白跑（多留 50ms 余量，免得刚好卡在边界上少跳一分钟）
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
  }

  const stopClock = () => { if (timer) { clearTimeout(timer); timer = null } }

  // ── 电量 ──
  // Battery Status API 只有 Chromium 系有。拿不到就让 batteryLevel 停在 null，
  // 界面上整块不渲染——**绝不画一个猜的数字**，看片时电量读数不准比没有更糟
  let batt: any = null
  const syncBattery = () => {
    if (!batt) return
    batteryLevel.value = Math.round(batt.level * 100)
    charging.value = !!batt.charging
  }

  const bindBattery = async () => {
    if (batt) return
    const getBattery = (navigator as any)?.getBattery
    if (typeof getBattery !== 'function') return
    try {
      batt = await getBattery.call(navigator)
      syncBattery()
      batt.addEventListener('levelchange', syncBattery)
      batt.addEventListener('chargingchange', syncBattery)
    } catch { /* 有的环境会直接拒（iframe 权限策略），当作不支持 */ }
  }

  const unbindBattery = () => {
    if (!batt) return
    batt.removeEventListener('levelchange', syncBattery)
    batt.removeEventListener('chargingchange', syncBattery)
    batt = null
  }

  watch(active, on => {
    stopClock()
    if (!on) return
    tick()          // 先立刻出一个值：进全屏那一下就该是对的，不能等到下一次跳分
    void bindBattery()
  }, { immediate: true })

  onUnmounted(() => { stopClock(); unbindBattery() })

  return { clock, batteryLevel, charging }
}
