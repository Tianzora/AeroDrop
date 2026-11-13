# AeroDrop 下一阶段路线图

更新时间：2026-11-12
基线：`main` @ `a1cd000`（工作区干净）
现状评分：架构 8.5 / 实现 7.8，综合约 8.1

## 执行规则

- 一次只做一个阶段；完成、验证、汇报后停下，等确认再进入下一阶段。
- 新阶段开始前先读本文件与 `AGENTS.md`，并检查基线是否已变化。
- 不新增依赖，不改 `package.json` / lockfile，除非先说明理由并得到确认。
- 不在 `docs/` 以外新增说明性文件；`docs/` 不入 Git。
- 不 commit / push，除非用户明确要求。
- 每阶段结束在本文对应标题下追加一行 `状态: 完成 (commit/日期)` 或 `状态: 阻塞 (原因)`。

## 阶段 1：屏幕共享链接的身份绑定（安全）

状态: 完成 (85be089, 2026-11-12)

**问题**
`?view=<peerId>` 只是把分享者的随机 peerId 放进链接。`SignalingHub` 允许同一 peerId 的新连接覆盖旧会话（`src/worker.ts:1080-1125`，重连依赖它）。知道 peerId 的人可以注册同一 id，把分享者顶掉，导致观众全部断流。

**目标**
同一 peerId 的会话替换必须持有创建该会话时的密钥；没有密钥的替换被拒绝，且客户端不进入重连循环。

**设计**
1. `types/`：信令注册载荷增加可选 `sessionSecretHash?: string`（小写 hex，64 字符）。
2. 新增纯函数模块 `services/signaling/sessionBinding.ts`：
   - `isValidSessionSecretHash(value: unknown): value is string`
   - `shouldAcceptSessionReplacement({ existingSecretHash, incomingSecretHash }): 'allow' | 'reject'`
     - `existingSecretHash == null` → `allow`（文件传输等旧路径不受影响）
     - 两者都有且相等 → `allow`（正常重连）
     - 其余 → `reject`
   - 比较使用常量时间实现，避免把 hash 比较变成侧信道。
3. `services/peerRuntime.ts`：
   - 初始化选项增加 `sessionSecretHash?: string`，注册信封带上它。
   - 收到终态 `session-conflict` 时不重连（归入 `rejected` 状态），交给上层提示。
4. `src/worker.ts`（SignalingHub）：
   - `SessionAttachment` 保存 `sessionSecretHash`（没有就不写）。
   - 注册时若 peerId 已存在，调用 `shouldAcceptSessionReplacement`；`reject` 发送 `{ type: 'error', code: 'session-conflict' }` 后关闭连接。
5. `components/ScreenShare.tsx`：
   - 分享开始时用 `crypto.getRandomValues` 生成 32 字节随机密钥，SHA-256 后作为 `sessionSecretHash` 传给 `loadPeerRuntime`。
   - 密钥只保存在本次分享的 ref/内存中；分享结束清空。观众端与文件传输路径不传该字段。

**验收**
- 新增 `services/signaling/sessionBinding.test.ts`，覆盖 null / 相同 / 不同 / 大小写 / 非法输入。
- `services/peerRuntime.test.ts` 增加断言：提供 hash 时注册信封含该字段；`session-conflict` 不触发重连。
- 手工验证：同一 peerId 用错误 hash 注册被拒；用正确 hash 可替换；文件传输两端行为不变。
- `npm run typecheck`、`npm run test:all`、`npm run test:e2e`、`npm run test:e2e:product-transfer`、`npm run build` 全绿。

**风险**
- 重连必须复用同一个 hash（不能每次重连重新生成），否则自己会被拒绝。
- 不要让 `session-conflict` 落入通用错误重试路径，否则会出现客户端互踢。

## 阶段 2：屏幕共享 E2E（验证安全网）

状态: 完成 (c93ba9d, 2026-11-12)

**目标**
在改任何屏幕共享结构之前，先有可重复的自动化验证。

**做法**
- 新增 `e2e/screenshare.spec.ts`，Chromium 启动参数使用 fake display capture：
  `--use-fake-ui-for-media-stream`、`--auto-select-desktop-capture-source=Entire screen`、`--use-fake-device-for-media-stream`。
- 流程：分享端开始共享 → 观众打开 `?view=` 链接 → 断言 `video` 有实际帧（`getVideoPlaybackQuality().totalVideoFrames` 增长 或 `currentTime` 前进）→ 观众关闭后分享端 active viewer 归零。
- 若 CI/headless 下 `getDisplayMedia` 不可用：用 `test.skip` + 环境变量开关，并在文件头注明本地运行方式，不允许静默跳过。

**验收**
- 本地连续跑 3 次通过；`npm run test:e2e` 全绿；无新增 flaky。
- 在 `AGENTS.md` 命令段补充该用例的运行方式（如果它需要额外 flag）。

## 阶段 3：Sender 会话编排抽离（可维护性）

状态: 完成 (5f40949, 2026-11-12)

**目标**
把 `components/Sender.tsx` 里的分享会话生命周期搬到 `services/send/senderSession.ts`，组件只保留渲染与事件绑定。

**范围（只搬生命周期，不搬传输循环）**
- 口令登记/续期/延迟注销/resume、有效期计时、ICE 刷新计时、pagehide/pageshow/visibilitychange 处理、PeerRuntime 创建与销毁。
- 通过回调注入 `onNotification`、`onStateChange`、`onShareCode`，服务层不 import React。

**验收**
- `Sender.tsx` 至少减少 300 行；新增服务有单元测试（fake timers 覆盖续期、到期、暂停恢复）。
- 行为不变：现有 E2E 与 product-transfer 全绿；手工验证分享、切后台返回、到期继续传输。
- `npm run typecheck`、`npm run test:all`、`npm run test:e2e`、`npm run build` 全绿。

**风险**
- 这是纯重构，必须先有阶段 2 的屏幕共享 E2E 和现有传输 E2E 兜底；任何行为变化都回退。

## 阶段 4：规模化设计（只出设计，不写实现）

状态: 完成 (5f40949, docs/design-scale-out.md, 2026-11-13)

**目标**
回答“>6 人屏幕共享、多房间并发”怎么办，不再继续优化 mesh。

**产出**
`docs/design-scale-out.md`，包含：
- SFU 适配层接口：mesh（现有）与 SFU（Cloudflare Calls / LiveKit）如何共存，何时切换。
- DO 分片：按房间/口令哈希拆 `SignalingHub`，限流与信令解耦；迁移与兼容策略。
- TURN 成本模型：mesh 与 SFU 的 egress 对比、配额、限流。
- 明确不做的项与原因。

**验收**
- 设计文档包含现状证据（文件/行号）、两套方案的取舍、分阶段落地顺序、回滚方式。
- 不改业务代码。

## 环境注意事项

- `npm run test:e2e:product-transfer` 前确认 8787 没有残留 server。旧 `workerd` 进程会让 preview 落到 8788，而测试仍打 8787，表现为“代码明明改了但测试跑的是旧逻辑”。检查并清理：
  `netstat -ano | grep 8787`、`Get-CimInstance Win32_Process | Where-Object CommandLine -match 'wrangler|workerd'`。
- E2E 前如需 preview：`npm run preview:e2e`（:3401），跑完 kill 对应 job。
- 产品 E2E 的分享接口有同源守卫，直接 `fetch` 时必须带 `Origin` 头。

## 阶段 5：95 分加固（可测性、屏幕共享产品化、工程流水线）

目标：把安全/产品/工程三项评审从 87/82/66 推到 95。范围由用户确认：允许架构级改动，但不买付费服务、不新增依赖、不改 `package.json`。

- 安全/可测性：DO 的 SQL 状态机、准入顺序、席位、请求上下文下沉到 `services/signaling/`；修 6 条评审缺陷（静态摘要永不过期、proof 落库早于投递、接管先释放后领取、限流满表淘汰放行、XFF 回退、口令未知码无全局预算）。
- 产品：屏幕共享信令失败进终态（不再假 LIVE）、心跳豁免后台节流、16 Mbps 聚合上行预算、房号改走 `/api/share-code` 登记、错误文案归口。
- 工程：加 GitHub Actions CI；组件测试 327s → 1.13s；`Sender.tsx` 1981 → 1637 行；加「信令 4010 进终态」E2E。
- 验收：五条命令全绿；三项只读复评均 ≥ 95；生产部署后跑 product E2E 与真实信令验证。

状态: 完成 (每阶段已提交，待统一推送；2026-11-13)

## 阶段 6：第二轮复评后的补齐（2026-11-13）

对应 `docs/design-scale-out.md` §8.4：commit 自愈、分片回源 fail-closed、并发双开守卫、注册编排 plan、屏幕共享失败路径与 E2E、真实 SQLite 契约测试、CI 覆盖率与 E2E job。
状态: 完成 (第二轮复评补齐：安全 3 条 / 产品 6 条 / 工程 SQLite 契约 + 覆盖率门槛 + CI E2E，工作区未提交, 2026-11-13)
