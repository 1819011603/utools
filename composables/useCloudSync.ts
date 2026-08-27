/**
 * 同步引擎。**一次同步只有一个动作：拉取 → 合并 → 变了才提交。**
 *
 * 不做「上传」和「下载」两条路：那样就有两套语义要各自想清楚冲突和删除怎么办，
 * 而它们其实是同一件事的两半。单向的一条路，两台设备各跑一遍就收敛了。
 *
 * ## 两条节流规则（都是刻意的）
 *
 * · **有变更才同步**：`dirty` 空着就不发**推送**。例外是几个「该问问云端」的时机
 *   （打开页面 / 回到前台 / 前台每 5 分钟一次，都走 `checkRemote`）和**这台设备还从没同步过**
 *   （刚登录 / 换了浏览器）。这道闸挡的是白推，不该连拉取一起挡住——挡住的话
 *   「换设备接着看」等于没有，而问一句的代价只是一发 `?meta=1`（云端没变就到此为止）。
 * · **两次之间至少 5 分钟**。落在窗口里的改动**不发请求、只留着 `dirty` 标记**：
 *   数据本来就在 localStorage 里，云端最多滞后 5 分钟，什么都不会丢。
 *
 * 节流的时钟用「上次**尝试**」而不是「上次成功」：用成功当时钟的话，一旦出错（比如没网），
 * 每一次改动都会立刻再撞一次网络，5 分钟内能撞几十下。
 *
 * ## 关标签页那一下是尽力而为
 *
 * `pagehide` 里发出的请求可能被浏览器掐掉。这里不为它做 `sendBeacon` 那套：
 * beacon 发不了带鉴权头的 GET，也做不了「拉取→合并」这半段，而代价只是「这次改动等下次再上去」，
 * 数据在 localStorage 里是安全的。
 */
import type { SyncSpec } from './cloudSyncMerge'
import { emptyItems, isEmptyItems, mergeItems, mergeTomb, parsePayload, sameJson } from './cloudSyncMerge'
import { SYNC_COLLECTIONS } from './cloudSyncSpec'
import type { SyncMeta } from './cloudSyncLocal'
import { notifyApplied, onDirty, onFlushRequest, patchMeta, readMeta, writeMeta } from './cloudSyncLocal'

const THROTTLE_MS = 5 * 60_000
/** 连着改好几下（连点几个收藏）只算一次 */
const DEBOUNCE_MS = 5_000
/** 定时问云端的醒来间隔。真正的节奏由上面那道 5 分钟节流定，见 start 里的注释 */
const REMOTE_POLL_MS = 60_000

interface PullRes {
  user: { uid: string; username: string }
  store: 'd1' | 'local'
  /** `?meta=1` 那一发只有版本号，没有 payload */
  colls: Array<{ coll: string; rev: number; payload?: string }>
}

interface PushRes {
  results: Array<{ coll: string; ok: boolean; rev?: number }>
}

const syncing = ref(false)
const lastOkAt = ref(0)
const syncError = ref('')
/** 有改动但被 5 分钟窗口挡着。界面上要说出来，否则「点了没反应」 */
const pendingChanges = ref(false)
const storeKind = ref<'d1' | 'local' | ''>('')

let started = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const readLocal = (spec: SyncSpec): any => {
  try {
    const raw = localStorage.getItem(spec.lsKey)
    if (!raw) return emptyItems(spec.kind)
    const v = JSON.parse(raw)
    if (spec.kind === 'map') return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
    return Array.isArray(v) ? v : []
  } catch { return emptyItems(spec.kind) }
}

const writeLocal = (spec: SyncSpec, items: any) => {
  try { localStorage.setItem(spec.lsKey, JSON.stringify(items)) } catch { /* 配额满了，这一份下次再落 */ }
}

/**
 * 扔掉账本里**已经不在清单表里**的那些 id。
 *
 * 同步一轮只遍历 `SYNC_COLLECTIONS`，所以某份清单从表里去掉之后，
 * 老用户 localStorage 里它那条 `dirty` 标记**再也没有人来清** —— 后果是
 * 「有变更才同步」那道闸恒为真：界面上那颗「有改动待上传」的黄点永久亮着，
 * 而且每过 5 分钟就白跑一整轮拉取+合并，一直到用户自己清浏览器数据为止。
 *
 * 真发生过：音乐那两份（`music-fav` / `music-search`）上线过一版，随后整个音乐功能被移除。
 * 所以这里不是防御性编程，而是**清单表本来就会增减**，账本得跟着收敛。
 */
const pruneUnknown = (m: SyncMeta): SyncMeta => {
  const known = new Set(SYNC_COLLECTIONS.map(s => s.id))
  let dropped = false
  for (const bag of [m.dirty, m.rev, m.clearedAt, m.tomb] as Record<string, unknown>[]) {
    for (const id of Object.keys(bag)) {
      if (known.has(id)) continue
      delete bag[id]
      dropped = true
    }
  }
  if (dropped) writeMeta(m)
  return m
}

export function useCloudSync() {
  const auth = useUserAuth()

  /**
   * 跑一轮。返回 true = 有冲突（外层据此再来一次）。
   *
   * **拉取分两发**（`full` 为真时退回一发全量）：
   *   ① `?meta=1` 只要版本号 —— 几十字节；
   *   ② 只有「云端 rev 跟本机记的对不上」的那几份才去取正文（`?colls=`）。
   *
   * 同步的常态是云端一份都没变（多数人只有一台设备在用），那时第二发压根不发。
   * 原来每轮都把四份全文（几十~几百 KB）拉一遍，「拉取慢」就是这么来的。
   *
   * rev 没变时**不需要云端正文也能算合并结果**：上一轮结束时已经把云端并进本地了，
   * 之后云端没动过 → 本地当前值就是并集，要不要推只看脏标记。
   * `full` 那条路留给首次同步和撞 rev 之后的重来 —— 那两种情况下本地那份推断不成立。
   */
  const cycle = async (full = false): Promise<boolean> => {
    const head = await auth.authFetch<PullRes>(full ? '/api/user/sync' : '/api/user/sync?meta=1')
    storeKind.value = head.store || ''
    if (head.user) auth.adoptUser(head.user)

    const cloudRev = new Map(head.colls.map(c => [c.coll, c.rev]))
    const m0 = readMeta()
    // 哪几份要取正文：云端有而本机没记过、或两边 rev 对不上
    const stale = full
      ? []
      : SYNC_COLLECTIONS.filter(s => (cloudRev.get(s.id) ?? 0) !== (m0.rev[s.id] ?? 0)).map(s => s.id)

    const res: PullRes = full || !stale.length
      ? head
      : await auth.authFetch<PullRes>('/api/user/sync?colls=' + encodeURIComponent(stale.join(',')))

    const cloud = new Map(res.colls.filter(c => c.payload !== undefined).map(c => [c.coll, c]))
    const now = Date.now()
    const m = readMeta()
    const pushes: Array<{ coll: string; baseRev: number; payload: string }> = []
    const applied: SyncSpec[] = []
    /**
     * 提交前每一份的脏标记时间。提交那一发是要 await 的，**这中间用户完全可以再收一首歌**
     * ——那次改动不在这一发的 payload 里，成功回来时无条件清掉脏标记就等于把它咽掉了，
     * 数据虽然还在 localStorage 里，却要等到下一次改动才有机会上去（可能是几天以后）。
     * 所以只清「跟提交前一模一样」的那些。
     */
    const dirtyAt: Record<string, number | undefined> = {}

    for (const spec of SYNC_COLLECTIONS) {
      const local = readLocal(spec)
      const row = cloud.get(spec.id)

      /**
       * 这一份没取正文 = 它的 rev 跟本机记的一样 = **云端没动过**。
       * 那么合并结果就是本地当前值（上一轮已经把云端并进来了），只需决定推不推。
       * 墓碑仍要过一遍 `mergeTomb` 做 TTL 修剪，否则它只增不减。
       */
      if (!row) {
        const tomb = mergeTomb(m.tomb[spec.id] || {}, {}, now)
        const clearedAt = m.clearedAt[spec.id] || 0
        m.tomb[spec.id] = tomb
        const rev = cloudRev.get(spec.id) ?? 0
        m.rev[spec.id] = rev
        // 云端还没有这一份而本地也确实没东西 → 不要白占一行（同下面那个 trivial）
        const trivial = !rev && isEmptyItems(spec.kind, local) && !Object.keys(tomb).length && !clearedAt
        if (m.dirty[spec.id] && !trivial) {
          dirtyAt[spec.id] = m.dirty[spec.id]
          pushes.push({ coll: spec.id, baseRev: rev, payload: JSON.stringify({ v: 1 as const, items: local, tomb, clearedAt }) })
        } else {
          delete m.dirty[spec.id]
        }
        continue
      }

      const cp = parsePayload(row.payload, spec.kind)

      // 墓碑和「清空」时间两边都要取并集/取大：只认自己那份的话，对方的删除就传不过来
      const tomb = mergeTomb(m.tomb[spec.id] || {}, cp.tomb, now)
      const clearedAt = Math.max(m.clearedAt[spec.id] || 0, cp.clearedAt)
      const merged = mergeItems(spec, local, cp.items, tomb, clearedAt)

      if (!sameJson(merged, local)) {
        writeLocal(spec, merged)
        applied.push(spec)
      }
      m.tomb[spec.id] = tomb
      m.clearedAt[spec.id] = clearedAt
      m.rev[spec.id] = row.rev

      // 走到这说明云端**确实有**这一份（没有的那些在上面就 continue 了），
      // 所以不必再判「别白占一行」——那道闸挪到了上面那条快路径里
      const next = { v: 1 as const, items: merged, tomb, clearedAt }
      const cloudSide = { v: 1 as const, items: cp.items, tomb: cp.tomb, clearedAt: cp.clearedAt }
      if (!sameJson(next, cloudSide)) {
        dirtyAt[spec.id] = m.dirty[spec.id]
        pushes.push({ coll: spec.id, baseRev: row.rev, payload: JSON.stringify(next) })
      } else {
        // 这一段整个是同步的，localStorage 不可能在中途变，所以这里清脏标记是安全的
        delete m.dirty[spec.id]
      }
    }

    writeMeta(m)
    // 落盘之后再通知界面：回调里会去重读 localStorage
    for (const spec of applied) {
      try { spec.onApplied?.() } catch { /* 刷新界面失败不该让整轮同步失败 */ }
      notifyApplied(spec.id)
    }

    if (!pushes.length) return false

    const pr = await auth.authFetch<PushRes>('/api/user/sync', { method: 'POST', body: { colls: pushes } })
    let conflict = false
    const m2 = readMeta()
    for (const r of pr.results || []) {
      if (r.ok && typeof r.rev === 'number') {
        m2.rev[r.coll] = r.rev
        // 只清「提交期间没再被改过」的那些，见上面 dirtyAt 的注释
        if (m2.dirty[r.coll] === dirtyAt[r.coll]) delete m2.dirty[r.coll]
      } else {
        // 撞了 rev = 别的设备在这中间写过。重新拉一轮再合并就是了
        conflict = true
      }
    }
    writeMeta(m2)
    return conflict
  }

  /**
   * `force` 只给用户手点的「立即同步」用：那是明确的意图，不是后台轮询，
   * 不该被 5 分钟窗口挡在外面（「有变更才同步」那道闸对它同样豁免——
   * 用户点它往往正是因为想把另一台设备的改动拉过来）。
   *
   * `checkRemote` 给「打开页面 / 回到前台」：**只为问一句「云端变了没」**。
   * 「有变更才同步」原本把**拉取**也一起挡住了——本机没有待上传的改动时一个请求都不发，
   * 于是另一台设备的更新永远不知道，表现就是**「两台机器状态不一致、看着像本地优先」**。
   * 现在问这一句只要一发 `?meta=1`（几十字节，见 cycle），云端没变就到此为止、
   * 一个正文都不取，所以这道豁免不会把「省请求」那个初衷吃掉。
   */
  const syncNow = async (opts: { force?: boolean; skipThrottle?: boolean; checkRemote?: boolean } = {}): Promise<boolean> => {
    if (typeof window === 'undefined' || !auth.token.value || syncing.value) return false

    const meta = pruneUnknown(readMeta())
    const hasDirty = Object.keys(meta.dirty).length > 0
    const neverSynced = Object.keys(meta.rev).length === 0

    if (!opts.force) {
      // 没改过、也不是要问云端 → 白跑一轮，不发
      if (!hasDirty && !neverSynced && !opts.checkRemote) return false
      // `skipThrottle` 给「按下暂停」那一路：它是个真实的好时机（进度刚落库、人要走开了），
      // 不该被 5 分钟窗口挡住。跑完 lastSyncAt 就更新了，窗口自然从那一刻重新开始算
      if (!opts.skipThrottle && Date.now() - meta.lastSyncAt < THROTTLE_MS) {
        pendingChanges.value = hasDirty
        return false
      }
    }

    syncing.value = true
    syncError.value = ''
    // 节流的时钟在**尝试**时就往前走，失败也算（否则出错时会被每一次改动反复撞）
    patchMeta(m => { m.lastSyncAt = Date.now() })
    try {
      // 只重试一次：两台设备来回撞的话再多试也是撞。
      // **重来那一轮走全量**：撞 rev 说明别的设备刚写过，本机记的 rev 已经不可信，
      // 「rev 一样 = 云端没动」那条推断在这里正好不成立
      if (await cycle()) await cycle(true)
      const m = patchMeta(x => { x.lastOkAt = Date.now() })
      lastOkAt.value = m.lastOkAt
      pendingChanges.value = Object.keys(m.dirty).length > 0
      return true
    } catch (e: any) {
      // 失败时**不清 dirty**：那几份下次还要再试
      syncError.value = auth.errText(e)
      pendingChanges.value = true
      return false
    } finally {
      syncing.value = false
    }
  }

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void syncNow() }, DEBOUNCE_MS)
  }

  /** 挂在布局上，每个页面都跑（`/video-search` 没有 header，但同步照常） */
  const start = () => {
    if (started || typeof window === 'undefined') return
    started = true

    // 先剪掉已经不在清单表里的 id，否则那颗「有改动待上传」的黄点会凭空亮着
    const m = pruneUnknown(readMeta())
    lastOkAt.value = m.lastOkAt || 0
    pendingChanges.value = Object.keys(m.dirty).length > 0

    onDirty(schedule)
    // 「现在就同步」——目前唯一的发起方是**用户按下暂停**（见 cloudSyncLocal.requestSyncFlush）。
    // 豁免 5 分钟节流但仍要求有改动；跑完节流窗口从那一刻重新开始算
    onFlushRequest(() => { void syncNow({ skipThrottle: true }) })
    document.addEventListener('visibilitychange', () => {
      // 切走：把本机的改动补推上去（没改过就不发）
      if (document.visibilityState === 'hidden') { void syncNow(); return }
      /**
       * **回到前台：问一句云端变了没**。这台设备刚才可能在另一台上被追了几集，
       * 不问的话它会一直拿着本地旧值（用户看到的就是「两台机器状态不一致」）。
       * 受 5 分钟节流约束——来回切标签页不该每次都发。
       */
      void syncNow({ checkRemote: true })
    })
    window.addEventListener('pagehide', () => { void syncNow() })
    /**
     * **前台开着就每 5 分钟问一句「云端变了没」**。
     *
     * 补的是这么一个洞：两台设备都开着页面、谁都不切标签页（一台在放映厅看着、
     * 另一台摆在那），那么除了「打开页面」和「回到前台」，**一辈子都不会再问一次云端** ——
     * 一台上追的进度另一台永远等不到，看着还是「不同步」。
     *
     * 这条**只负责拉**：`checkRemote` 只豁免「有变更才同步」那道闸，云端 rev 没动时
     * 整轮就是一发 `?meta=1`（几十字节），一个正文都不取、一个 POST 都不发。
     * 真变了才会取正文并合并，而合并之后该推的照旧推 —— 那是收敛必需的，不是白推。
     *
     * 每分钟醒一次而不是每 5 分钟：**节奏交给 `syncNow` 里那道 5 分钟节流**（时钟是「上次尝试」），
     * 定时器自己掐 5 分钟的话会跟节流窗口错开一点点，隔一轮被挡掉一次，实际变成 10 分钟。
     * `hidden` 时直接跳过：后台标签页问了也没人看，回到前台那一发已经覆盖。
     */
    setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void syncNow({ checkRemote: true })
    }, REMOTE_POLL_MS)
    // 刚登录的那台设备 rev 是空的，这一发会真的拉；已经同步过又没改动的则原地返回
    watch(auth.token, t => { if (t) void syncNow({ force: true }) })
    /**
     * 页面打开这一发**豁免节流也豁免「有变更才同步」**：用户刚在这台设备上打开站点，
     * 正是最需要拿到另一台设备最新进度的时刻，而这一发在云端没变时只花一个 `?meta=1`。
     */
    void syncNow({ checkRemote: true, skipThrottle: true })
  }

  return { syncing, lastOkAt, syncError, pendingChanges, storeKind, syncNow, start }
}
