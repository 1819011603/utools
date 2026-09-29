import type { ParsedEpisode, ParseResult } from '~/composables/videoParseRules'
import type { useVideoParseResolve } from '~/composables/useVideoParseResolve'

/**
 * 内嵌线路（只能用站点自带播放器播）的 UI 状态：iframe 地址与选集、限制广告开关、
 * 全屏入口与 Enter 快捷键，以及选集格子的可点/点击/悬浮文案。
 * 依赖 useVideoParseResolve 的共享上下文，并通过 requestPlay 复用「播放前确认」那条路。
 */
export function useVideoParseEmbed(
  vp: ReturnType<typeof useVideoParseResolve>,
  requestPlay: (startIndex?: number) => void,
) {
  const toast = useToast()
  const { result, currentLine, busy, userRules, isLazy, embedSrc, embedIndex } = vp

  // ── 内嵌线路（只能用站点自带的解析播放器播，见 ParseResult.embedUrl）──
  // 这条线路一个视频地址都没有，所以上面那些按 videoUrl 算的计数在这里全是 0，
  // 界面得整块换成「内嵌 iframe + 点选集换 src」
  const isEmbedLine = computed(() => !!result.value?.embedUrl)

  /**
   * 内嵌框的 sandbox，由「限制广告」开关控制，**默认关**。
   *
   * 挂上它能挡住这些解析站最恶心的那一手——广告脚本拿到顶层跳转能力，
   * 点一下画面整页被劫走，用户只会以为是本站跳的。但**它同时会让一部分线路彻底播不了**，
   * 而这一整块 UI 的存在意义就是「能播」，所以默认让位给可用性，把选择权做成开关摆在旁边。
   *
   * 挂上时给的两个 token 是被播放器的反内嵌自检逼出来的：
   * · allow-popups ← 超清AB线（abyssplayer）点遮罩要 `window.open(广告页)` 连续成功两次，
   *   失败两次就 document.write 掉播放器。**故意不给** allow-popups-to-escape-sandbox：
   *   弹出窗继承同一套限制，落地页的二次跳转/自动下载仍被关着
   * · allow-same-origin 是播放器读自己存储和接口的前提，跨域 iframe 给它不影响本页安全
   *
   * 而**有的播放器探的是 sandbox 属性本身**（超清EV线 ezplayer：`document.domain = document.domain`
   * 在沙箱文档里必抛 SecurityError，一抛就报 `Opss! Sandboxed our player is not allowed`）。
   * 这种加什么 token 都没用——规范里的「sandboxed document.domain flag」只要挂了 sandbox 就必然置位，
   * **没有任何 token 能取消**（`allow-document-domain` 不是合法 token，写上去只会被静默忽略，
   * 表现和没改一模一样，别再往这个方向试了）。这类线路只能整个摘掉属性，也就是关掉这个开关。
   */
  const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups'
  const EMBED_SANDBOX_KEY = 'video-parse-embed-sandbox'
  // 记住选择：开关是「每次都得重设一遍」的话，等于每换一集就要再点一次
  const embedSandbox = ref(false)
  const embedPending = ref(-1)   // 正在现取第几集的内嵌地址，-1 = 空闲

  // ── 内嵌播放器全屏 ──
  // 站点自带播放器的全屏按钮埋在它自己的控制栏里（有的还被广告遮住），给一个我们这边的入口。
  // 退出不用管：Esc 由浏览器自己处理，我们只跟着 fullscreenchange 同步样式
  const embedStage = ref<HTMLElement | null>(null)
  const isEmbedFullscreen = ref(false)

  const toggleEmbedFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    // 用户手势之外调用会被拒（如从 setTimeout 里），静默吞掉即可
    embedStage.value?.requestFullscreen?.().catch(() => {})
  }

  const onFullscreenChange = () => {
    isEmbedFullscreen.value = !!document.fullscreenElement && document.fullscreenElement === embedStage.value
  }

  /**
   * Enter 全屏。**必须放掉输入框里的 Enter**——地址输入框自己绑了 Enter 触发解析，
   * 抢过来的话用户敲回车会变成全屏，解析反而没了。
   *
   * 已知边界：焦点一旦落进播放器（点了画面），按键就归那个跨域 iframe 了，
   * 我们这层收不到任何 keydown，这是浏览器的安全边界，没有绕法。
   * 所以按钮上的 tooltip 写清「点一下播放器外面即可恢复」，
   * 否则用户只会觉得快捷键时灵时不灵。
   */
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey) return
    if (!isEmbedLine.value || !embedSrc.value) return
    const el = e.target as HTMLElement | null
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
    e.preventDefault()
    toggleEmbedFullscreen()
  }

  /**
   * 选集格子的三件事：能不能点、点了干什么、悬浮说什么。
   *
   * 三种线路（直链 / 按需取址 / 内嵌）语义各不相同，写成内联三元没法看：
   * · 内嵌线路每一集都能点（地址点了才现取）
   * · 按需取址同理，**不能按 `videoUrl` 判**——列表里存的是占位地址
   * · 只有普通直链线路才是「没解析出地址就点不动」
   */
  const epPlayable = (ep: ParsedEpisode) =>
    isEmbedLine.value || isLazy.value || !!ep.videoUrl

  const epClick = (ep: ParsedEpisode, i: number) => {
    if (busy.value || !epPlayable(ep)) return   // disabled 之外再兜一道：键盘回车也会触发 click
    // 内嵌线路换的是上面那个 iframe 的 src，不去播放器
    if (isEmbedLine.value) void playEmbed(i)
    else requestPlay(i)
  }

  const epTip = (ep: ParsedEpisode, i: number) => {
    const name = ep.title || `第 ${i + 1} 集`
    if (isEmbedLine.value) return `${name} · ${i === embedIndex.value ? '正在内嵌播放' : '点一下在上面的内嵌播放器里播'}`
    if (ep.videoUrl) return `${name} · ${ep.videoUrl}`   // 右键能复制的就是这条
    if (ep.error) return `${name} · ${ep.error}`
    return `${name} · ${isLazy.value ? '播放时现取地址' : '未解析出地址'}`
  }

  /**
   * 内嵌播这一集。地址是**每集一份**、写在各自的播放页上，只能现取
   * （服务端 only=1 只解析这一集、不碰选集表）。取过就留在 ep 上，再点不重取。
   *
   * 取址那一发要打源站、常要好几秒，期间**不能把别的集按住**：原来在等待中的那集之外
   * 全部 disabled，用户看到的就是「整排突然置灰、点不动了」，只会以为页面坏了（实测被问过）。
   * 现在改成后点的作废先点的——用自增序号认领结果，回来时序号已变就整个丢掉
   * （包括错误提示：那是上一次点击的事，弹出来只会误导）。
   */
  let embedSeq = 0

  const playEmbed = async (i: number) => {
    const ep = currentLine.value?.episodes[i]
    if (!ep || busy.value) return
    const seq = ++embedSeq

    if (!ep.embedUrl) {
      embedPending.value = i
      // 先清掉上一集，否则等待期间画面还停在上一集，看着像点了没反应
      embedSrc.value = ''
      embedIndex.value = -1
      try {
        const res = await $fetch<ParseResult>('/api/resolve', {
          query: {
            step: 'extract',
            url: ep.pageUrl,
            only: '1',
            ...(userRules.value.length ? { rules: JSON.stringify(userRules.value) } : {}),
          },
        })
        if (seq !== embedSeq) return
        ep.embedUrl = res?.embedUrl
      } catch (e: any) {
        if (seq !== embedSeq) return
        toast.add({
          title: '取这一集的播放地址失败',
          description: e?.statusMessage || e?.data?.statusMessage || e?.message,
          color: 'red',
        })
      } finally {
        // 已被后来的点击接管时不能碰它，否则会把那一次的转圈图标提前抹掉
        if (seq === embedSeq) embedPending.value = -1
      }
    }

    if (!ep.embedUrl) {
      toast.add({ title: '这一集没给出播放地址', description: '换一集或换一条线路试试', color: 'orange' })
      return
    }
    embedIndex.value = i
    embedSrc.value = ep.embedUrl
  }

  watch(embedSandbox, v => {
    try { localStorage.setItem(EMBED_SANDBOX_KEY, v ? '1' : '0') } catch { /* 隐私模式下写不了，无所谓 */ }
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    embedSandbox.value = localStorage.getItem(EMBED_SANDBOX_KEY) === '1'
  })

  return {
    isEmbedLine, embedSrc, embedIndex, embedSandbox, embedPending, EMBED_SANDBOX,
    embedStage, isEmbedFullscreen, toggleEmbedFullscreen, epPlayable, epClick, epTip, playEmbed,
  }
}
