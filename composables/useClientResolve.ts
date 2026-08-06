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
