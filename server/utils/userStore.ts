/**
 * 账号与清单数据的存储层。**接口只有一份，实现有两个**：
 *
 *   · **D1**（线上）：绑定名 `USER_DB`，从 `event.context.cloudflare.env` 上取
 *   · **本地 JSON 文件**（`npm run dev`）：`nuxt dev` 跑在 Node 里，**压根没有 D1 绑定**，
 *     没有这一层的话整个账号功能在本地一步都跑不动（连注册按钮都点不下去）。
 *     落在 `.data/`（已在 .gitignore 里）。
 *
 * 约束同 proxy.ts：**不静态 import 任何 `node:*`**（Nitro preset 是 cloudflare-pages），
 * specifier 用变量 + `@vite-ignore` 包住，否则 Vite 会在 CF 构建时静态解析报错
 * （写法同 `siteFetch.ts:46`）。
 *
 * 写入一律走 `.bind()` 绑定参数，**绝不把 payload 拼进 SQL 文本**：
 * D1 单条语句上限 100KB，而字符串/行上限是 2MB —— 拼进去的话几十 KB 的收藏夹就会顶到语句上限，
 * 而绑定参数不计入语句长度。
 */
import type { H3Event } from 'h3'

export interface UserRow {
  uid: string
  username: string
  unameKey: string
  salt: string
  pwHash: string
  failCount: number
  lockUntil: number
  createdAt: number
}

export interface CollRow {
  coll: string
  rev: number
  payload: string
  updatedAt: number
}

/** 写入结果：冲突时把**当前值**一起带回去，前端才能就地重新合并而不用再拉一轮 */
export type WriteResult =
  | { ok: true; rev: number }
  | { ok: false; cur: CollRow | null }

/**
 * 名额上限。这是个自用的小站，存储和额度都按「几个人」算的，
 * 敞开注册的话第一个爬到 `/api/user/register` 的脚本就能把免费额度灌满。
 * 要放开就改这一个数（不需要动 schema）。
 */
export const MAX_USERS = 5

/** 建号失败的两种原因要分开：一种改个名字就能过，另一种改什么都过不了 */
export type CreateResult = 'ok' | 'taken' | 'full'

export interface UserStore {
  findByName(unameKey: string): Promise<UserRow | null>
  findByUid(uid: string): Promise<UserRow | null>
  countUsers(): Promise<number>
  /** 名额判断**必须和插入在同一条语句里**，否则两个人同时注册会双双通过 */
  createUser(row: UserRow): Promise<CreateResult>
  setFail(uid: string, failCount: number, lockUntil: number): Promise<void>
  /**
   * 读清单。`colls` 给了就只读那几份 —— 同步的常态是「云端一份都没变」，
   * 那时一个 payload 都不用取（见 sync.get.ts 的 `meta=1`）。
   */
  readColls(uid: string, colls?: string[]): Promise<CollRow[]>
  /**
   * 只读版本号，**不读 payload**。
   *
   * 这是拉取慢的解药：payload 是几份几十~几百 KB 的 JSON，而每一轮同步真正要问的
   * 只有「云端变了没有」——那是每份十几个字节的事。变了的才去取正文。
   */
  readCollRevs(uid: string): Promise<Array<{ coll: string; rev: number; updatedAt: number }>>
  writeColl(uid: string, coll: string, baseRev: number, payload: string): Promise<WriteResult>
}

// ── D1 ──────────────────────────────────────────────────────────────────────

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     uid TEXT PRIMARY KEY, username TEXT NOT NULL, uname_key TEXT NOT NULL UNIQUE,
     salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
     fail_count INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS user_blobs (
     uid TEXT NOT NULL, coll TEXT NOT NULL, rev INTEGER NOT NULL,
     payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (uid, coll))`,
]

/**
 * 懒建表。**模块级标志在 CF 上只对当前 isolate 有效**（CLAUDE.md 里那条），
 * 所以换个 isolate 会再跑一次 —— 两条 `IF NOT EXISTS` 的空 DDL，代价可以忽略，
 * 换来的是「忘了手工执行 schema.sql」不会变成一个只在线上出现的 500。
 */
let schemaReady = false

async function ensureSchema(db: any): Promise<void> {
  if (schemaReady) return
  await db.batch(DDL.map((sql: string) => db.prepare(sql)))
  schemaReady = true
}

const toUser = (r: any): UserRow | null => r ? {
  uid: String(r.uid),
  username: String(r.username),
  unameKey: String(r.uname_key),
  salt: String(r.salt),
  pwHash: String(r.pw_hash),
  failCount: Number(r.fail_count) || 0,
  lockUntil: Number(r.lock_until) || 0,
  createdAt: Number(r.created_at) || 0,
} : null

function d1Store(db: any): UserStore {
  const readOne = async (uid: string, coll: string): Promise<CollRow | null> => {
    const r = await db.prepare('SELECT coll, rev, payload, updated_at FROM user_blobs WHERE uid = ? AND coll = ?')
      .bind(uid, coll).first()
    return r ? { coll: String(r.coll), rev: Number(r.rev), payload: String(r.payload), updatedAt: Number(r.updated_at) } : null
  }

  return {
    async findByName(unameKey) {
      await ensureSchema(db)
      return toUser(await db.prepare('SELECT * FROM users WHERE uname_key = ?').bind(unameKey).first())
    },
    async findByUid(uid) {
      await ensureSchema(db)
      return toUser(await db.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first())
    },
    async countUsers() {
      await ensureSchema(db)
      const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first()
      return Number(r?.n ?? 0)
    },
    async createUser(row) {
      await ensureSchema(db)
      // 两道判断都塞进同一条语句：`OR IGNORE` 交给唯一索引裁决重名，
      // `WHERE (SELECT COUNT(*)...) < ?` 交给数据库裁决名额。
      // 先 SELECT 再 INSERT 那种写法两处都有竞态（同名同时注册 / 同时占掉最后一个名额）
      const r = await db.prepare(
        `INSERT OR IGNORE INTO users (uid, username, uname_key, salt, pw_hash, fail_count, lock_until, created_at)
         SELECT ?, ?, ?, ?, ?, 0, 0, ? WHERE (SELECT COUNT(*) FROM users) < ?`,
      ).bind(row.uid, row.username, row.unameKey, row.salt, row.pwHash, row.createdAt, MAX_USERS).run()
      if (Number(r?.meta?.changes ?? 0) > 0) return 'ok'
      // 没插进去：再数一次决定该说哪一句（这一步只在失败路径上跑，不影响正常注册的耗时）
      const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first()
      return Number(n?.n ?? 0) >= MAX_USERS ? 'full' : 'taken'
    },
    async setFail(uid, failCount, lockUntil) {
      await db.prepare('UPDATE users SET fail_count = ?, lock_until = ? WHERE uid = ?')
        .bind(failCount, lockUntil, uid).run()
    },
    async readColls(uid, colls) {
      await ensureSchema(db)
      // 占位符按份数现拼，**值仍然全部 bind**（payload 那条铁律同理：绝不拼进 SQL）
      const r = colls?.length
        ? await db.prepare(
            `SELECT coll, rev, payload, updated_at FROM user_blobs WHERE uid = ? AND coll IN (${colls.map(() => '?').join(',')})`,
          ).bind(uid, ...colls).all()
        : await db.prepare('SELECT coll, rev, payload, updated_at FROM user_blobs WHERE uid = ?').bind(uid).all()
      return (r?.results ?? []).map((x: any) => ({
        coll: String(x.coll), rev: Number(x.rev), payload: String(x.payload), updatedAt: Number(x.updated_at),
      }))
    },
    async readCollRevs(uid) {
      await ensureSchema(db)
      const r = await db.prepare('SELECT coll, rev, updated_at FROM user_blobs WHERE uid = ?').bind(uid).all()
      return (r?.results ?? []).map((x: any) => ({
        coll: String(x.coll), rev: Number(x.rev), updatedAt: Number(x.updated_at),
      }))
    },
    async writeColl(uid, coll, baseRev, payload) {
      await ensureSchema(db)
      const now = Date.now()
      // baseRev 0 = 「我认为云端还没有这一份」。用 OR IGNORE 而不是先查再插：
      // 中间被别的设备插了一行的话，先查再插会覆盖掉对方
      const r = baseRev <= 0
        ? await db.prepare(
            'INSERT OR IGNORE INTO user_blobs (uid, coll, rev, payload, updated_at) VALUES (?, ?, 1, ?, ?)',
          ).bind(uid, coll, payload, now).run()
        : await db.prepare(
            'UPDATE user_blobs SET rev = ?, payload = ?, updated_at = ? WHERE uid = ? AND coll = ? AND rev = ?',
          ).bind(baseRev + 1, payload, now, uid, coll, baseRev).run()
      if (Number(r?.meta?.changes ?? 0) > 0) return { ok: true, rev: baseRev <= 0 ? 1 : baseRev + 1 }
      return { ok: false, cur: await readOne(uid, coll) }
    },
  }
}

// ── 本地开发：JSON 文件 ──────────────────────────────────────────────────────

const DEV_DIR = '.data'

async function fsMod(): Promise<any> {
  // 变量 specifier + @vite-ignore：CF 构建时不能被静态解析到（那边压根没有 node:fs）
  const spec = 'node:fs/promises'
  return await import(/* @vite-ignore */ spec)
}

/**
 * **`fsMod()` 放在 try 外面**：里面那个 catch 是为了「文件还不存在」这种正常情况，
 * 不能顺手把「压根没有 node:fs」也吞掉 —— 吞掉的后果是线上把「读不到」当成「库是空的」，
 * 于是 `/api/user/quota` 一本正经地回 0/5，而注册会 500。**踩过一次**：
 * 曾用 `globalThis.process?.env` 判断「是不是在 Node 里」，而 CF Workers 上
 * `process.env` 是存在的（一个空对象），判据当场失效，整条兜底路在线上被走通了。
 */
async function devRead<T>(file: string, fallback: T): Promise<T> {
  const fs = await fsMod()
  try {
    return JSON.parse(await fs.readFile(`${DEV_DIR}/${file}`, 'utf8')) as T
  } catch { return fallback }
}

async function devWrite(file: string, value: unknown): Promise<void> {
  const fs = await fsMod()
  await fs.mkdir(DEV_DIR, { recursive: true })
  await fs.writeFile(`${DEV_DIR}/${file}`, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * 读-改-写串行化。本地是单进程，但同一次同步会连着写好几份清单，
 * 并发的读-改-写会互相吞掉（后写的那份基于更早的快照）。
 */
let chain: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

function devStore(): UserStore {
  type Blobs = Record<string, Record<string, CollRow>>

  return {
    async findByName(unameKey) {
      const all = await devRead<UserRow[]>('users.json', [])
      return all.find(u => u.unameKey === unameKey) ?? null
    },
    async findByUid(uid) {
      const all = await devRead<UserRow[]>('users.json', [])
      return all.find(u => u.uid === uid) ?? null
    },
    async countUsers() {
      return (await devRead<UserRow[]>('users.json', [])).length
    },
    createUser(row) {
      return withLock(async (): Promise<CreateResult> => {
        const all = await devRead<UserRow[]>('users.json', [])
        if (all.some(u => u.unameKey === row.unameKey)) return 'taken'
        if (all.length >= MAX_USERS) return 'full'
        all.push(row)
        await devWrite('users.json', all)
        return 'ok'
      })
    },
    setFail(uid, failCount, lockUntil) {
      return withLock(async () => {
        const all = await devRead<UserRow[]>('users.json', [])
        const u = all.find(x => x.uid === uid)
        if (!u) return
        u.failCount = failCount
        u.lockUntil = lockUntil
        await devWrite('users.json', all)
      })
    },
    async readColls(uid, colls) {
      const b = await devRead<Blobs>('blobs.json', {})
      const mine = Object.values(b[uid] ?? {})
      return colls?.length ? mine.filter(x => colls.includes(x.coll)) : mine
    },
    async readCollRevs(uid) {
      const b = await devRead<Blobs>('blobs.json', {})
      return Object.values(b[uid] ?? {}).map(x => ({ coll: x.coll, rev: x.rev, updatedAt: x.updatedAt }))
    },
    writeColl(uid, coll, baseRev, payload) {
      return withLock(async () => {
        const b = await devRead<Blobs>('blobs.json', {})
        const mine = b[uid] ??= {}
        const cur = mine[coll] ?? null
        const expected = cur?.rev ?? 0
        if (expected !== Math.max(0, baseRev)) return { ok: false as const, cur }
        const rev = expected + 1
        mine[coll] = { coll, rev, payload, updatedAt: Date.now() }
        await devWrite('blobs.json', b)
        return { ok: true as const, rev }
      })
    },
  }
}

// ── 出口 ────────────────────────────────────────────────────────────────────

export function getUserStore(event: H3Event): UserStore {
  const db = (event.context as any)?.cloudflare?.env?.USER_DB
  if (db) return d1Store(db)
  /*
   * 没有 D1 绑定。**只有本地开发才允许退回文件存储**，线上必须当场说清是「绑定没配」
   * ——不然报出来的是 `Dynamic require of "node:fs/promises" is not supported`，
   * 一句跟真实原因（`database_id` 没填、或者 preview 环境漏了那份绑定）毫无关系的话。
   *
   * 判据只能用 `import.meta.dev`（Nitro 在**构建时**就把它替换成常量）。
   * **不能用 `globalThis.process?.env` 来判「是不是在 Node 里」**：CF Workers 上
   * `process.env` 是存在的（一个空对象），这个判据在线上恒为真 —— 于是整条本地兜底路
   * 在线上被走通，`quota` 一本正经地回 0/5、注册 500，而日志里一句「绑定没配」都没有。
   * 这条**已经在线上踩到过一次**，别再改回运行时探测。
   */
  if (!import.meta.dev) {
    throw createError({ statusCode: 503, statusMessage: '服务端没有绑定 D1 数据库（USER_DB），账号功能暂不可用' })
  }
  return devStore()
}

/** 界面上要说清「现在存在哪」，排查「本地存进去了线上却没有」时第一个要看的就是这个 */
export function storeKind(event: H3Event): 'd1' | 'local' {
  return (event.context as any)?.cloudflare?.env?.USER_DB ? 'd1' : 'local'
}
