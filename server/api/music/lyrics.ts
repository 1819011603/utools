/**
 * 歌词查询：按「歌名 + 歌手（+ 时长）」找一份 LRC。
 *
 * ## 为什么要单独一条链路
 *
 * 音乐源自己基本都不给词：24bit 两个源一个是长度 2 的空占位、一个是空串；
 * fangpi 只有站点自报 `lrc_is_empty === false` 的那部分有内嵌歌词，实测大多数热门歌都是空的
 * （容器里躺着一行「该歌曲暂无歌词」）。所以词只能另找来源。
 *
 * 走服务端而不是前端直连，理由和取址一样：这些接口没有 `ACAO`，浏览器跨域拿不到。
 *
 * ## 为什么是「QQ 音乐优先、网易云兜底」
 *
 * 原来只查网易云，结果是**几乎一首都查不到**，两个原因叠在一起：
 *
 *   ① 老接口 `/api/search/get` **已经废了**：不报错、照常回 200 和结构完整的 JSON，
 *      内容却与关键词毫无关系（实测搜「青花瓷」回来一串叫「28」的歌，
 *      搜「青花瓷 周杰伦」回来的是「66」）。链路上没有任何一处会报错，
 *      表现就是每首歌都「暂无歌词」。换 `cloudsearch/pc` 才回真结果。
 *   ② 就算换了接口，**网易云那边华语热门几乎全下架**，搜到的只剩 AI 翻唱
 *      （「周杰伦-&Montagem」这种把原唱名字拼进艺名的账号）。这批条目要么没上传歌词，
 *      要么上传的是**另一首歌的词**——实测「青花瓷」拿回来的是「烈风卷旧梦，往事在翻涌」。
 *      而错的歌词比没有歌词更糟：用户会以为播放器把曲目搞混了。
 *
 * QQ 音乐手里有正版曲库，同样搜「青花瓷」第一条就是周杰伦那首（时长 239s，与音源对得上）。
 * 所以先问它，它没有再退回网易云——网易云对**冷门 / 独立音乐人**的覆盖仍然比 QQ 好。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { musicFetch } from '../../utils/musicFetch'

/** 一条候选。两个源的字段名完全不同，先归一化成这个形状再打分，打分逻辑就只用写一遍 */
interface Candidate {
  provider: 'qq' | 'netease'
  key: string
  name: string
  artist: string
  /** 秒。**只有 QQ 给**，用来在同名歌里挑出与音源对得上的那一首 */
  duration?: number
}

/** 网易云给纯音乐 / 未填词的占位，它们不是歌词 —— 收下就等于把后面真有词的候选挡掉了 */
const NOT_LYRIC = /纯音乐[，,]?\s*请欣赏|此歌曲为没有填词的纯音乐|该歌曲暂无歌词/

const QQ_HEADERS = { Referer: 'https://y.qq.com/', Accept: 'application/json' }
const NETEASE_HEADERS = { Referer: 'https://music.163.com/', Accept: 'application/json' }

/** 归一化后比对：大小写、空格、各种括号里的补充说明都不该影响判断 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, '')   // 去掉 (Live) / (原唱 xxx) 这类后缀
    .replace(/[\s\-_·・,，&＆/]+/g, '')
    .trim()
}

/**
 * 歌手是否对得上。
 *
 * 用**双向包含**而不是相等：合唱曲在两边的写法常常不一致
 * （一边「蔡依林&周杰伦」、另一边只写「蔡依林」），要求完全相等会把大量正确匹配丢掉。
 */
function artistMatches(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

/** 拿到手的这份到底算不算歌词。空的、占位的、只有元数据标签没有正文的都不算 */
function isRealLyric(lrc: string): boolean {
  const t = lrc.trim()
  if (t.length < 20) return false
  if (NOT_LYRIC.test(t)) return false
  // 剥掉 [ti:]/[ar:]/[al:]/[by:]/[offset:] 之后还得有正文
  return t.split(/\r?\n/).some(l => l.trim() && !/^\[(ti|ar|al|by|offset|re|ve|length|kana):/i.test(l.trim()))
}

const readJson = async (url: string, headers: Record<string, string>): Promise<any> => {
  try {
    const res = await musicFetch(url, { headers })
    if (res.status !== 200) return null
    return JSON.parse(res.body)
  } catch {
    // 查不到就当没有歌词，**一律不抛错**：歌词是锦上添花，不该让播放界面弹一个错误出来
    return null
  }
}

// ── QQ 音乐 ──

async function searchQQ(kw: string): Promise<Candidate[]> {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=10&w=${encodeURIComponent(kw)}`
  const j = await readJson(url, QQ_HEADERS)
  const list: any[] = j?.data?.song?.list ?? []
  return list
    .filter(s => s?.songmid)
    .map(s => ({
      provider: 'qq' as const,
      key: String(s.songmid),
      name: String(s.songname ?? ''),
      artist: (s.singer ?? []).map((x: any) => x?.name ?? '').filter(Boolean).join('&'),
      // `interval` 就是秒，QQ 少见地直接给了 —— 同名歌里它是最硬的判据
      duration: typeof s.interval === 'number' ? s.interval : undefined,
    }))
}

/** `nobase64=1` 直接拿明文，省掉一次 base64 解码（Workers 上没有 `Buffer`，少一处麻烦） */
async function lyricQQ(mid: string): Promise<string> {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`
  const j = await readJson(url, { ...QQ_HEADERS, Referer: 'https://y.qq.com/portal/player.html' })
  return typeof j?.lyric === 'string' ? j.lyric : ''
}

// ── 网易云 ──

async function searchNetease(kw: string): Promise<Candidate[]> {
  // 必须是 `cloudsearch/pc`，老的 `search/get` 已经回垃圾了（见文件头）。
  // 字段名两代也不一样：老的是 `artists`，这个是 `ar`
  const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(kw)}&type=1&limit=12&offset=0`
  const j = await readJson(url, NETEASE_HEADERS)
  const list: any[] = j?.result?.songs ?? []
  return list
    .filter(s => s?.id)
    .map(s => ({
      provider: 'netease' as const,
      key: String(s.id),
      name: String(s.name ?? ''),
      artist: (s.ar ?? s.artists ?? []).map((x: any) => x?.name ?? '').filter(Boolean).join('&'),
      duration: typeof s.dt === 'number' ? Math.round(s.dt / 1000) : undefined,
    }))
}

async function lyricNetease(id: string): Promise<string> {
  const j = await readJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`, NETEASE_HEADERS)
  return typeof j?.lrc?.lyric === 'string' ? j.lrc.lyric : ''
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const name = (query.name as string)?.trim()
  const artist = ((query.artist as string) || '').trim()
  /** 音源那边的时长（秒）。**同名歌太多时它是最硬的判据**，有就用，没有也能凑合 */
  const duration = Number(query.duration) || 0

  if (!name) throw createError({ statusCode: 400, statusMessage: '缺少 name 参数' })

  const target = norm(name)

  /**
   * 候选打分，**不是「找到第一个就用」**。返回 null = 直接淘汰。
   *
   * 歌手对不上不一律淘汰，但**要求歌名一字不差**：下架歌在网易云只剩翻唱，
   * 唯一上传了完整歌词的那位常常跟原唱毫无关系，一刀切掉等于把唯一能用的也切了。
   * 代价是可能拿到同名不同曲的词 —— 所以 `matched` 会原样显示在界面上
   * （「匹配自：阿杰」），用户一眼能判断这份词信不信得过。
   */
  const scoreOf = (c: Candidate): number | null => {
    const sn = norm(c.name)
    if (!sn) return null
    const nameExact = sn === target
    const nameLoose = sn.includes(target) || target.includes(sn)
    if (!nameExact && !nameLoose) return null

    const artistOk = !artist || artistMatches(c.artist, artist)
    if (!artistOk && !nameExact) return null

    let score = 0
    if (nameExact) score += 4                                  // 歌名一字不差最可信
    if (artistOk) score += 5                                   // 对得上的一律排在对不上的前面
    if (artist && norm(c.artist) === norm(artist)) score += 4   // 完全相等，基本就是原版
    /*
     * 时长对得上加重分：同名翻唱一大片时，「和我要播的这个文件一样长」几乎就等于同一首。
     * 差得离谱要扣分，但**没有时长信息时一分不动** —— 那是「不知道」，不是「不对」。
     */
    if (duration && c.duration) {
      const diff = Math.abs(duration - c.duration)
      if (diff <= 3) score += 6
      else if (diff <= 10) score += 2
      else if (diff > 30) score -= 4
    }
    // 「(深情版)」「(钢琴版)」「(原唱 xxx)」这类修饰几乎都是翻唱的标记
    if (/版|原唱|翻唱|remix|cover|伴奏|纯音乐|instrumental/i.test(c.name)) score -= 3
    return score
  }

  /**
   * 在一个源里把词找出来。找不到返回 null，交给下一个源。
   *
   * 搜两轮（「歌名 + 歌手」和单搜歌名）是因为**下架歌上这两轮的结果几乎不重叠**：
   * 带歌手搜回来的全是把原唱名字拼进艺名的 AI 翻唱，而那批普遍没上传歌词；
   * 真正带完整时间轴的那份常常挂在一个跟原唱无关的名字下。少搜一轮就是「候选一堆、词一个没有」。
   */
  const tryProvider = async (
    search: (kw: string) => Promise<Candidate[]>,
    fetchLyric: (key: string) => Promise<string>,
  ) => {
    const seen = new Set<string>()
    const pool: Candidate[] = []
    for (const kw of artist ? [`${name} ${artist}`, name] : [name]) {
      for (const c of await search(kw)) {
        if (seen.has(c.key)) continue
        seen.add(c.key)
        pool.push(c)
      }
    }

    const scored = pool
      .map(c => ({ c, score: scoreOf(c) }))
      .filter((x): x is { c: Candidate; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)

    /*
     * 最多试 6 条。**AI 翻唱那批普遍是「有条目、没歌词」**，
     * 分数最高的前几条经常连着空手而归，试少了等于没查。
     */
    for (const { c } of scored.slice(0, 6)) {
      const lrc = await fetchLyric(c.key)
      if (!isRealLyric(lrc)) continue
      return { lrc, matched: { name: c.name, artist: c.artist } }
    }
    return null
  }

  // QQ 优先（正版曲库），它没有再退网易云（冷门 / 独立音乐人那边覆盖更好）
  const hit = await tryProvider(searchQQ, lyricQQ)
    ?? await tryProvider(searchNetease, lyricNetease)

  if (!hit) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { lrc: '', matched: null, reason: 'no-match' }
  }

  // 歌词是稳定内容，让浏览器缓存一天，省掉重复查询
  setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')
  /*
   * `matched` 一定要带回去给界面显示：匹配到的可能是翻唱版，时间轴不一定严丝合缝。
   * 把来源摆出来，用户自己就能判断这份词值不值得信，比我们替他打包票强。
   */
  return { ...hit, reason: 'ok' }
})
