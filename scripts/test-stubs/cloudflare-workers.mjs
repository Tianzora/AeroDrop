// `cloudflare:workers` 在 Node 里不存在。worker 的编排测试只需要 DurableObject 基类能
// 被继承、构造时保存 ctx/env；DO 运行时能力（ctx.storage.sql / acceptWebSocket 等）
// 由测试自己注入的假 ctx 提供。
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
