// `m3u8-parser` 是 videojs 的 CJS 包，不带类型声明。只声明本仓库用到的那几个成员，
// 避免 tsc 报 TS7016（`npm run build` 不受影响，是独立跑 tsc 时才暴露）。
declare module 'm3u8-parser' {
  export class Parser {
    constructor(opts?: Record<string, unknown>)
    push(chunk: string): void
    end(): void
    manifest: any
  }
}
