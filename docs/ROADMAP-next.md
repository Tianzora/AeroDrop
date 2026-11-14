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

对应 `docs/design-scale-out.md` §8.4：commit 自愈、分片回源 fail-closed、并发双开守卫、注册编排 plan、屏幕共享失败路径与 E2E、真实 SQLite 契约测试、CI 覆盖率守卫与浏览器侧 E2E。

CI 覆盖范围（**当时（阶段 6）的结构**）：`verify`（typecheck + 单测 + 两个 scope 的覆盖率分母守卫 + build）、`e2e`（chromium，只跑 sender-sharing / receiver-recovery）、`e2e-product`（真实 `wrangler dev` + workerd，跑 product-transfer 3 条与 screenshare 9 条）。后续变化：阶段 10 起组件门禁拆成独立的 `coverage-components` job（不进 `verify`），screenshare 用例增至 10 条——当前结构见 `.github/workflows/ci.yml`。局限：CI 只在 push/PR 上跑，**不拦 Cloudflare Git 集成的部署**——推 main 仍会直接构建发布，CI 红不阻止上线，除非在 GitHub 分支保护里把这几个 job 设为必需检查。
状态: 完成 (第二轮复评补齐：安全 3 条 / 产品 6 条 / 工程 SQLite 契约 + 覆盖率门槛 + CI E2E, 2026-11-13)

## 阶段 7：第三轮复评（95 分循环）后的收口（2026-11-14）

对应 `docs/design-scale-out.md` §8.5–§8.9。多轮只读复评（安全/产品/工程各三轮）发现的缺口逐轮收口：
名额账本的归属与 fail-closed（三态 reserve、条件释放、孤儿回收）、口令重登记的原子性（先插后删）、
WS 凭证移出 URL query（`Sec-WebSocket-Protocol`）、读路径不再写库、offer 限流配额与
`retryAfterMs`/`limit` 端到端、观众侧限流/满员/死链三种终态的归因、
组件覆盖率分母守卫（路径匹配 + 同名遮蔽 + self-test）、真实 `wrangler dev` 的 `e2e-product` job。

状态: 完成 (第三轮复评 must-fix 全部收口；复评待跑, 2026-11-14)

## 阶段 8：第九轮复评后的收口（2026-11-14）

对应 `docs/design-scale-out.md` §8.11。三项复评（安全 86 / 产品 92 / 工程 85）的 must-fix 逐条收口：

- 安全：名额归属从 `clientKey`（出口 IP，同一 NAT 下会撞车）改为每连接唯一的 `release_token`，接管走 `replaces` 让出旧行，并发接管后只留一条活名额。
- 产品：分享端重建窗口不再被判死链（3s 有限重试 + 语气诚实的终态文案）、重开共享前释放旧采集、观看中信令错误不再落不可关闭红条、429 冷却不可被「关闭」按钮绕过。
- 工程：组件覆盖率门槛改为只按 scope 内行判定、`sessionCoordinator` 移出白名单并补 18 条单测、信令基址惰性化让组件可在 Node import、E2E 失败留 trace/screenshot 并在 CI 上传、CI 下采集探测失败必须红、删掉 product-transfer 里 inert 的 TURN 注入。

状态: 完成 (第九轮复评 must-fix 全部收口；门禁全绿，待推送与复评, 2026-11-14)

## 阶段 9：第十轮复评后的收口（2026-11-14）

对应 `docs/design-scale-out.md` §8.12。三项复评（安全 90 / 产品 82 / 工程 90）的 must-fix 逐条收口：

- 安全：接管路径的孤儿名额回收无条件化（旧 `if (!isTakeover)` 是照抄「接管复用旧 slotId」的旧假设），并把两条空断言改成真的（`replaces` 指向真实存在但 token 不符的行；release 去掉 token 条件必须红）。
- 产品：观众侧「有限重试」预算不再被自动重试清零（此前永远停在「正在连接」，每 3s 一轮注册+offer），冷却到期归零、live region、三处裸 `track.stop()` 统一走 `releaseCapturedStream`。
- 工程：白名单机械上限（条目数 + 被排除行数占比）、两条空的自测 fixture 改成真断言、白名单理由改真话、`e2e`/`e2e-product` 依赖 `verify` 且组件门禁独立成 job。

状态: 完成 (第十轮复评 must-fix 全部收口；门禁全绿，待推送与复评, 2026-11-14)

## 阶段 10：第十一轮复评后的收口（2026-11-14）

对应 `docs/design-scale-out.md` §8.13。三项复评（安全 91 / 产品 91 / 工程 91）的 must-fix 逐条收口：

- 安全：`replaces` 抵扣必须校验被顶替行属于同一出口（否则 12 会话上限变 13）；三处仍在描述「接管复用旧 slotId」的注释与 §8.11 过渡段落显式作废。
- 产品：分享终态卡的倒计时移出 `role="alert"` 子树（此前 1Hz 让读屏每秒重播整卡）；`xxxRetrySeconds` 用 `typeof === 'number'`；「取消连接」移出 live region、观众倒计时按 10 秒一档进 polite live region；E2E 里恒真的「连接超时」断言改成真实文案族。
- 工程：白名单纯的 `totalLines === 0` 静默失效修掉、范围外白名单条目变成失败项、`knownPaths` 存在性检查用真实路径铆钉、文档与 CI 注释的实测数字全部重写。
- 门禁实测：typecheck 0；services 711 / components 46 / scripts 14；两个 scope 覆盖率守卫 OK（services 118 文件 91.27/83.83/84.69，components 13 文件 65.24/69.95/42.86，预算 75.49% ≤ 80%）；e2e 9 passed；product-transfer 13 passed；build 715.80 kB。

状态: 完成 (第十一轮复评 must-fix 全部收口；门禁全绿，待推送与复评, 2026-11-14)
## 阶段 11：第十二轮复评后的收口（2026-11-14）

对应 `docs/design-scale-out.md` §8.14。三项复评（安全 93 / 产品 89 / 工程 92）的 must-fix 逐条收口：

- 安全：为「每连接自铸 `slotReleaseToken`」补上能变红的断言（并发接管用例收集三次 reserve 的 token 与 slotId，两两不同；把 `crypto.randomUUID()` 换常量必须红）；`applySessionSlotReserve` 命中已存在 slotId 时改为「token 相同才续期、不同一律拒绝」，不再改写归属与 client_key，docblock 同步改真话。
- 产品：分享终态卡拆成「普通容器 + 只包文字的 alert + 控件行在外」，倒计时通过 `aria-describedby` 关联；回归测试换掉按属性位置切片的假绿写法（原实现里 `\b` 被写坏成 0x08 退格字节，深度恒 0）。
- 工程：screenshare 用例数 9 → 10（CI 注释、覆盖率守卫理由、ROADMAP 阶段 6 明标当时态）；设计文档历史数字逐处标成快照并指向 §8.14；第 7 观众用例允许一次重开以吸收同出口配额的抖动。
- 门禁实测：typecheck 0；services 711 / components 46 / scripts 14；`services/signaling` 174/174；两个 scope 覆盖率守卫 OK（services 91.27/83.83/84.69、components 65.30/70.43/42.86，预算 75.44% ≤ 80%）；e2e 9 passed；product-transfer 13 passed；build 716.04 kB。

状态: 完成 (第十二轮复评 must-fix 全部收口；门禁全绿，待推送与复评, 2026-11-14)
