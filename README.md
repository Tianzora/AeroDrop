# AeroDrop

轻量级 WebRTC 文件传输与屏幕共享应用。默认优先端对端（P2P），不可达时回退 TURN 中继。

## Features

- 文件传输：6 位口令 / 分享链接连接，支持多文件与文件夹
- 屏幕共享：跨设备实时观看
- 跨平台：现代浏览器即开即用
- 安全：数据不经业务服务器落盘

## Connection Modes

- `直连`：同内网或可直接互通，通常最快  
- `点对点`：跨网络 P2P，速度通常优于中继  
- `中继（速度会变慢）`：TURN 转发，成功率更高

## Quick Start

```bash
npm install
npm run dev
npm run dev:worker
```

Build:

```bash
npm run build
```

## Deploy

Cloudflare Worker:

```bash
npm run deploy
```

## Signaling

项目已从 PeerJS 默认信令迁移为 **Cloudflare Worker + Durable Object + WebSocket** 自管信令。

生产环境下前端默认连接当前站点同源的：

- `wss://<your-domain>/ws-signaling`

Worker 会把该 WebSocket 请求转发到 `SignalingHub` Durable Object，由它负责：

- 注册 `peerId`（发送方必须带口令与 token，DO 用 HMAC 校验绑定关系）
- 拒绝重复 `peerId`、按来源 IP 限制并发与消息速率
- 转发 `offer / answer / ice-candidate`

### 分享口令（Share code）

口令**不再是信令身份**，而是服务端签发的一次性登记号：

| 端点 | 作用 |
|---|---|
| `POST /api/share-code` `{peerId, secretHash}` | 生成 6 位数字口令，与随机 `peerId` 绑定（TTL 1 小时） |
| `GET /api/share-code?code=NNNNNN` | 用口令兑换 `peerId`（限流 30 次/10 秒/IP） |
| `POST /api/share-code/<code>/revoke` | 发送方结束分享时注销 |

发送方生成随机 `peerId` 与 secret，用 `HMAC(secret, peerId)` 登记；接收方只拿口令换 `peerId`。
这样「一个脚本占满 9000 个码」的老问题不再成立（口令无法被客户端抢注，且不能枚举 `peerId`）。
口令一律 6 位；发送方手填的自定义口令也走同一登记流程（被占用会明确报错，不会悄悄换码）。

本地开发建议同时启动：

```bash
npm run dev
npm run dev:worker
```

其中：

- Vite 默认在 `http://127.0.0.1:3000`
- Wrangler 默认在 `http://127.0.0.1:8787`
- `vite.config.ts` 已代理 `/api` 和 `/ws-signaling` 到本地 Worker

可选前端环境变量：

- `VITE_SIGNALING_WS_URL`
- `VITE_SIGNALING_BASE_URL`
- `VITE_SIGNALING_PATH`

## TURN Configuration (Recommended)

可配置自管 coturn 作为 Cloudflare TURN 不可用时的后备。Worker 使用 TURN REST HMAC-SHA1 生成短期凭证：

- `TURN_URLS`：逗号或换行分隔的 `turn:` / `turns:` 地址
- `TURN_SHARED_SECRET`：coturn `static-auth-secret`，必须保存为 Worker Secret
- `TURN_REALM`：与 coturn `realm` 保持一致
- `TURN_TTL_SECONDS`：可选，默认 `3600`，有效范围 `60`–`86400`

示例：

```bash
npx wrangler secret put TURN_SHARED_SECRET
```

生产默认优先使用 Cloudflare 官方 TURN 短期凭证模式：

- `CF_TURN_TOKEN_ID`
- `CF_TURN_API_TOKEN`
- `CF_TURN_TTL_SECONDS` 可选，默认 `3600`

注意：

- 如果这些值是在 Cloudflare Dashboard 里手动添加的，`wrangler deploy` 默认会以下发配置为准覆盖远端变量。
- 本项目已在 [`wrangler.jsonc`](./wrangler.jsonc) 中启用 `keep_vars = true` 对应的 `keep_vars: true`，用于保留 Dashboard 上已有的变量。
- `TURN_SHARED_SECRET` 和 `CF_TURN_API_TOKEN` 属于敏感值，必须以 Secret 方式保存；Cloudflare Secrets 不会在普通 `wrangler deploy` 时被删除。

Worker 会按照 Cloudflare 官方方式，在服务端调用：

```text
POST https://rtc.live.cloudflare.com/v1/turn/keys/<CF_TURN_TOKEN_ID>/credentials/generate-ice-servers
```

凭证优先级为：Cloudflare TURN、自管 TURN、内置 STUN-only。文件仍通过 WebRTC DataChannel 传输，Worker 仅下发短期 ICE 配置，不接收文件数据。ICE policy 保持 `all`，TURN 只作为 P2P 不可用时的候选路线。

当前生产 ICE 配置会过滤 TURN/UDP，仅保留 TURN/TCP 与 TURN/TLS。P2P 的 UDP 直连候选不受影响。该限制用于规避已在多个 TURN 提供者上复现的外部 UDP relay 长时间停滞。

## Diagnostics

诊断日志默认关闭，`logDebug` 在未开启时直接 return（`services/diagnostics.ts`），所以控制台默认一条都看不到。开启方式二选一：

- URL 带 `?debugLogs=1`，例如 `https://<domain>/?debugLogs=1`
- 或在控制台执行 `localStorage.setItem('aerodrop_debug_logs','1')` 后刷新（关掉用 `removeItem`）

开启后在浏览器控制台过滤 `conn-metrics`，可查看：

- 首连耗时（`firstConnectMs`）
- 重试次数（`retries`）
- ICE 路径（host/srflx/relay，udp/tcp，LAN/WAN）

## Testing

- `npm run typecheck` 同时检查应用源码与 `e2e/`（`tsconfig.json` + `tsconfig.e2e.json`）。
- `npm run test:services` / `npm run test:components` / `npm run test:scripts`，或 `npm run test:all` 一次跑完全部 Node 测试。
- `npm run test:e2e` 用 `vite build --mode e2e` 构建后再跑 Playwright：只有该模式会编译 E2E 测试钩子（`services/e2eHooks.ts`），生产构建里 `__AERODROP_E2E__` 不生效。
- `e2e/rtc-datachannel.spec.ts`（`npm run test:e2e:rtc`）是**浏览器能力基准**：它直接开原生 `RTCPeerConnection` 测吞吐与中继矩阵，不加载应用、不覆盖产品代码，缺 TURN 变量时会 skip。产品链路以 `e2e/product-transfer.spec.ts` 为准。

## Project Structure

```text
components/      UI 层（Receiver/Sender/ScreenShare 与 .tsx 子组件）
constants/       传输常量（TRANSFER_CONFIG、FLOW_CONTROL 等）
e2e/             Playwright 用例与页面内测试夹具
public/          静态资源、PWA manifest、StreamSaver 的 sw.js / mitm.html
scripts/         Node 测试收集与执行入口（node-test-args.mjs / run-node-tests.mjs）
services/        协议、连接与降级策略、收发与持久化、TURN/诊断
src/worker.ts    Worker 入口（API + 信令 + Durable Object + 静态资源）
types/           协议与共享类型（P2P_PROTOCOL_VERSION 在此）
```

## License

MIT
