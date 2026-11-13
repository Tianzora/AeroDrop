# 规模化设计：信令分片与屏幕共享 SFU 演进

状态: 设计文档（本轮不改业务代码）
基线: `main @ a1cd000` + 工作区阶段 1–3 改动
范围: 信令 Durable Object 分片、屏幕共享 mesh → SFU 的适配层与切换时机、TURN 成本模型、明确不做项。

本文件只回答三件事：现在的天花板在哪（有代码证据）、两条演进路线各自要动什么、按什么顺序落地以及怎么回滚。

> 证据约定：行号对应上述基线 + 工作区改动。凡标「需核对」的数字（厂商单价、免费额度）必须在使用前查官方定价页，本文不把它当结论。

---

## 1. 现状证据

### 1.1 部署与信令拓扑

- 单个 Worker `aerodrop`，入口 `src/worker.ts`，静态资源 `./dist` 且 `run_worker_first: true`（`wrangler.jsonc`）。
- **信令是全局单例 Durable Object**：`src/worker.ts:147` `const SIGNALING_DO_NAME = 'global-signaling-hub';`。前端可见的三处调用各自用途不同（不要笼统写成「桥接/注销」）：
  - `src/worker.ts:544` — `/api/ice-config` 的全局限流计数（`ICE_LIMIT_DO_URL`），唯一的跨 colo 共享计数器；
  - `src/worker.ts:653` — `/ws-signaling` 的 WebSocket 升级转发；
  - `src/worker.ts:710` — `callShareCodeStore`，即 `/api/share-code` 系列接口落到 `SHARE_CODE_DO_URL`。
- 同一个 DO 内部还处理 `SHARE_CODE_DO_PATH = '/internal/share-codes'`（`src/worker.ts:156-157`、`:1029`）：**口令存储与 WebSocket 信令抢同一个单线程实例**。
- 信令消息是**按 targetPeerId 点对点转发**：`src/worker.ts:1258-1260` 查 `sessionsByPeer`，找不到回 `peer-unavailable`。没有广播，单条消息成本与观众数无关。
- `/api/ice-config` 结果有 **isolate 级缓存**（`src/worker.ts:444-487`），不是每次请求都现签 TURN 凭证。
- 分享口令接口有**每 isolate** 的固定窗口预算（`src/worker.ts:150-154` 注释：POST 10/10s、GET 30/10s），**不是**跨 colo 的硬闸门。

### 1.2 连接、限流与身份

- 每客户端并发信令会话上限 `MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT = 12`（`services/signalingRateLimitPolicy.ts:125`），DO 构造时可用 env `SIGNALING_MAX_SESSIONS_PER_CLIENT` 覆盖（`src/worker.ts:1012`）。
- 该计数是 **DO 实例内存 map**（`src/worker.ts:1002`（声明）与 `:1011-1013`（构造），写入 `:1125`），休眠后从 WebSocket attachment 重建（`:1017-1024`）。也就是说：限流的正确性依赖「所有会话在同一个实例里」这个前提，分片会直接改变它的语义（见 2.4）。
- 会话身份：口令绑定随机 `peerId`，HMAC 校验在 `SignalingHub`；阶段 1 起同 `peerId` 的会话替换还要求持有创建时的 `sessionSecretHash`（`services/signaling/sessionBinding.ts`，校验点在 `src/worker.ts:1096-1117`）。注意该字段目前只覆盖**分享端**（`src/worker.ts:979-985`），接收端不传。

### 1.3 屏幕共享是星形 mesh

- 观众的媒体连接由观众侧发起：`components/ScreenShare.tsx:1304` `const call = peer.call(sharerId);`，分享端对每个观众 answer（`:852-891`）。拓扑是以分享端为中心的星形，不是观众之间的全网状。
- 同时观众数上限 `SCREEN_SHARE_LIMITS.MAX_VIEWERS = 6`（`constants/transfer.ts:89`，注释明确「超过后由分享端直接关闭新 call，而不是让信令 12 会话/IP 的隐式上限兜底」）。
- 码率是**区间**而不是固定档位：`services/screenShare/bitratePolicy.ts:4-11`（high `2M–100M`、medium `0.5M–8M`、low `0.1M–2.5M`），中继再夹到 `SCREEN_SHARE_RELAY_BITRATE_CAP = 8_000_000`（`:26`）。做容量估算时必须用区间端点，不能假设 4 Mbps。
- 分享端的 `getStats()` 读 `outbound-rtp` / `remote-inbound-rtp`（`components/ScreenShare.tsx:529-545`），并通过 `selectedCandidatePair` + candidateType 算出**每个观众的 relay 判定**（`:565-583`，写入 `peerRelayRef`，在 `:519`、`:629`、`:912`、`:922` 消费）。缺的是两件事：**没有把 relay 比例聚合上报**，且**不读 `availableOutgoingBitrate`**（后者只在文件传输侧读 candidate-pair，`components/Sender.tsx:508-525`）。见 3.4 的 P0 要求。
- 文件传输是 1:1 单连接，与屏幕共享的多人 fanout 是两条独立路径。

### 1.4 TURN 签发

- `/api/ice-config` 分支在 `src/worker.ts:922`；TTL 取 `parsePositiveInt(env.CF_TURN_TTL_SECONDS, 3600)` 并 clamp 到 60–86400（`:269-270`，常量 `:131-133`）。
- 结果经 `createIceConfigPayload` 归一化（`:294-310`），`hasTurn` 只表示「配置里含 TURN 服务器」（`:304-307`），**不代表实际走了中继**。
- Cloudflare TURN 与自建 TURN 的 `iceServers` 在 `:607-608` 合并；自建入口在 `wrangler.jsonc`：`turn:turn.tianzora.uno:3478?transport=tcp,turns:turn.tianzora.uno:5349?transport=tcp`，realm `turn.tianzora.uno`。

### 1.5 现在的天花板

| 约束 | 现状 | 先撞到的场景 |
| --- | --- | --- |
| 分享端上行 | 每个观众一条独立上行，6 观众 × 实际码率（区间上限很高） | 家宽上行 20–50 Mbps、观众 4–6 人时接近饱和 |
| 单 DO 吞吐 | 全球共用一个单线程实例，信令、口令存储、全局计数同实例 | 高峰时注册/转发/心跳/口令读写互相排队 |
| 单 DO 爆炸半径 | 实例不可用时全局信令中断（已有 P2P 连接不断） | DO 重启/迁移时新会话与重连失败 |
| 观众席位数 | 硬上限 6，名额按 call 占位 | 教学/演示 10+ 观众无解 |
| TURN 账单 | 走中继的那部分观众，每人一份 egress | 中继比例升高时随「观众数 × 时长」线性涨 |

关键判断：**文件传输不需要动**（1:1，mesh 已是终局）；需要演进的是「一对多屏幕共享」和「单例信令」。

---

## 2. 方案 A：保持 mesh，先做信令分片（低风险）

### 2.1 目标

不动媒体拓扑，把单例 DO 拆成 N 个分片。解决 1.5 的「单 DO 吞吐」与「爆炸半径」，观众数上限仍是 6。

### 2.2 分片键：只按 peerId

现状里唯一稳定的归属键是 `peerId`（随机、全局唯一），信令投递也只看 `targetPeerId`。因此注册与转发必须用**同一把键**：

```
shardOf(peerId) = rendezvousHash(peerId, shards)   // 只需确定性、无需一致；N 只增不减见 2.5
```

- 注册时把会话记到 `shardOf(peerId)`；发 offer/answer/ICE 时由发送方 shard 计算 `shardOf(targetPeerId)`，不是本片就 `stub.fetch()` 转发到目标片，目标片只做「查 sessionsByPeer → 投递」；目标片查不到时回 `peer-unavailable`（保持 `src/worker.ts:1258-1260` 的语义）。
- **不要**另加「按 clientKey 注册」的分片维度：那会让「A 呼叫 B」绝大多数落到错误的分片，路由直接失效。clientKey 只用于限流计数，而计数要单独拿出来（2.4）。
- 会话替换（`sessionSecretHash`）的判定必须发生在**持有该 peerId 的片**，且只判一次；否则两片各自判一次会出现「两边都认为自己是合法持有者」的竞态。

### 2.3 口令存储独立（先做，风险最低）

- 把 `/internal/share-codes` 从 `SignalingHub` 拆成独立 DO（如 `ShareCodeRegistrar`），口令读写不再与 WS 抢实例。
- **风险点（不要低估）**：WS 握手在 DO 内部直接读 `share_codes` / `share_code_tombstones` 做 `resolveShareCodeRegistration`（SQL 定义见 `src/worker.ts:1297-1355`），拆分后每次 WS 注册都变成一次跨 DO RPC，而且这次 RPC 发生在 12 会话限流（`:1125`）之前——可以被未认证连接放大。落地时必须：先加「每 clientKey 的握手预算」，再拆；或者让 Registrar 提供单次批量校验接口。
- 迁移期语义必须保留墓碑：注销/自然到期都要写 `share_code_tombstones`，24h 内重绑仍要求原凭证（`:1314-1316` 注释）。双读窗口期让 revoke 同步两边，或旧路径只读。
- 影响面：`/api/share-code`、`/revoke`、`/resume` 三个入口（`src/worker.ts:946-965`）改为 stub → Registrar。

### 2.4 限流计数：必须单独一个计数 DO

- 现状计数在 DO 实例内存里（1.2），分片后每个片各记各的，**上限会变成 12 × N**；改按 clientKey 分片又与 2.2 冲突。两个「按片计」的做法都不成立。
- 做法：保留一个小型 `Counters` DO 专门做「clientKey → 活跃会话数」与「ice-config 全局计数」，两者复用同一实例（读写量小、语义与今天一致）。各信令片在注册/注销时同步更新计数，计数 DO 返回是否超限。
- 必须提供**单次原子操作**（reserve/release/takeover 带 expected fencing token），否则「先驱逐旧会话、再领新名额」跨 DO 后不再原子：可能出现旧会话被驱逐却因超限拒绝新会话，或片崩溃后计数泄漏。计数落 DO storage 并带 TTL 巡检兜底。
- 代价：每次注册多一次 DO 调用；收益是限额语义不随分片数漂移。若暂时不拆，必须在文档与告警里明确「上限 = 12 × N」，不能假装没变。

### 2.5 兼容与迁移

- env 开关 `SIGNALING_SHARD_COUNT`，缺省 `1`（等价旧单例路径）。**shard 0 就是现有的 `global-signaling-hub`**，新片命名 `signaling-shard-<i>`（i ≥ 1）：这样 N=2 时旧的单例实例仍是「shard 0」，不会出现「既有连接所在实例不属于任何片」。
- `>1` 时需要 **peerId → shard 的目录/租约**（DO storage 或 KV）：注册写入租约（含 shard index 与 fencing token），转发先查目录。仅靠哈希不够：N 变化会重排，且旧单例里的连接不在任何新片。
- 迁移期旧单例只服务既有连接：**拒绝新注册**，但接受一个显式的「claim(peerId, expected lease) → 关闭该 peerId 的旧 socket、把租约交给新片」RPC。接管流程是「目录 CAS 抢租约 → 通知旧片关闭旧连接 → 新片注册」，不靠「探测找不到再回退旧单例」——那会让同一 peerId 在两个片上各有一个持有者，fencing 只在片内生效，接管/4009 语义失效。
- 分片数**只增不减**，且用 rendezvous hashing（只移动约 1/N 的键）。N 变更期间，转发对「目录里记录的旧 shard」逐个探测；探测不到不猜，直接回 `peer-unavailable` 让客户端重连。
- **WebSocket 不能迁移**：已建立的连接留在旧片直到断开，回滚/缩容意味着这些客户端全部重连（信令可重连、P2P 连接不受影响）。「回滚后旧单例仍保有全部状态」不成立，最多保有它自己那部分。
- DO migration 只需为新 class 增加 `new_sqlite_classes`，不需要重命名现有 class。

### 2.6 取舍

- 收益：吞吐随 N 改善；单点故障的爆炸半径缩小到 1/N（但**不提供**故障转移，已连会话该断还是断）。
- 代价：跨片转发多一次 DO 调用，RTT 取决于两片是否同 colo（跨 colo 是公网 RTT，不是个位数毫秒）；目录/租约与 fencing 是新增的失败面；观众数上限与上行瓶颈完全没解决。

---

## 3. 方案 B：屏幕共享引入 SFU 适配层（解决上行与观众数）

### 3.1 目标

把「分享端上行 = N × 码率」变成「分享端上行 = 1 × 码率」，观众数上限从 6 提到数十，并保留 mesh 作为降级路径。

### 3.2 抽象边界

现状把「建连 + 编码约束 + 观看人数统计」写在组件里（阶段 2 修的就是 `components/ScreenShare.tsx` 里 `call.open` 判定错误导致的统计缺失）。SFU 之前先把媒体出口抽象成接口，组件只依赖接口：

```ts
// services/screenShare/transport.ts（新增，纯类型与工厂）
export type ScreenShareTransportKind = 'mesh' | 'sfu';

export interface ScreenSharePublisher {
  start(stream: MediaStream): Promise<void>;
  applyQuality(level: ScreenShareQualityLevel): Promise<void>;
  stop(): Promise<void>;
  getStats(): Promise<{ viewers: number; bitrateBps: number; rttMs: number; availableOutgoingBitrateBps: number | null }>;
}

export interface ScreenShareTransport {
  readonly kind: ScreenShareTransportKind;
  createPublisher(options: { maxViewers: number }): Promise<ScreenSharePublisher>;
  /** 传入分享链接里的口令；实现内部用它换取该观众专属的入会凭证。 */
  joinAsViewer(input: { shareToken: string }): Promise<{ stream: MediaStream; leave(): void }>;
}
```

- `mesh` 实现包装现有 `PeerRuntime` 逻辑（每观众一条 `RTCPeerConnection`，即今天的 `peer.call()` 路径）。
- `sfu` 实现只依赖供应商 SDK 的 publish / subscribe / stats 三种能力。
- 选择点放在与 `services/connectionPolicy.ts` 同级的新判定函数（如 `resolveScreenShareTransport`），保持「连接策略唯一判定点」的约束，不在组件里 if/else。
- `getStats()` 必须补上 `availableOutgoingBitrate`（今天分享端没有读，见 1.3），否则 3.4 的判据拿不到输入。

### 3.3 供应商取舍

| | Cloudflare Realtime（原 Calls） | LiveKit |
| --- | --- | --- |
| 与现有栈 | 同账号、同 Worker 生态，TURN 已用 Cloudflare | 独立服务，需要新账号与密钥管理 |
| 客户端 | WebRTC（SDP 由服务端协商），需新 SDK | 官方 JS SDK，`Room`/`Track` 抽象完整 |
| 计费口径 | 以官方定价页为准（TURN 与 SFU 同属 Realtime 计费面） | 参与分钟 + 流量；可自托管 |
| 锁定风险 | 中（Cloudflare 特有 API 形状） | 低（可自托管，协议层可替换） |
| 自托管 | 否 | 是（可跑在现有 coturn 同一台机器） |

建议：**接口先行、实现二选一**。先把 `ScreenShareTransport` 落成 mesh-only 实现（行为不变、零风险），SFU 实现作为第二个文件接进来；供应商选择等 P0 数据齐了再定，不在本阶段锁死。具体单价与免费额度需在使用前查官方定价页，本文不硬编码。

### 3.4 切换时机（部分输入尚不存在）

可用的现有输入：
1. 观众数（分享端 activeCalls，已有）；
2. 每个观众是否走中继：分享端已按 `selectedCandidatePair` 的 candidateType 判定（`components/ScreenShare.tsx:565-583`），但只用于码率，**没有聚合上报**；不能用 `/api/ice-config` 的 `hasTurn`（它只表示配置里含 TURN，恒真）；
3. `relayRecommended`（`/api/ice-config` 返回，已有）。

尚缺、需要 P0 补的输入：
4. 分享端 `availableOutgoingBitrate`（今天没读）；
5. relay 比例的聚合指标（今天只有 per-viewer 布尔值）；
6. 单位时长成本（今天没有账单侧指标）。

切换判据分两步：
- P0 之前：观众数已达 `MAX_VIEWERS = 6` **且出现被拒加入**，或活跃观众中 relay 比例高（如 ≥ 2/3）且观众 ≥ 3。注意「观众 > 6」在现有硬上限下不可达，不能当判据；抬高上限必须是 SFU 灰度**之前**单独做的决定。
- P0 之后：再加上「上行余量 < 观众数 × 目标码率 × 80%」。
切换必须**按会话、在分享开始时决定一次**，不中途迁移，避免观众端重协商。

### 3.5 成本模型

变量：
- `B` 单观众码率（bps，取 `bitratePolicy` 区间内的实测值；下文示例里的 4 Mbps 只是示例值，不是默认假设）
- `N` 观众数，`T` 时长（秒）
- `r` 实际走 TURN 的比例（0–1，按 candidate-pair 统计，不是 `hasTurn`）
- `P_turn`、`P_egress` 单价（每 GB，需查官方定价页）

mesh：

```
uplink_mesh = N × B × T / 8          // 分享端上行，无论是否中继都存在
turn_egress = r × N × B × T / 8      // 只有中继的那部分计费；P2P 直连不产生 TURN 账单
```

SFU（分享端只上行一份，SFU 向 N 个观众分发）：

```
uplink_sfu  = B × T / 8              // 上行本身通常不计费（Cloudflare 侧只对 egress 计费，需核对）
sfu_egress  = N × B × T / 8          // SFU 分发是必然账单（除非自托管且只算机器成本）
turn_egress = r' × N × B × T / 8     // 观众与 SFU 之间仍需中继的比例 r'
```

结论要写清楚：**同价时 mesh 在 `r < 1` 时更便宜**（P2P 直连不花钱），SFU 的收益是上行与观众数，不是省钱；「把 10.8 GB egress 从分享端挪到 SFU」的说法只在 `r = 1` 时成立。示例：`B = 4 Mbps`、`N = 6`、`T = 1h` → `uplink_mesh = 10.8 GB`、SFU 分发 `10.8 GB`；若 `r = 0.2`，mesh 的 TURN 账单只有 `2.16 GB`。

现有可复用的闸门：`MAX_VIEWERS = 6`、`SCREEN_SHARE_RELAY_BITRATE_CAP = 8 Mbps`、口令接口每 isolate 预算（不能当跨 colo 防刷硬闸门）、12 会话/客户端（分片后语义见 2.4）、以及将来的 Counters DO。

### 3.6 迁移与回滚

- 双路径常驻：默认返回 `mesh`，`sfu` 仅在 env 开关 + 供应商健康检查通过时启用。回落只允许发生在**发布建连阶段**（publish 失败 → 本次分享直接走 mesh）；已经开播后不中途切，观众端只在下次加入时受影响。
- **观众需要每人的独立 SFU token**：现有 `/api/share-code` 只发 6 位分享口令，且 POST 限额 10/10s，不能直接复用。需要新增「按分享会话签发观众 token」的接口（带自己的预算），分享链接格式保持不变，token 在建会时换取。
- 回滚：关开关回到 mesh，服务端无持久状态需要迁移（SFU 会话是短生命周期）。

---

## 4. 分阶段落地顺序

1. **P0 观测**：补 `availableOutgoingBitrate`、把已有的 per-viewer relay 判定聚合成比例、记录观众数/单场时长/流量。没有这些，3.4 的判据与 3.5 的成本模型都只能拍脑袋。
2. **P1 Counters DO**（2.4）：把 12 会话与 ice-config 全局计数搬进独立实例，先解决「分片后限额翻倍」。低风险、可单独上线。
3. **P2 口令存储拆分（2.3）**：先加握手预算，再拆；保留墓碑语义与 revoke 同步。
4. **P3 信令分片**（2.2/2.5）：目录/租约 + fencing + rendezvous hashing；`SIGNALING_SHARD_COUNT` 1 → 2 → N；跨片转发与旧片探测兜底同时上线。
5. **P4 mesh 出口抽象**（3.2）：`ScreenShareTransport` 只有 mesh 实现，行为不变，用现有 `test:e2e` + `test:e2e:product-transfer`（含 `e2e/screenshare.spec.ts`）兜底。
6. **P5 SFU 实现 + 灰度**（3.3/3.4）：单会话级开关，先内部房间，再按判据自动选择。
7. **P6 容量与成本回归**：用 P0 指标验证「上行下降」「观众数提升」「单位时长成本」，任一不达标就回退到 P4 的 mesh 路径。

P1/P2/P3 与 P4/P5 是两条互不依赖的线，可以并行，但不要在同一发布里同时改信令与媒体路径。

---

## 5. 明确不做（及原因）

| 不做项 | 原因 |
| --- | --- |
| 观众之间全 mesh（每人对每人） | 上行随 N² 增长，比星形更差；观众只需看分享端 |
| 在 Worker 里做媒体转发 | Workers 不做长连接媒体面；SFU 必须是专门的媒体服务或供应商 |
| 自研 SFU | 单人维护成本高于直接接供应商或自托管 LiveKit；NAT/拥塞控制/Simulcast 都是深坑 |
| 把文件传输改成多播/分片中继 | 1:1 已满足需求，改动收益远小于风险；传输协议改动要求两端 + `types/` 同步 |
| 把分片数做成可减 | 减分片会让键重排、旧连接无处归属，只能靠全体重连过渡；先只增不减 |
| 录制 / 转码 / 云端存储 | 与「浏览器即开即用、P2P 优先」的定位冲突，且引入持久化合规面 |
| 现在就把 `MAX_VIEWERS` 调高 | 上行瓶颈未解前调高只会让所有观众一起卡；等 P0 数据证明有余量再动 |

注：Durable Object 有 `locationHint`（首次 `get()` 生效、best-effort、不保证不迁移），可用它让新分片尽量落在目标区域，但它**不是**动态就近/迁移机制，不能当作「多区域方案」的替代品。

---

## 6. 风险清单

- **分片后跨片转发丢消息**：转发失败必须回 `peer-unavailable`，让客户端走既有重连/降级策略，不能静默丢；单测要覆盖「目标 peerId 在别的分片」。
- **同一 peerId 被两个片持有**：目录租约 + fencing token 缺一不可；会话替换判定必须只在持有片执行一次。
- **限额随分片数翻倍**：不先做 P1 就上分片，等于把 12 会话/客户端悄悄改成 12 × N。
- **口令双读窗口不一致**：revoke 未同步会导致「已注销口令仍可 resume」；必须 revoke 同步两边或旧路径只读。
- **SFU 供应商锁定**：接口只有 publish/subscribe/stats，任何供应商特有概念不得越过 `services/screenShare/transport.ts`。
- **切换判据抖动**：按 3.4 只在分享开始时决定一次。
- **成本失控**：SFU 与 TURN 都按流量计费，必须有会话级与账号级上限，并在 P0 指标里直接暴露单位时长成本。

## 7. 与本轮改动的衔接

- 阶段 1 的 `sessionSecretHash`（`services/signaling/sessionBinding.ts`）让「会话属于谁」可校验，是分片后「判定必须发生在持有该 peerId 的片」的前提；注意它目前只覆盖分享端。
- 阶段 2 的 `e2e/screenshare.spec.ts` 是 P4 抽象的行为安全网：mesh 实现被包进 `ScreenShareTransport` 后，这个 spec 必须零改动通过。
- 阶段 3 的 `services/send/senderSession.ts` 属于**文件传输发送端**的分享会话（口令/续期/TTL/ICE 刷新/pagehide），与屏幕共享无关，本方案不会动它；屏幕共享的生命周期仍在 `components/ScreenShare.tsx`，P4/P5 若要把它的编排也搬进 services/，应新建 `services/screenShare/` 下的会话服务，而不是复用 senderSession。

---

## 8. 落地进展（2026-11-13）

本节只记录「文档里的方案已经变成什么代码」，与上面的设计不冲突时以上面的取舍为准。

### 8.1 已落地

| 设计项 | 代码 | 说明 |
| --- | --- | --- |
| 会话凭证从静态 bearer 改为可轮换 proof（正文 §2.3 的前提） | `services/signaling/sessionBinding.ts`、`services/peerRuntime.ts`、`src/worker.ts` | 首次注册用 `sessionSecretHash` 绑定，服务端签发 `sessionProof`（32 字节 hex，明文只出现在 `registered` 帧一次，库里只存 SHA-256）；之后每次注册只带 proof 并轮换，旧 proof 留 10 分钟宽限期（`SESSION_PROOF_GRACE_MS`），避免「新 proof 未送达就断线」误拒合法客户端。静态摘要只在首次绑定后 10 分钟内兜底（`registered` 帧可能丢），过期后必须用 proof；轮换是读改写，落库前重读绑定，避免并发注册把对方刚签发的 proof 挤出。绑定持久化在 `signaling_session_bindings`（24h），因此 socket 断开期间 peerId 也不能被无凭证抢注。 |
| 分片键与片名（§2.2） | `services/signaling/shardRouting.ts` | `rendezvousShardIndex(peerId, shardCount)`；shard 0 沿用 `global-signaling-hub`，新片 `signaling-shard-<i>`；`SIGNALING_SHARD_COUNT` 未设置时恒为 1，行为与单例一致。 |
| WS 路由与跨片投递（§2.2/§2.5 的过渡形态） | `src/worker.ts` | `/ws-signaling` 按 rendezvous 选片；DO 内 `deliverSignaling` 发现目标不在本片时 POST `/internal/deliver-signaling`，查不到回 `peer-unavailable`；同一 socket 的投递按 Promise 链串行，避免 await RPC 时后续帧插队（ICE 先于 offer 到达）。 |
| 口令仍只在 shard 0（§2.3） | `src/worker.ts` | 非 0 片注册先经 `/internal/lookup-share-codes` 回源取记录，再交给同步的 `resolveShareCodeRegistration`；回源失败按查不到处理（fail closed）。 |
| 限流不随分片翻倍（§2.4 / P1） | `src/worker.ts` | 分片 >1 时改用 shard 0 的 `signaling_session_slots` 全局名额表（原子 reserve/release、6h TTL、槽位 id 存 attachment；接管复用同一槽位而不是先释放再领取，常驻连接每 30 分钟随 ping 续期），不再让每片各算 12 会话。 |
| 握手放大面 | `services/signaling/handshakeBudget.ts` | 跨片回源前的 per-isolate 预算（20 次/10s/IP），挡住「未认证握手 → DO 调用风暴」；仅在分片模式消耗。 |
| 口令回源的批量合并（P2 第一步） | `services/signaling/shareCodeLookupBatch.ts`、`src/worker.ts` | 同一窗口（2ms）内的并发注册共用一次批量 RPC：观众同时打开链接时，shard 0 从「每注册一次读」降到「每批一次读」。批量请求失败或返回条数不符时每个等待者都 reject，调用方仍按「查不到」fail closed；握手预算仍按每次查询消耗。`signal_share_code_lookup_batched` 记录实际合并的批大小（>1 才记）。 |
| P0 观测（第一层） | `services/signaling/signalingTelemetry.ts`、`src/worker.ts` | 结构化日志即指标（无第三方、无付费）：`signal_shard_selected`（仅分片模式）、`signal_cross_shard_delivered/failed`（带 targetShard 与失败原因）、`signal_session_slot_rejected`、`signal_session_conflict`、`signal_handshake_budget_exhausted`、`signal_share_code_lookup_failed`、`signal_share_code_lookup_batched`。一行一个 JSON，按 `event` 计数即可。 |
| P0 告警（第二层） | Cloudflare「监控器 Beta」4 个阈值监控器（见 8.1 尾表） | 数据集 `logs.workersLogs`，过滤 `message LIKE '%<event>%'`，1 分钟计数阈值，邮件通知；把「5 分钟 > N」折算成每分钟阈值（1m 是该数据集允许的最小间隔，告警更灵敏，靠 `重复通知间隔 1h` 防轰炸）。编辑页 `https://dash.cloudflare.com/<account>/notifications/edit/<id>`。 |
| 口令回源的读放大（P2 前置） | `src/worker.ts` | 补 `share_codes(peer_id)` 索引；分片后每次回源按 peer_id 查，否则 shard 0 每条注册都全表扫。 |
| 分片数变更的身份 fencing（§8.2 原硬前置） | `src/worker.ts`、`services/signaling/sessionBinding.ts` | 绑定（摘要 + proof 链）的权威副本只住 shard 0：分片模式下每次注册都回 shard 0 做「判定 + 签发新 proof」（因此每次注册多一次 DO RPC，受握手预算约束），本片不再落绑定表。`SIGNALING_SHARD_COUNT` 变更导致 peerId 改片时，新片仍查得到同一条绑定；**不带 proof 的接管、以及「等旧 socket 断开再以全新注册身份挤进来」都会被拒**（后者以前是洞：非接管注册曾走「无 hash/proof 直接放行」的捷径）。回源不可达时接管 fail closed、全新注册 fail open，并记 `signal_session_binding_unavailable`。|

已配置的监控器（2026-11-13，账户 `4a54c78f1c017c92535c66901101a470`）：

| 名称 | `message` 过滤 | 阈值 | monitor id |
| --- | --- | --- | --- |
| AeroDrop 信令 - 会话密钥冲突 | `%signal_session_conflict%` | 计数 ≥ 5 / 1m | `6ae01b547d8f418ea50a0860f84866a6` |
| AeroDrop 信令 - 会话绑定不可达 | `%signal_session_binding_unavailable%` | 计数 ≥ 1 / 1m | `a7e40c2352eb4763a78c17db87199da1` |
| AeroDrop 信令 - 握手预算耗尽 | `%signal_handshake_budget_exhausted%` | 计数 ≥ 12 / 1m | `ecd1373be9084359820fd249112c9282` |
| AeroDrop 信令 - 跨片投递失败 | `%signal_cross_shard_failed%` | 计数 ≥ 3 / 1m | `ee3430c127134c48bb634e9796287387` |

四个监控器均为「阈值」类型、目标为电子邮件（收件人 `fairchildovo@gmail.com`，界面只回显「电子邮件」chip，未回显地址）、`重复通知间隔 1h`。注意：本地开发不打线上日志，这些监控器只在部署后生效。

**致命细节：日志行不能是「整行合法 JSON」**。Workers Logs 会把整行合法 JSON 的日志拆成结构化属性（`event`、`type` 等成为对象字段），`message` 列为空；而告警的 SQL 只能查 `message` 这类字符串列，自定义属性不是可查询列。结果是：日志在 Dashboard 自由文本搜索里查得到、`message LIKE '%<event>%'` 却恒为 0，监控器永远不触发。修法是给指标行加一个普通前缀（`src/worker.ts` 里 `console.log(\`signaling_metric ${line}\`)`），整行不再是合法 JSON，指标原文落进 `message`。已实测：部署 `b42107e`（version `5c7c5c6a`）后制造 6 次 `session-conflict`，告警历史出现 `AeroDrop 信令 - 会话密钥冲突`，`triggered_result: "6"`、`alert_start_time 2026-11-13T11:36:21Z`、`sent 2026-11-13T11:39:39Z`（history id `008711e2-f6c3-4700-8a77-9b727f0687e5`）。

### 8.2 仍未做（保持原优先级）

- **P0 观测（告警已完成，看板未做）**：4 个阈值监控器已在 Cloudflare「监控器 Beta」创建（清单见 8.1 尾表），覆盖 `signal_session_conflict`、`signal_session_binding_unavailable`、`signal_handshake_budget_exhausted`、`signal_cross_shard_failed`。仍缺：①`signal_share_code_lookup_failed` / `signal_cross_shard_delivered` 的看板（用 Workers Logs 查询或 Analytics Engine）；②`proof 轮换失败` 目前是客户端事件（`signaling_session_proof_rotated`），服务端尚未对应计数；③告警只在部署后生效，本地开发不进线上日志。
- **§2.5 目录租约 + fencing**：当前没有跨片目录，分片数变化会让部分 peerId 改片；因为默认不分片，暂时没有暴露，但扩容前必须按 §2.5 落地。
- **§2.3 次生问题**：分片后每次注册多一次跨 DO RPC（口令回源），预算只是削弱放大。并发窗口内的查询已合并成批量 RPC（`shareCodeLookupBatch`），本地短 TTL 缓存仍未做（缓存与注销语义冲突，需先定可接受的陈旧窗口）。
- **P2 口令存储拆分、P4/P5 SFU 适配层与切换**：未开始，判据与取舍见正文 §3。
- **分片数变更：身份已 fencing，会话仍不能迁移**：binding 权威副本已收归 shard 0（2026-11-13），改片不会退回「无绑定可接管」；但落在旧片的 socket 不会被新片接管，全靠客户端重连。平滑扩容仍需要 §2.5 的目录租约 + 片名 epoch，让旧片排空后再下线。
- **`/internal/*` 端点无认证**：目前只有同 Worker 的 DO 能调用，且路由表不转发这些路径；一旦加了透传/调试入口，它们就是注入面，届时需要 service token 或收敛到 `fetch` 层白名单。
- **口令回源的写热点**：`share_codes(peer_id)` 索引已补，但回源仍会触发 `deleteExpiredShareCodes`，分片后 shard 0 承担 N 倍读 + 周期写；批量合并已把并发突发摊平，`deleteExpiredShareCodes` 的周期写仍是单点。
- **proof 泄露即接管**：任何 bearer 轮换都有这个性质；当前只靠 TLS 与日志脱敏（`redactSignalingUrl`）。彻底解法是把 proof 从 query 移到连接首帧，或与设备密钥绑定。

### 8.3 2026-11-13 的 95 分加固（本轮）

复评基线：安全 87、产品 82、工程 66（HEAD `b42107e`）。本轮按三条线并行落地，目标是三项都到 95；下面只记录「改了什么、为什么、还缺什么」。

| 线 | 代码 | 干了什么 |
| --- | --- | --- |
| 可测性 + 安全（worker） | `src/worker.ts` 2506 → 2055 行；新增 `services/signaling/{sessionStore,sessionAdmissionDelivery,sessionSeat,requestContext,networkRisk,httpPolicy,shareCodeBody,unknownShareCodeBudget}.ts` | 把 DO 里的 SQL 状态机、准入顺序、席位、请求上下文、风险评分、口令体解析全部下沉成可注入 `SqlLike` 的纯模块；六条安全修复见下。 |
| 屏幕共享产品化 | `components/ScreenShare.tsx`、`components/screen-share/ScreenShareUI.tsx`、新增 `services/screenShare/{viewerHeartbeatPolicy,viewerCapacity,shareRoomRegistration}.ts`、`services/screenShare/bitratePolicy.ts` | 信令失败进终态（不再「绿色 LIVE + 失效链接」并存）；心跳按「后台标签页/传输健康豁免」判定；16 Mbps 聚合上行预算 + 按观众数分摊；房号改走 `/api/share-code` 登记（24h TTL、30min 续期、停止即 revoke）；错误文案全部归口 `services/connectionGuidance.ts`。 |
| 工程流水线 | `.github/workflows/ci.yml`、`scripts/test-stubs/`、`scripts/node-test-args.mjs`、`services/send/{sendFileSequence,transferOffsets}.ts`、`e2e/screenshare.spec.ts` | 加 CI（typecheck → test:all → build）；组件测试用 stub 替换 framer-motion/hugeicons，**327s → 1.13s**；`components/Sender.tsx` 1981 → 1637 行（状态机搬到 `sendFileSequence`）；新增「信令 4010 时分享端进终态」E2E（`addInitScript` 包 `window.WebSocket`，0ms open + 150ms 4010）。 |

六条安全修复（都有失败场景测试，`services/signaling/*.test.ts`）：

1. **静态摘要过期语义落地**：只在首次绑定后 10 分钟内兜底，之后每次成功注册都写 NULL/不续期，过期后只认 proof。此前每次 admission 都刷新 `secretHashExpiresAt`，等于静态摘要永不过期，轮换收益被抵消。
2. **proof 轮换改为「`registered` 帧投递成功后才落库」**（`deliverRegisteredThenCommit`）：帧丢失时客户端仍持旧 proof 可重连（10 分钟宽限），不会因为「库里有新 proof、客户端没收到」而 4010 自锁。
3. **同 IP 接管走「席位转移」**：同一 clientKey 直接沿用旧槽位，不再先 release 再 reserve；跨 IP 才 acquire，失败直接拒绝且不关旧会话（关闭旧 socket 的动作只在成功后做）。
4. **限流键表满 fail-closed**：`fixedWindowRateLimit` 满表时不再淘汰最早 key 放行新 key（那等于给攻击者一个免费的计数器重置）。
5. **只信 Cloudflare 客户端 IP 头**：删除 `X-Forwarded-For` 回退，没有 CF 头时统一落 `ip:unknown` 桶（本地/非 CF 环境下按全体合计计数，宁可误伤不可绕过）。
6. **口令 GET 的未知码全局预算**：shard 0 对未知口令 200 次/10s 全局预算，超限 429 + `Retry-After: 5`；未命中记 `share_code_lookup_miss`，服务端日志可用它做枚举检测。

`constants/signaling.ts` 收敛了会话绑定 24h、槽位 6h/30min、proof 宽限 10 分钟、摘要兜底 10 分钟、未知码预算、TURN TTL 与 ICE 超时等常量；`src/worker.ts` 与 `services/` 只引用，不再各自内联。

复评前仍缺（写给评审，也写给下一轮）：

- **Worker 仍没有 DO 级集成测试**：SQL 状态机与准入顺序已经可测（`sessionStore.test.ts` 13 条等），但「真 `wrangler dev` 起 DO + 多 socket 行为」仍靠 `%TEMP%` 探针手工跑（`ws` 不是声明依赖，Node 全局 `WebSocket` 又改不了 `Origin`，受 CSRF 同源门限制）。
- **屏幕共享仍是 mesh**：`MAX_VIEWERS=6`、16 Mbps 聚合预算把「能不能撑住」写成了上限，但 7 人以上仍要 SFU（本轮的定位是小规模可靠，不是规模化）。
- **覆盖率/lint 未引入**：只在 CI 里跑 typecheck + test + build；`any`/`as` 数量下降但没有门禁。
- **TURN 中继路径仍无 E2E**：product spec 的 ICE 走 host/host（本机），中继回退靠手工。


### 8.4 第二轮复评后的补齐（2026-11-13，复评基线 90 / 91 / 88）

复评给出的三条都不是「方向错」，而是「还差最后一公里」。本轮按缺口逐条补，仍然不新增依赖、不引入付费服务。

安全/正确性（90 → 目标 95）：

| 缺口 | 修法 | 测试 |
| --- | --- | --- |
| proof 轮换落库失败后客户端持新 proof、库里只有旧 proof，重连 4010 终态 | `deliverRegisteredThenCommit` 落库重试 3 次（短退避，指标带 attempt）；仍失败时 `appendPendingSessionProof` 把新 proof 摘要挂进 `recent_hashes`（24h），客户端下次带新 proof 仍能进。顺序契约不变（先投递后落库）。 | `sessionAdmissionDelivery.test.ts`（瞬态失败重试、退避、pending 兜底、recovery 失败不外溢）+ `sessionStore.test.ts`（追加/去重/无绑定行） |
| shard 0 绑定表不可达时新注册 fail-open | `admitSignalingSession` 回源失败返回 `null`，升级在 accept 之前直接 503 + `Retry-After: 5`；不再「先 accept 再发 error」留下半开连接 | `registrationPlan.test.ts`（503 分支）+ 服务端执行循环 |
| 分片模式同 peerId 并发注册可双开 | await 名额之后重读 `sessionsByPeer`（`classifySignalingSessionRace`），输了回滚名额 + 4010，绝不覆盖对方归属 | `registrationPlan.test.ts`（raced 中止、不驱逐赢家） |
| DO 编排层零测试（工程高危） | 注册顺序抽成 `planSignalingRegistration` 纯函数（拒绝 → 领名额 → 驱逐 → registered → commit），worker 只执行动作序列 | 7 条顺序断言 + rollback |

产品/可靠性（91 → 目标 95）：房号登记失败按服务端原因分类（429 直接终态，占用/网络退避后可自愈）；`pagehide` 用 `keepalive` 撤销房号（bfcache 跳过）；续期连续 3 次失败置 amber 风险提示但不停直播；有在途传输时信令终态只降级 `connectionStatus`（「分享已失效，进行中的传输不受影响，新设备无法加入」），不再 `setPhase('error')` 把传输列表撤掉；E2E 补「4010 终态 → 点重新开始 → 恢复」「登记 429 → 终态」「登记 503 → 自愈」；接收端拒收原因归口 `getTransferRejectedMessage`。

工程（88 → 目标 95）：新增 `services/signaling/sessionStore.sqlite.test.ts`——用 `node:sqlite` 的 `:memory:` 库执行同一批 SQL（建表/迁移/绑定轮换/槽位/口令表 RETURNING 与墓碑），伪 SQL 测不出的列序与 RETURNING 语义现在会被真实执行；`scripts/node-test-args.mjs` 统一加 `--experimental-sqlite`；CI 增加覆盖率门槛（`NODE_TEST_COVERAGE=1`，默认 lines 85 / branches 78 / functions 75）与独立的 Chromium E2E job。

仍然存在的已知取舍（评审共识，非本轮遗漏）：

- proof 仍走 WS URL query（改首帧需要同时改客户端与服务端的注册协议，属于破坏性升级，单独排期）。
- DO 级集成测试仍未引入：`ws` 不是声明依赖、Node 全局 `WebSocket` 不能自定义 `Origin`，而 CSRF 同源门要求 Origin 匹配；继续靠 `%TEMP%` 探针 + 编排纯函数测试覆盖。
- 千行组件只拆了 `Sender`：`Receiver.tsx`（约 3366 行）与 `ScreenShare.tsx`（约 2350 行）仍是单体，属于可维护性债务而非正确性问题。
