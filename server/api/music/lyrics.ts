/**
 * 歌词查询：按「歌名 + 歌手」找一份 LRC。
 *
 * ## 为什么要单独一条链路
 *
 * 音乐站自己**两个源都不给歌词**（实测：酷我那条 `lrc` 是长度 2 的空占位、
 * 网易云那条干脆是空字符串），所以词只能另找来源。
 *
 * 走服务端而不是前端直连，理由和取址一样：这些接口没有 `ACAO`，浏览器跨域拿不到。
 *
 * ## 匹配是这条链路上唯一的难点
 *
 * 同名歌太多（翻唱、现场版、不同歌手的同名作品），只按歌名搜必然张冠李戴 ——
 * 而错的歌词比没有歌词更糟：用户会以为播放器把曲目搞混了。
 * 所以**搜到之后必须回头核对歌手**，对不上宁可返回空。
 *
 * 实现约束同 proxy.ts：不静态 import 任何 `node:*`（Nitro preset 是 cloudflare-pages）。
 */
import { musicFetch } from '../../utils/musicFetch'

const SEARCH_API = 'https://music.163.com/api/search/get'
const LYRIC_API = 'https://music.163.com/api/song/lyric'

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
 * 只要有一方包含另一方就认，够挡住「同名不同人」这个主要错配来源。
 */
function artistMatches(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const name = (query.name as string)?.trim()
  const artist = ((query.artist as string) || '').trim()

  if (!name) throw createError({ statusCode: 400, statusMessage: '缺少 name 参数' })

  // 歌名 + 歌手一起搜，比只搜歌名的候选质量高一大截
  const kw = artist ? `${name} ${artist}` : name
  const searchUrl = `${SEARCH_API}?s=${encodeURIComponent(kw)}&type=1&limit=8&offset=0`

  let songs: Array<{ id?: number; name?: string; artists?: Array<{ name?: string }> }> = []
  try {
    const res = await musicFetch(searchUrl, {
      headers: { Referer: 'https://music.163.com/', Accept: 'application/json' },
    })
    if (res.status !== 200) throw new Error(String(res.status))
    const j = JSON.parse(res.body) as { result?: { songs?: typeof songs } }
    songs = j?.result?.songs ?? []
  } catch {
    // 查不到就当没有歌词，**不抛错**：歌词是锦上添花，不该让播放界面弹一个错误出来
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { lrc: '', matched: null, reason: 'search-failed' }
  }

  /*
   * 候选打分排序，而不是「找到第一个就用」。
   *
   * 实测这个搜索接口在**版权下架的歌**上只会返回翻唱/AI 翻唱/钢琴版
   * （搜「晴天 周杰伦」8 条里没有一条是原唱），而且翻唱者常把原唱的名字
   * 拼进自己的艺名（「周杰伦-&Montagem」），单靠包含匹配必然误判。
   *
   * 所以改成打分 + 逐个试：分高的先试，谁先给出非空歌词就用谁。
   * 光排序不够 —— 排第一的那条很可能压根没上传歌词（青花瓷那次就是），
   * 不往下试就会白白空手而归。
   */
  const target = norm(name)
  const singersOf = (s: typeof songs[number]) =>
    (s.artists ?? []).map(a => a.name ?? '').filter(Boolean).join('&')

  const scored = songs
    .map((s) => {
      const sn = norm(s.name ?? '')
      if (!sn) return null
      const nameExact = sn === target
      const nameLoose = sn.includes(target) || target.includes(sn)
      if (!nameExact && !nameLoose) return null

      const singers = singersOf(s)
      if (artist && !artistMatches(singers, artist)) return null

      let score = 0
      if (nameExact) score += 4                       // 歌名一字不差最可信
      if (artist && norm(singers) === norm(artist)) score += 4   // 歌手完全相等，基本就是原版
      // 「(深情版)」「(钢琴版)」「(原唱 xxx)」这类修饰几乎都是翻唱的标记
      if (/版|原唱|翻唱|remix|cover|伴奏|纯音乐|instrumental/i.test(s.name ?? '')) score -= 3
      return { song: s, score }
    })
    .filter((x): x is { song: typeof songs[number]; score: number } => !!x)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { lrc: '', matched: null, reason: 'no-match' }
  }

  // 最多试 3 条：再往下分数已经很低，多试只是徒增请求（这类接口也会限流）
  for (const { song } of scored.slice(0, 3)) {
    if (!song.id) continue
    try {
      const res = await musicFetch(`${LYRIC_API}?id=${song.id}&lv=1&kv=1&tv=-1`, {
        headers: { Referer: 'https://music.163.com/', Accept: 'application/json' },
      })
      if (res.status !== 200) continue
      const j = JSON.parse(res.body) as { lrc?: { lyric?: string } }
      const lrc = j?.lrc?.lyric ?? ''
      if (!lrc.trim()) continue

      // 歌词是稳定内容，让浏览器缓存一天，省掉重复查询
      setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')
      /*
       * `matched` 一定要带回去给界面显示。
       * 下架歌曲多半只能匹配到翻唱版，时间轴不一定严丝合缝 ——
       * 把来源摆出来，用户自己就能判断这份词值不值得信，比我们替他打包票强。
       */
      return {
        lrc,
        matched: { name: song.name ?? '', artist: singersOf(song) },
        reason: 'ok',
      }
    } catch {
      // 单条失败就试下一条
    }
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { lrc: '', matched: null, reason: 'empty' }
})
