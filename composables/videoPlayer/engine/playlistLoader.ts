/**
 * hls.js 的自定义 playlist loader（`pLoader`）：把可达性探测**刚刚下载过**的那份 m3u8
 * 直接交给 hls.js，省掉它重拉一遍的那个 RTT。
 *
 * 从 useVideoEngine 拆出来（那边超了 500 行）。内部实现模块，走显式相对 import。
 */

/** 取一份还能用的原文；`finalUrl` 是重定向之后的地址，见下面的说明 */
export type TakeSeededManifest = (url: string) => { text: string; finalUrl: string } | null

/**
 * 自定义 playlist loader：hls.js 第一次要 manifest 时，如果**刚刚**的可达性探测已经
 * 拉过同一个 URL，就把那份原文同步交给它，省掉一次 RTT。
 *
 * 为什么值得做：探测为了数分片本来就把 m3u8 整个 body 读完了，紧接着 hls.js 又去拉同一个地址。
 * 代理通道靠浏览器 HTTP 缓存能命中（/api/proxy 对点播 m3u8 发 1 天缓存头），
 * 但**直连通道多数 CDN 的 m3u8 是 no-cache**——那一发就是白等，而它正卡在切集的关键路径上。
 *
 * 按**完整 URL** 严格匹配，对不上就老实走网络：探测的 manifest URL 恒带 `noseg=1`，
 * 而真正加载时只有 manifestOnly 才带，两者不同就说明内容不同（服务端会不会重写分片 URI），
 * 喂错了会让 hls.js 拿到一份分片指向错地方的清单。宁可 miss。
 * 一次性：用掉即清，避免播到一半 hls.js 重载 level 时拿到一份陈旧清单。
 *
 * **回调必须延到下一个宏任务，绝不能同步回**。同步回等于在 `loadSource()` 这一行之内
 * 把 MANIFEST_LOADED / MANIFEST_PARSED 全派发完，而此时 `attachMedia` 建的 MediaSource
 * 还没等到异步的 `sourceopen`（MEDIA_ATTACHED 尚未派发）——hls.js 从这个状态起步会
 * 「分片一个接一个 200、缓冲恒 0、画面一直转圈」（实测 A/B 确认：关掉复用立刻能播）。
 * 让它像一个「快得离谱的网络请求」那样异步返回，行为就和原来完全一致，
 * 而省下的是一整个 RTT（几十到几百毫秒），一个宏任务的代价可以忽略。
 */
export function createPlaylistLoaderFactory(takeSeededManifest: TakeSeededManifest) {
    return (BaseLoader: any) => {
    return class ProbeSeededPlaylistLoader extends BaseLoader {
      private seedTimer: ReturnType<typeof setTimeout> | null = null

      load(context: any, config: any, callbacks: any): void {
        const seeded = takeSeededManifest(context?.url)
        if (!seeded) { super.load(context, config, callbacks); return }
        const t = performance.now()
        this.seedTimer = setTimeout(() => {
          this.seedTimer = null
          if (this.stats?.aborted) return
          const stats = this.stats ?? {}
          // hls.js 只读这几个字段来算带宽/耗时；给一个自洽的最小集即可
          stats.loading = { start: t, first: performance.now(), end: performance.now() }
          stats.parsing = { start: 0, end: 0 }
          stats.loaded = stats.total = seeded.text.length
          stats.retry = 0
          stats.chunkCount = 1
          console.log('用探测已下载的 manifest，省掉一次请求:', context.url)
          // **url 必须是重定向后的最终地址**：hls.js 用它当基准还原清单里的相对分片 URI。
          // 给请求地址的话，会 302 的源（实测 ncat22：.195:21306 → .194:11306，换 IP 换端口）
          // 会把分片指到错的机器上——分片全 200，但解码持续失败（踩过）
          callbacks.onSuccess({ data: seeded.text, url: seeded.finalUrl }, stats, context, null)
        }, 0)
      }

      abort(): void {
        if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = null }
        super.abort()
      }

      destroy(): void {
        if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = null }
        super.destroy()
      }
    }
  }
}
