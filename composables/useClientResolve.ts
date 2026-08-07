/**
 * 「取址作业单」的前端执行器注册表。
 *
 * 有些站点服务端做不完最后一步（算法只存在于 wasm、结果带时效签名…），
 * 会在解析结果里带一张 clientTask，由浏览器补齐 episodes 的 videoUrl。
 * 这里按 kind 分发到具体执行器——新增一种作业方式只在这张表加一行。
 */
import type { ClientResolveTask, ParsedEpisode } from './videoParseRules'

export interface ClientResolveOptions {
  onStage?: (text: string) => void
  onProgress?: (done: number, total: number) => void
}

type Executor = (task: any, episodes: ParsedEpisode[], opts: ClientResolveOptions) => Promise<void>

const EXECUTORS: Record<ClientResolveTask['kind'], Executor> = {
  'wasm-url-signer': (task, episodes, opts) => runWasmUrlSigner(task, episodes, opts),
  'html-source': (task, episodes, opts) => runHtmlSourceResolve(task, episodes, opts),
}

/**
 * 作业单里「每集一项」的那个数组叫什么——各 kind 的字段名不同，但语义相同：
 * 下标必须与 episodes 严格对齐，切片时要连它一起切。
 */
const ITEMS_KEY: Record<ClientResolveTask['kind'], 'argsList' | 'pageUrls'> = {
  'wasm-url-signer': 'argsList',
  'html-source': 'pageUrls',
}

export async function runClientResolve(
  task: ClientResolveTask,
  episodes: ParsedEpisode[],
  opts: ClientResolveOptions = {},
) {
  const run = EXECUTORS[task.kind]
  // 认不出来就明说：静默跳过会表现成「解析成功但一集都播不了」，极难排查
  if (!run) throw new Error(`不支持的取址方式：${task.kind}，请更新页面后重试`)
  await run(task, episodes, opts)
}

/** 只保留选中下标的作业单，用于按需取址（task.lazy）时一次只做一集 */
export function sliceClientTask(task: ClientResolveTask, indices: number[]): ClientResolveTask {
  const key = ITEMS_KEY[task.kind]
  const items = (task as any)[key] as unknown[] | undefined
  return { ...task, [key]: indices.map(i => items?.[i]).filter(Boolean) } as ClientResolveTask
}

/**
 * 取单集地址。按需取址的站点（task.lazy）在真正要播那一集时才调这个。
 * 拿不到就抛错——调用方要把原因显示出来，静默失败会表现成「点了没反应」。
 */
export async function resolveOneUrl(task: ClientResolveTask, index: number): Promise<string> {
  const items = (task as any)[ITEMS_KEY[task.kind]] as unknown[] | undefined
  if (!items?.[index]) throw new Error('这一集没有取址参数，请重新解析')
  const ep: ParsedEpisode = { title: '', pageUrl: '' }
  await runClientResolve(sliceClientTask(task, [index]), [ep])
  if (!ep.videoUrl) throw new Error(ep.error || '未取到播放地址')
  return ep.videoUrl
}
