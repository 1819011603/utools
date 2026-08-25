-- Cloudflare D1：账号 + 每个用户的清单数据。
--
-- 首次部署后手工执行一次：
--   npx wrangler d1 execute utools-users --remote --file=./server/db/schema.sql
-- （server/utils/userStore.ts 里也有一份 CREATE TABLE IF NOT EXISTS 的懒建表兜底，
--   两者保持一致；这份文件的价值是「表结构长什么样」有个可读的单一出处。）

CREATE TABLE IF NOT EXISTS users (
  -- crypto.randomUUID()。**不拿用户名当主键**：以后要支持改名、或者大小写归一化口径变了，
  -- 都会砸中主键，而主键是 user_blobs 的外键，砸中就等于把人的数据搞丢
  uid        TEXT PRIMARY KEY,
  -- 原样保存，只用于界面显示
  username   TEXT NOT NULL,
  -- trim + toLowerCase 之后的归一化名，登录只查这一列（唯一性也判在这一列上）
  uname_key  TEXT NOT NULL UNIQUE,
  -- 前端 PBKDF2 用的盐（32 位 hex = 16 字节）。注册时由前端生成，登录前先取回来
  salt       TEXT NOT NULL,
  -- SHA-256(前端派生结果)。**服务端只做这一次哈希**——CF 免费版每请求 10ms CPU，
  -- 做不了 PBKDF2 拉伸，拉伸放在前端（同项目里 PoW 的处置）
  pw_hash    TEXT NOT NULL,
  -- 连续失败次数与锁定截止时间：拉伸在前端做，暴力破解的成本仍在攻击者那边，
  -- 但挡一下明显的撞库总没坏处
  fail_count INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_blobs (
  uid        TEXT NOT NULL,
  -- 清单 id，取值见 composables/cloudSyncSpec.ts（服务端的白名单在 server/utils/syncColls.ts）
  coll       TEXT NOT NULL,
  -- 乐观并发：push 带上自己读到的 rev，UPDATE ... WHERE rev = baseRev 改不到行就是冲突
  rev        INTEGER NOT NULL,
  -- { v, items, tomb, clearedAt } 的 JSON。一律走 .bind() 绑定参数传进来，
  -- 绝不拼进 SQL 文本：D1 单条语句上限 100KB，而字符串/行上限是 2MB
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  -- **一个清单一行**（不是一个用户一个大 blob）：单行小、push 只发脏的那几份、
  -- 两台设备改不同清单时不会互相撞 rev
  PRIMARY KEY (uid, coll)
);
