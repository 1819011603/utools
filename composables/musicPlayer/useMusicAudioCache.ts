/**
 * 整首音频的浏览器端持久缓存（IndexedDB，模块级单例）：**滑动 TTL 30 天** + 1GB 上限 + LRU。
 *
 * TTL 和 LRU 都以「最后一次播放」为准，所以 30 天的含义是**「多久没再听就丢掉」**，
 * 不是「存满 30 天就丢掉」—— 每播一次就把有效期续满。反复在听的歌永远不会被清走，
 * 那正是最该留的：重下一次是几十 MB 流量，还要再烧一份站点的每日配额。
 *
 * **存在的首要理由是省站点配额，不是省流量**：24bit 按天按 IP 限额，
 * 而循环播放 / 重听 / 下载已经听过的那首，每一次都要重新取一个带签名的地址（`Track.url` 20 分钟就死）。
 * 把整首歌存下来，这三种场景就是**零请求**——听多久都不再动配额。
 *
 * 与 `videoPlayer/useSegmentCache.ts` 的关系：思路（TTL + 上限 + LRU）是一样的，但那份是**内存**里的
 * HLS 分片，刷新即失、按播放头淘汰；这份是**跨会话存活的整文件**，所以多出三件事：
 *   ① 原子性（半截音频比没有更糟：能起播、播到一半戛然而止，用户还以为是网络问题）
 *   ② 配额要**写之前**算（写爆了抛 QuotaExceededError，事后再清已经晚了）
 *   ③ 浏览器**自己也会驱逐**（best-effort 配额下磁盘吃紧时整个 origin 一起清）
 *      → 任何读取都必须能容忍 miss，`cachedKeys` 只是提示不是保证
 *
 * 本模块**不认识任何站点**（同 `types.ts` 的立场）：tier 一律当不透明字符串，
 * 24bit 的 `b`/`c` 两档只是它恰好长这样。
 */

/** 每首歌的元数据（不含 Blob）。单独一张表，让「查有没有 / 算占用 / 挑淘汰对象」都不必反序列化几十 MB */
interface MusicCacheRecordMeta {
  id: string
  trackKey: string
  tier: string
  bytes: number
  /** 写入时间。只用来展示/排查，**不参与任何淘汰判断** */
  savedAt: number
  /**
   * 最后一次播放时间。**TTL 和 LRU 都只看它。**
   *
   * TTL 做成「滑动过期」而不是「写入后 30 天必删」：一首反复在听的歌不该因为
   * 下载得早就被清掉——那正是最该留着的那份（重下一次就是几十 MB 流量 + 一次配额）。
   * 所以每播一次就把有效期续满 30 天，真正被清掉的只有「30 天没再碰过」的。
   */
  lastAt: number
  name?: string
  artist?: string
  format?: string
}

/**
 * Blob 表里的记录。
 *
 * `savedAt` 只是留个痕迹，**TTL 不看它** —— TTL 改成按「最后播放时间」滑动续期后，
 * 那个时间戳每播一次就变，冗余在这张表里意味着**每次播放都要重写几十 MB 的 Blob**。
 * 所以判过期改成读 meta 表（`getCached` 本来就要写它来刷新 lastAt，顺路的事）。
 */
interface MusicCacheBlobRecord {
  id: string
  blob: Blob
  savedAt: number
}

/** `putCached` 的附带信息。**`expectedBytes` 是原子性的第二道闸**，见 putCached 的注释 */
export interface MusicCacheMeta {
  tier?: string
  name?: string
  artist?: string
  format?: string
  /** 期望字节数（下载时读到的 content-length）。传了就核对，对不上一律拒收 */
  expectedBytes?: number
}

export interface MusicCacheStats {
  count: number
  bytes: number
}

const DB_NAME = 'utools-music-audio'
const DB_VERSION = 1
const STORE_BLOB = 'audio'
const STORE_META = 'meta'

/**
 * 30 天，且**每播一次就续满 30 天**（滑动过期，判据是 `lastAt` 不是 `savedAt`）。
 *
 * 所以这个数的真实含义是「多久没再听就丢掉」，而不是「存多久就丢掉」。
 * 常听的那些永远不会因为下载得早被清走 —— 它们正是最该留的：
 * 重下一次就是几十 MB 流量，还要再烧一份站点的每日配额。
 */
const MUSIC_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 总量上限 1GB。面板上要显示「已用 xxx MB / 1GB」，所以导出给 UI 用同一个数，别两处各写一份 */
export const MUSIC_CACHE_MAX_BYTES = 1024 * 1024 * 1024

/**
 * 单条上限 256MB。最大的「高清环绕声」也就 115MB 上下，超出这个数基本可以断定是拿错了东西
 * （比如把一整页 HTML 错当音频存进来）——放它进去会一口吃掉四分之一预算，还会把真正有用的挤掉。
 */
const MAX_ITEM_BYTES = 256 * 1024 * 1024

/** `indexedDB.open` 的兜底闹钟：隐私模式下它可能既不 success 也不 error，就那么挂着 */
const OPEN_TIMEOUT_MS = 5000

/**
 * 已缓存的存储键集合，**模块级单例**：列表要打「已缓存」标记、面板要显示占用，
 * 两处必须看同一份，各自维护一份就会出现「列表说有、面板说没有」。
 *
 * Vue 3 的 reactive Set 支持 add/delete 追踪，所以模板里直接 `cachedKeys.has(k)` 就能响应。
 * 注意它是**提示不是保证**：浏览器可能背着我们把整个库清了，所以读到 miss 时要顺手把键摘掉（自愈）。
 */
const cachedKeys = ref<Set<string>>(new Set())

/** IDB 可不可用。隐私模式 / 关了存储权限时为 false，UI 据此把整块缓存功能藏起来，别给用户一个恒失败的开关 */
const cacheAvailable = ref(true)

/** 一次失败就整场不再重试：open 失败是环境性的（隐私模式），每次调用都重试只是白等 5 秒 */
let dbUnavailable = false
let dbPromise: Promise<IDBDatabase | null> | null = null

/** 把 IDBRequest 包成 Promise。注意 resolve 发生在微任务里，同一事务内接着发下一个请求仍然安全 */
function idbRequest<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * 等事务真正提交。**写入必须等这个而不是等最后一个 put 的 success**：
 * put 成功只说明请求被接受了，事务仍可能在提交阶段因配额不足整体 abort——
 * 那一刻两张表要么都写进去、要么都没有，这正是我们要的原子性。
 */
function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || dbUnavailable) return null
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const done = (db: IDBDatabase | null) => {
      if (settled) return
      settled = true
      if (!db) {
        dbUnavailable = true
        cacheAvailable.value = false
      }
      resolve(db)
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_BLOB)) db.createObjectStore(STORE_BLOB, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        clearTimeout(timer)
        const db = req.result
        // 别的标签页要升级版本时必须让路，否则那边永远 blocked、两边一起卡死
        db.onversionchange = () => { try { db.close() } catch {} ; dbPromise = null }
        done(db)
      }
      req.onerror = () => { clearTimeout(timer); done(null) }
      req.onblocked = () => { clearTimeout(timer); done(null) }
    } catch {
      done(null)   // 有的浏览器在隐私模式下访问 indexedDB 这个属性本身就抛
    }
  })
  return dbPromise
}

/**
 * 存储键。**必须带上音质档**：同一首歌的 `b`/`c` 两档体积差约 5 倍，
 * 只按 `Track.key` 存的话，用户切到高清环绕声会静默拿到那份无损的（听起来「设置没生效」）。
 *
 * 分隔符用 `@` 而不是 `:`——`Track.key` 本身就是 `24bit:<id>` 这种带冒号的形状，
 * 再用冒号会让人误以为还能按段拆，实际拆不回来。
 */
export function musicCacheKeyOf(trackKey: string, tier?: string | null): string {
  return `${trackKey}@${tier || 'default'}`
}

export function useMusicAudioCache() {
  /** 读全部 meta。条目数量级只有几十（1GB ÷ 几十 MB），整表拿回来比维护游标简单得多 */
  const readAllMeta = async (db: IDBDatabase): Promise<MusicCacheRecordMeta[]> => {
    const tx = db.transaction(STORE_META, 'readonly')
    return await idbRequest(tx.objectStore(STORE_META).getAll() as IDBRequest<MusicCacheRecordMeta[]>)
  }

  /** 两张表一起删，同一个事务里 —— 只删一半会留下「有 Blob 没账」或反过来的孤儿 */
  const deleteIds = async (db: IDBDatabase, ids: string[]) => {
    if (!ids.length) return
    const tx = db.transaction([STORE_BLOB, STORE_META], 'readwrite')
    const blobStore = tx.objectStore(STORE_BLOB)
    const metaStore = tx.objectStore(STORE_META)
    for (const id of ids) { blobStore.delete(id); metaStore.delete(id) }
    await idbTxDone(tx)
    for (const id of ids) cachedKeys.value.delete(id)
  }

  /**
   * 腾地方。**必须在写入之前跑**：IndexedDB 写爆时抛的是 QuotaExceededError，
   * 那时候数据已经在手上、事务已经 abort，只能整份丢掉重下——白下一次几十 MB，
   * 而这个功能的全部意义就是别再多发请求。
   *
   * 顺带把过期的一起清了：反正已经把整张 meta 表读进来了，再扫一遍是白送的。
   */
  const evictFor = async (db: IDBDatabase, incomingBytes: number, selfId: string): Promise<boolean> => {
    const metas = await readAllMeta(db)
    const now = Date.now()
    const doomed: string[] = []
    const alive: MusicCacheRecordMeta[] = []
    let total = 0

    for (const m of metas) {
      // 覆写同一个键：旧的那份马上会被 put 顶掉，不该算进预算（否则会误淘汰别人来给自己让位）
      if (m.id === selfId) continue
      if (now - m.lastAt > MUSIC_CACHE_TTL_MS) { doomed.push(m.id); continue }
      alive.push(m)
      total += m.bytes
    }

    // LRU 依据是 lastAt（最后一次听）不是 savedAt（什么时候下的）：
    // 一首下了半年、每天都听的歌，按写入时间排会第一个被踢掉，那正好是最不该踢的那首
    alive.sort((a, b) => a.lastAt - b.lastAt)
    let i = 0
    while (total + incomingBytes > MUSIC_CACHE_MAX_BYTES && i < alive.length) {
      total -= alive[i].bytes
      doomed.push(alive[i].id)
      i++
    }

    if (doomed.length) await deleteIds(db, doomed)
    return total + incomingBytes <= MUSIC_CACHE_MAX_BYTES
  }

  /**
   * 刷新最后播放时间 —— **同时是 LRU 依据和 TTL 续期**（滑动过期，见 MUSIC_CACHE_TTL_MS）。
   *
   * **故意不 await、失败也不管**：写的是几百字节的 meta，而起播那一刻的每一毫秒都归用户。
   * 万一这次没写成，代价只是这首歌的有效期没被续上——下次再播时会补上，不影响正确性。
   */
  const touch = (db: IDBDatabase, id: string) => {
    try {
      const tx = db.transaction(STORE_META, 'readwrite')
      const store = tx.objectStore(STORE_META)
      const req = store.get(id) as IDBRequest<MusicCacheRecordMeta | undefined>
      req.onsuccess = () => {
        const m = req.result
        if (!m) return
        m.lastAt = Date.now()
        try { store.put(m) } catch {}
      }
    } catch {}
  }

  /**
   * 取整首音频。命中返回 Blob（调用方 `URL.createObjectURL` 即可直接喂给 `<audio>`），
   * 未命中 / 过期 / 库被浏览器清掉一律返回 null —— **调用方必须能容忍 null**，
   * 这是「浏览器自己也会驱逐」的直接后果，不是异常路径。
   */
  const getCached = async (key: string): Promise<Blob | null> => {
    if (typeof window === 'undefined' || !key) return null
    try {
      const db = await openDb()
      if (!db) return null

      /*
       * 先读 meta 判过期，再去取 Blob。
       *
       * 顺序不能反：TTL 是按**最后播放时间**滑动续期的，那个时间戳只在 meta 表里
       * （冗余到 blob 表意味着每播一次都要重写几十 MB）。而 meta 只有几百字节，
       * 先读它还能让「已过期」这条路径完全不必把大 Blob 反序列化出来。
       */
      const metaTx = db.transaction(STORE_META, 'readonly')
      const meta = await idbRequest(
        metaTx.objectStore(STORE_META).get(key) as IDBRequest<MusicCacheRecordMeta | undefined>,
      )
      if (meta && Date.now() - meta.lastAt > MUSIC_CACHE_TTL_MS) {
        void removeCached(key)   // 到期当 miss，且**顺手删掉**：留着只会占满预算把新的挤出去
        return null
      }

      const tx = db.transaction(STORE_BLOB, 'readonly')
      const rec = await idbRequest(tx.objectStore(STORE_BLOB).get(key) as IDBRequest<MusicCacheBlobRecord | undefined>)

      if (!rec || !(rec.blob instanceof Blob) || rec.blob.size <= 0) {
        // 键在集合里但库里没有 = 浏览器背着我们清过（或上次写了一半）→ 顺手摘掉，列表标记自愈
        if (cachedKeys.value.has(key)) void removeCached(key)
        return null
      }

      // 播了就续期：把有效期重新推满 30 天，常听的那些永远不会被 TTL 清掉
      touch(db, key)
      cachedKeys.value.add(key)
      return rec.blob
    } catch {
      return null   // IDB 出任何岔子都降级成「没有缓存」，绝不让播放页崩在缓存层上
    }
  }

  /**
   * 原子写入。返回是否真的存进去了 —— 调用方据此决定要不要打「已缓存」标记，别乐观地假定成功。
   *
   * **半截音频比没有更糟**：它能起播、能播到一半，用户会以为是网络烂而不是缓存坏，
   * 下次重听还是同一份坏数据。所以这里设了三道闸，任何一道不过都拒收：
   *   ① `blob.size > 0`（中断的 fetch 常常给回一个空 Blob）
   *   ② `expectedBytes` 核对（下载时的 content-length；分块下载漏了一块正好卡在这里）
   *   ③ 单条不超过 `MAX_ITEM_BYTES`
   * 三道都过之后，整个 Blob **一次 put 进去**，两张表同一个事务 —— IDB 事务要么全成要么全无，
   * 中途失败/关标签页都不会留下半份记录。
   */
  const putCached = async (key: string, blob: Blob, meta: MusicCacheMeta = {}): Promise<boolean> => {
    if (typeof window === 'undefined' || !key) return false
    if (!(blob instanceof Blob) || blob.size <= 0) return false
    if (meta.expectedBytes && meta.expectedBytes > 0 && blob.size !== meta.expectedBytes) return false
    if (blob.size > MAX_ITEM_BYTES) return false

    try {
      const db = await openDb()
      if (!db) return false
      if (!await evictFor(db, blob.size, key)) return false   // 腾不出地方就别写，省得白抛一个 QuotaExceededError

      const now = Date.now()
      const at = key.lastIndexOf('@')
      const record: MusicCacheRecordMeta = {
        id: key,
        trackKey: at > 0 ? key.slice(0, at) : key,
        tier: meta.tier || (at > 0 ? key.slice(at + 1) : ''),
        bytes: blob.size,
        savedAt: now,
        lastAt: now,
        name: meta.name,
        artist: meta.artist,
        format: meta.format,
      }

      const tx = db.transaction([STORE_BLOB, STORE_META], 'readwrite')
      tx.objectStore(STORE_BLOB).put({ id: key, blob, savedAt: now } satisfies MusicCacheBlobRecord)
      tx.objectStore(STORE_META).put(record)
      await idbTxDone(tx)

      cachedKeys.value.add(key)
      // 真的写下了一条，才去申请「别清我」——理由见 useHistory.ts 里 requestPersistentStorage 的注释：
      // 页面加载时凭空弹权限窗，用户既不知道是谁要的也想不出为什么要给
      void requestPersistentStorage()
      return true
    } catch {
      return false
    }
  }

  /**
   * 只查有无，**不取 Blob**。列表里几十行都要打「已缓存」标记，
   * 每行取一次 Blob 就是几十次几十 MB 的反序列化——页面会当场卡住。
   */
  const hasCached = async (key: string): Promise<boolean> => {
    if (typeof window === 'undefined' || !key) return false
    try {
      const db = await openDb()
      if (!db) return false
      const tx = db.transaction(STORE_META, 'readonly')
      const m = await idbRequest(tx.objectStore(STORE_META).get(key) as IDBRequest<MusicCacheRecordMeta | undefined>)
      if (!m) { cachedKeys.value.delete(key); return false }
      if (Date.now() - m.lastAt > MUSIC_CACHE_TTL_MS) { void removeCached(key); return false }
      cachedKeys.value.add(key)
      return true
    } catch {
      return false
    }
  }

  const removeCached = async (key: string): Promise<void> => {
    if (typeof window === 'undefined' || !key) return
    cachedKeys.value.delete(key)   // 先摘键：即使下面删库失败，UI 也不该继续骗用户说「已缓存」
    try {
      const db = await openDb()
      if (db) await deleteIds(db, [key])
    } catch {}
  }

  const clearCache = async (): Promise<void> => {
    cachedKeys.value = new Set()
    if (typeof window === 'undefined') return
    try {
      const db = await openDb()
      if (!db) return
      const tx = db.transaction([STORE_BLOB, STORE_META], 'readwrite')
      tx.objectStore(STORE_BLOB).clear()
      tx.objectStore(STORE_META).clear()
      await idbTxDone(tx)
    } catch {}
  }

  /** 面板上的「已用 xxx MB / 1GB」。只读 meta 表，跟条目大小无关，随便调 */
  const cacheStats = async (): Promise<MusicCacheStats> => {
    if (typeof window === 'undefined') return { count: 0, bytes: 0 }
    try {
      const db = await openDb()
      if (!db) return { count: 0, bytes: 0 }
      const metas = await readAllMeta(db)
      const now = Date.now()
      let count = 0
      let bytes = 0
      for (const m of metas) {
        if (now - m.lastAt > MUSIC_CACHE_TTL_MS) continue   // 过期的不算数（它下一次淘汰就没了）
        count++
        bytes += m.bytes
      }
      return { count, bytes }
    } catch {
      return { count: 0, bytes: 0 }
    }
  }

  /**
   * 把 `cachedKeys` 与库里的实际内容对齐，顺手把过期的删掉。
   * 页面挂载时调一次即可；写入/删除都会自己维护集合，不需要每次操作后再刷。
   *
   * **必须整份替换而不是增量补**：浏览器可能在两次访问之间把整个 origin 清了，
   * 只加不减的话列表会永远显示一堆早就不存在的「已缓存」。
   */
  const refreshCachedKeys = async (): Promise<void> => {
    if (typeof window === 'undefined') return
    try {
      const db = await openDb()
      if (!db) { cachedKeys.value = new Set(); return }
      const metas = await readAllMeta(db)
      const now = Date.now()
      const fresh = new Set<string>()
      const expired: string[] = []
      for (const m of metas) {
        if (now - m.lastAt > MUSIC_CACHE_TTL_MS) expired.push(m.id)
        else fresh.add(m.id)
      }
      cachedKeys.value = fresh
      if (expired.length) await deleteIds(db, expired)
    } catch {
      cachedKeys.value = new Set()
    }
  }

  return {
    getCached,
    putCached,
    hasCached,
    removeCached,
    clearCache,
    cacheStats,
    cachedKeys,
    refreshCachedKeys,
    cacheAvailable,
    /** 上限字节数，给 UI 拼「/ 1GB」用，别在组件里再写一遍这个数 */
    cacheLimitBytes: MUSIC_CACHE_MAX_BYTES,
  }
}
