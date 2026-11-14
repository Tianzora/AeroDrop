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
| 限流不随分片翻倍（§2.4 / P1） | `src/worker.ts` | 分片 >1 时改用 shard 0 的 `signaling_session_slots` 全局名额表（原子 reserve/release、6h TTL、槽位 id 存 attachment；接管用 `replaces`（条件删除）让出旧行，而不是「先释放再领取」（后者一旦领取失败就把旧名额白丢了），常驻连接每 30 分钟随 ping 续期），不再让每片各算 12 会话。 |
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

### 8.5 第三轮复评后的补齐（2026-11-13，复评基线 93 / 92 / 90）

这一轮的三个必修项都不是「再抽一层」，而是「让已经正确的规则无法被悄悄改坏」：

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| 迟到 commit 覆盖在位 proof：A 的落库在途、B 接管并 commit P_B、A 迟到写回 P_A，P_B 只剩 10 分钟宽限，之后 B 永久 4010 | 轮换落库改成 CAS：`planSessionAdmission` 带 `expectedProofHash`，`commitSessionBindingRotation` 读快照比对，不一致返回 `superseded: true` 且不写库；worker 记 `signal_session_binding_commit_superseded` 后放弃（不重试，避免再次覆盖赢家） | `sessionStore.sqlite.test.ts` 的 CAS 回归（首次 null → 接管 a→b → 迟到写 a 被判 superseded、库中仍是 b、c 不进历史） |
| Worker 执行循环（名额失败 4029、503、`rollbackQuota`、驱逐异常、attachment 合并）零测试 | 抽 `services/signaling/registrationExecutor.ts`：动作顺序与端口副作用分离，worker 只提供端口并执行 | `registrationExecutor.test.ts` 7 条（happy path 调用序、名额满不回滚也不驱逐、席位失败先回滚、raced 不驱逐赢家、transfer 不领席位、身份拒绝只走 rejectConflict、commit-binding 无副作用） |
| 生产单例无握手预算：未认证 `/ws` 垃圾握手可直打全局唯一 DO | 预算从「仅分片回源时」改为**所有握手**在 accept 之前消耗；429 带 `Retry-After` 与 `shardCount` 指标 | `signalingHub.test.ts`（第 21 次同 IP 握手 429、其它 IP 不受影响） |
| 覆盖率门槛只统计被加载文件，`worker.ts` 从未被 import | 新增 `services/signaling/signalingHub.test.ts`：用 `scripts/test-stubs/cloudflare-workers.mjs` 替身 + 注入 `WebSocketPair`/101 `Response` + 真实 `node:sqlite` 作 `ctx.storage.sql`，直接构造 `SignalingHub` 并走真实 `fetch` 分支 | 5 条：101/registered（无摘要不签发 proof）、非法摘要/非法 proof 握手 400、无 proof 抢注被 4010 拒绝且旧 socket 存活、带当前 proof 接管后轮换并给旧 socket 4011、每 IP 上限 4029、预算 429、旧 4 位 peerId 4009 且不占名额 |
| `sessionStore.sqlite.test.ts` 适配器用 `rows.length` 当 `rowsWritten`、不模拟单语句 | 改为 `SELECT changes()`；多语句直接抛错；补旧表 `ALTER TABLE ... ADD COLUMN revoke_after` 迁移用例与槽位 `rowsWritten` 用例 | 同名测试文件 +4 例 |
| collector（`collectTestFiles`）无测试、`tsconfig` 不含 `scripts/` | 补递归收 `.test.tsx` / 不存在目标 / 空目录三例；`tsconfig.json` 加 `scripts/**/*.ts` 与 `noFallthroughCasesInSwitch`；CI 增加组件覆盖率门槛（60 / 58 / 40，低于 services 的原因写在 workflow 注释里） | `scripts/run-node-tests.test.ts`（现 10 例） |
| 恢复 hibernated socket 时 `tryAcquire` 返回值被忽略 → 上限被悄悄放宽 | 新增 `SignalingSessionLimiter.restore()`：恢复的 socket 只计数不判上限（它们本来就活着），构造期用它替换 `tryAcquire` | `signalingRateLimitPolicy.test.ts`（restore 超上限仍计数、之后新 socket 被拒、release 后恢复准入） |
| 驱逐时无条件 `map.delete` 可能删掉 await 期间接管的赢家 | 三张 map 的删除都按值校验（`get(...) === existing`） | 由 `signalingHub.test.ts` 的接管用例覆盖（赢家仍持有注册） |
| 发送端状态行被 800ms 轮询覆盖（P2-1） | `services/send/connectionStatusNotice.ts`：会话层 `announce` 带 30s 窗口，连接数轮询走 `routine` 在窗口内不生效；`Sender.tsx` 全文件不再有裸 `setConnectionStatus` 写入 | `connectionStatusNotice.test.ts`（含负对照：短路窗口后用例失败） |
| 看门狗与恢复回调可并发 `initializePeer`，重复登记房号（P2-2） | `services/screenShare/peerInitGuard.ts` single-flight，`initializePeerUnlocked` 外包闸门；恢复退避回调进门先判 in-flight | `peerInitGuard.test.ts` + E2E「卡住的登记不会被看门狗重复触发」（负对照：短路闸门后 `Expected: 1, Received: 2`） |

复评中确认的两个非缺陷：评审怀疑 `services/signaling/requestContext.ts` 读了非标准头，实际字节就是 `CF-Lhcwxzwee-VF`（字符码 67,70,45,67,111,110,110,101,99,116,105,110,103,45,73,80），是工具输出对字面量的显示替换；`docs/` 里同样出现过 `session-conflict`/`shard` 被替换的情况，判断一律以字节核对为准。

仍然存在的已知取舍（本轮之后）：

- proof 仍走 WS URL query；改首帧要同时改两端注册协议，属破坏性升级。
- `signalingHub.test.ts` 是**进程内**的 DO 契约测试（替身 socket），不是真 `wrangler dev` 多 socket / hibernation 测试；那部分仍靠 `%TEMP%` 探针手工跑（`ws` 不是声明依赖，CSRF 同源门又要求 Origin 匹配）。
- `Receiver.tsx`（约 3366 行）与 `ScreenShare.tsx`（约 2350 行）仍是单体组件；`ScreenShare.tsx` 的注册/重连/心跳计时器仍有内联部分。
- 屏幕共享仍是 mesh（`MAX_VIEWERS=6`、16 Mbps 聚合预算），7 人以上需要 SFU。

### 8.6 第四轮复评后的补齐（2026-11-14，复评基线 94 / 90 / 91）

这轮的关键变化不是新增能力，而是把「测试已经证明的规则」和「生产中实际执行的分支」之间的缝补上：

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| 重建只带静态摘要、不带 proof：共享跑过 10 分钟后任何一次（重连耗尽的）重建都会 4010 终态并撤销房号 | `PeerRuntime` 新增 `session-proof` 事件与 `getSessionProof()`；`services/screenShare/sessionProofStore.ts` 按 peerId 存 sessionStorage，`screenSharePeerCredentials.ts` 有 proof 时只带 `sessionProof`、**不再带**静态摘要；重建时优先用存下的 proof，停止/终态清除 | `sessionProofStore.test.ts`（6 例，含损坏 JSON/不可用 storage 容错）、`screenSharePeerCredentials.test.ts`（3 例，断言有 proof 时 `'sessionSecretHash' in credentials === false`） |
| 注册途中 socket 关闭：名额/会话写进已死 socket，回收只发生在 close（那时 `clientBySocket` 还没写）→ 分片模式名额永久泄漏 | 每次 await 后 `rejectRaced()` 先查 `server.readyState`；`send-failed` 时回滚名额并清三张 map 与槽位归属，记 `signal_session_registration_send_failed` | `signalingHub.test.ts`「注册途中 socket 关闭：不写会话、名额与槽位一起回滚」（变异：短路 readyState 判定 ⇒ 红） |
| 自愈补写 pending proof 绕过 CAS：被放弃的轮换仍以 24h 进历史 | `appendPendingSessionProof` 增加 `expectedProofHash`，与当前权威 proof 不一致就放弃；跨片 RPC 同样传该字段 | `sessionStore.sqlite.test.ts`「自愈补写 pending proof 也走 CAS」（变异：短路比较 ⇒ 红） |
| 分片 commit 只看 `response.ok`，丢弃 `{committed, superseded}` → CAS 弃写无指标 | 解析响应体：`superseded` 记 `signal_session_binding_commit_superseded{path:'shard-rpc'}`，`committed:false` 视为失败重试 | `signalingHub.test.ts`「分片模式下 commit 返回 superseded 时记指标」（变异：把判定改假 ⇒ 红） |
| 新测试全部顺序 await，check-then-act 交错无覆盖 | 在 shard 1 的 `reserve` RPC 在途时启动同 peerId 的第二条注册，A 恢复后必须重读 map 并放弃 | `signalingHub.test.ts`「交错注册竞态…」（变异：race 判定恒 `null` ⇒ 红；槽位归属 B） |
| 跨片投递 `rpc_error` 分支与 `webSocketError` 单独路径无测试 | 补两个用例：RPC 抛错 ⇒ 调用方 `peer-unavailable` + 一条 `rpc_error` 指标；`webSocketError` 不误删同 peerId 的其他 socket、席位可释放 | `signalingHub.test.ts`（变异：吞掉异常 / 删 `unregisterSession` 调用 / 删 limiter release 均变红） |
| 房号登记无超时 → `initializePeer` 永不结束 → 闸门永久占用 → 永久 amber 只能刷新 | `requestShareCode` 加 8s `AbortController`（`SHARE_CODE_REGISTER_TIMEOUT_MS`），超时状态单独上报；`peerInitGuard` 增加 `isStale` 与换新闸门；连续 2 次超时（≈17s）落终态 | `shareRoomRegistration.test.ts`「登记超时被单独报出来」（变异：吞成 failed ⇒ 红）+ `e2e/screenshare.spec.ts`「卡住的登记进入可操作终态」（把上限改 99 ⇒ 25s 内不出现终态，红） |
| 停止→立刻再开始被旧闸门挡住（最长 20s） | `stopScreenShare`/`failSharerSession` 换新闸门对象（旧调用的 `finally` 只碰旧对象） | `peerInitGuard.test.ts` +2（`isStale`、跨会话换新闸门） |
| 发送端「分享已失效」只活 30s，随后状态行回落「等待连接」、口令仍可复制 | `SenderSessionHost.setShareRevoked` 持久降级位（start/open/resume 成功才清），`SenderUI` 据此显示「已失效」、amber 链接说明与「重新创建分享」；状态行收敛为 `pushConnectionStatus`/`applyRoutineConnectionStatus` 两个入口 | `senderSession.test.ts` +2（作废是持久事实、重新开始不继承）、`connectionStatusNotice.test.ts`（5 例） |
| 房号 TTL 过期分享端无感（续期要连续失败约 1.5h 才提示） | `expiresAt` 回传 + 30 分钟定时续期 + `visibilitychange`/`online` 立即续期 + 60s 过期看门狗；`shareRoomExpired` 时徽标切「链接已失效」并禁用复制 | `ScreenShareUI.test.ts` +2、`shareRoomRegistration.test.ts` |
| 首连就报「信令中断」、英文 `getDisplayMedia` 文案直拼 | 只有 `hasBeenReady` 之后才说「信令中断」；采集失败文案搬到 `services/screenShare/screenCaptureGuidance.ts` 按 `error.name` 映射中文 | `screenCaptureGuidance.test.ts`（3 例，含「英文 message 不进文案」）、`ScreenShareUI.test.ts` |

同时完成的三项工程收敛：sqlite 测试适配器去重到 `scripts/test-stubs/sqlite-adapter.ts`（覆盖率默认排除该目录）；runner 测试顺带覆盖 collector 与退出码透传；`tsconfig.json` 纳入 `scripts/**/*.ts` 并开启 `noFallthroughCasesInSwitch`。

`src/worker.ts` 的契约测试覆盖（`services/signaling/signalingHub.test.ts`）从 5 例扩到 15 例后，worker 的行覆盖 58.64% → 68.24%、函数 29.76% → 51.65%；全部用例都做过「改坏生产码 → 变红 → 还原」的变异验证。

仍然存在的已知取舍（本轮之后）：

- proof 仍走 WS URL query；改首帧要同时改两端注册协议，属破坏性升级。
- `signalingHub.test.ts` 是进程内替身，不覆盖真实 hibernation 与多 isolate 调度；跨片/休眠相关探针仍只在 `%TEMP%` 手工跑。
- 长时共享（>10 分钟）后「重连耗尽 → 重建带 proof」只有单测与结构保证，没有真实时间推进的 E2E（CI 不适合等 10 分钟）。
- `Receiver.tsx` / `ScreenShare.tsx` 仍是千行组件；屏幕共享仍是 mesh（`MAX_VIEWERS=6`、16 Mbps 聚合预算）。

### 8.7 第五轮复评后的补齐（2026-11-14，复评基线 93 / 88 / 89）

> 数字说明：§8.4–§8.12 里的覆盖率、文件数、行数与用例数都是各轮**当时的快照**；`src/worker.ts` 的覆盖率、组件/服务文件数等会随后续提交变化，当前实测一律以 §8.13 末尾为准。

第五轮的三份复评（安全 93、产品 88、工程 89）都只差「最后一公里」的证明，因此这一轮几乎没有新抽象，主要是把已有模块接进测试与 CI：

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| 发送端把可自愈的瞬态（自动重连成功）当永久失效：`PeerRuntime` 重连成功只发 `signaling:restored`，`SenderSession` 只监听 `open`/`error` → 口令卡永远「已失效」 | `services/send/senderSession.ts` 监听 `signaling:restored`：清除降级位与状态行、恢复 `waiting`、提示「信令已恢复」 | `senderSession.test.ts` 改用它（原来是重发 `open` 的假路径，掩盖了缺口） |
| 跨 IP 接管时配额多减：接管 RPC 在途时旧 socket 已 `unregisterSocket` 并 release，`ejectExisting` 又无条件 release → 该 IP 上限被放宽且不自愈 | 归属判断与释放绑定：只有 `clientBySocket.get(existing) === existingClientKey` 时才 delete + release | `signalingHub.test.ts`「跨 IP 接管时旧 socket 先断开：配额只释放一次」（负对照：改回无条件 release ⇒ 红） |
| 屏幕共享重建时的 proof 组装/落盘/清理散在组件里，调用点无测试 | 抽 `services/screenShare/screenShareSessionProof.ts`（room + storage 注入）：`resolveScreenSharePeerCredentials` / `rememberScreenShareSessionProof` / `forgetScreenShareSessionProof` | `screenShareSessionProof.test.ts`（有 proof 时凭证不带 `sessionSecretHash`、storage 损坏不抛、终态清理后为空） |
| 第 7 个观众被拒时发 `{type:'share-full'}` 的分支无测试；data conn 未登记时观众只看到「连接超时…检查网络」而不是「人数已满」 | 抽 `planViewerAdmission`（`admit` / `reject-share-full` + `reserveSeat` + `delivery`）与 `deliverShareFull`（已登记连接直发，未登记反向连一条） | `viewerAdmission.test.ts` +151 行（pending 占位、已满、dc 未登记仍能投放）；E2E 见下行 |
| 三条失败路径只有单测、没有真实浏览器证据 | `e2e/screenshare.spec.ts` 新增：房号过期（琥珀「链接已失效」+ 复制禁用）、停止→立刻重开（30s 内重新出现链接）、观众媒体失败（重试提示 → 「重试连接」终态） | 新增 3 条 + 2 条既有终态用例，product 套件 **11 passed (1.2m)** |
| `src/worker.ts` 默认导出 `fetch` 从未执行：同源门/鉴权/分派被改坏仍全绿 | 把 `isAllowedSameOriginRequest` 逐字抽到 `services/signaling/httpOriginPolicy.ts`；`services/signaling/workerEntry.test.ts` 直接驱动入口 fetch | `httpOriginPolicy.test.ts`（10 例）+ `workerEntry.test.ts`（9 例：ASSETS/426/403/400/101 + share-code HMAC/429）；worker.ts 行覆盖 71.53% → **81.75%**、函数 53.33% → **68.13%**（第八轮快照；当前 87.49 / 73.85 / 79.41，见 §8.13）；负对照 16/19、3、1 条变红 |
| `--test-coverage-include` 只是报告过滤器：未被测试加载的文件按 0 计入分母的说法不成立（实测组件套件只报出 4 个文件），任何新模块只要没人 import 就完全逃过门槛 | `scripts/check-coverage-scope.mjs` 按 scope 运行（`--scope=services|components`）：期望清单来自 `git ls-files`，报告行数 < 期望 − 白名单即失败；报告里 line 覆盖率为 `0%` 且不在白名单的文件同样失败（「进了分母但一行没跑」不算回归证据）；解析先剥 ANSI、行首标记可选（本地 `ℹ`、CI runner 上观察到 `#`），避免把「格式变了」误报成「所有文件都没加载」；`--self-test` 用内联 fixture 固定解析与判定规则；**不传 include**，分母完整性由 git 对比保证 | 负对照：去掉白名单过滤 ⇒ exit 1 并点名；`--scope=services` ⇒ 118 个生产源文件 / 报告 116 行 / 例外 2；`--scope=components` ⇒ 13 个生产文件 / 报告 10 行 / 例外 3（第八轮快照；当前数字见 §8.12）；CI run `43557683645` 复现「报告完整但解析 0 行」，`43558142248` 转绿；全仓行覆盖 89.78% |
| 组件覆盖率门禁是假的：`components/Receiver.tsx`（3367 行）、`components/ScreenShare.tsx`（2823 行）、`components/Sender.tsx`（1670 行）在组件套件里一行都没进报告，而 CI 注释宣称「未加载组件按 0 计入」 | 把同一个守卫扩到 components scope：期望清单 = `git ls-files components` 的 `.ts/.tsx` 去掉测试文件；白名单只收「Node 宿主里确实无法 import」的三个组件（`Receiver.tsx` 顶层访问 document，`ScreenShare.tsx` / `Sender.tsx` 顶层访问 window，交互分别由 Playwright e2e 与 `test:e2e:product-transfer` 覆盖）；能加载却没人测的组件（`ErrorBoundary.tsx`、`PWAInstallPrompt.tsx`）用 `scripts/component-import-smoke.test.ts` 拉进分母，不允许进白名单；因此 components scope 的测试目标是 `['components', 'scripts/component-import-smoke.test.ts']` | 真实分母 13 个生产文件、10 个必须出现且全部在册；门槛只按 scope 内行判定（当轮快照 63.35 行 / 68.42 分支 / 42.86 函数；当前 65.24 / 69.95 / 42.86，见 §8.13）；负对照：把白名单扩到可加载组件 ⇒ 该文件立刻被判缺测试 |
| 覆盖率过滤器探测失败会静默退化（Node 22.12 没有 `--test-coverage-include`） | `buildNodeTestArgs` 在 `NODE_TEST_COVERAGE=1` 但过滤器不可用时直接 throw，不再只统计已加载文件 | `run-node-tests.test.ts` +3 例（throw、两旗标判定、include/exclude 参数） |
| 补测 6 个从未被 import 的模块（`fileUtils`、`routeProbeLog`、`logicalReceiverSessions`、`committedReconnectResume`、`receiverRouteSessionId`、`sessionTransferState`） | 逐模块补真值表/边界用例，而不是只「import 一次」凑覆盖率 | `services` 552 → **606 tests**；`services/signaling` 137 pass |

仍然存在的已知取舍（本轮之后）：

- proof 仍走 WS URL query；改首帧要同时改两端注册协议，属破坏性升级。
- `services/receive/persistedDirectoryHandle.ts`（File System Access）、`services/receive/sessionCoordinator.ts`（需真实 IndexedDB/OPFS）、`services/crc32.worker.ts`（Web Worker 入口）三个文件无法在 Node 宿主加载，是 `ALLOWED_UNCOVERED` 里仅有的例外。
- DO 内部端点（`/internal/*`）仍是逐行读码 + 入口层不可达证明，没有直调用例：它们只由另一个 DO 调用，测试替身无法验证真实 RPC 语义。
- E2E 里「长时共享后重建带 proof」仍靠单测与结构保证：CI 不适合等 10 分钟。
- 屏幕共享仍是 mesh（`MAX_VIEWERS=6`、16 Mbps 聚合预算）；`Receiver.tsx` / `ScreenShare.tsx` 仍是千行组件。

## 8.8 第六轮复评后的补齐（2026-11-14）

三项复评：安全 **95**（`reachable_95: yes`）、产品 **91**、工程 **92**。安全不再有必改项；产品与工程的缺口按下表补齐。

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| 同 IP 接管的席位「转移」用 `reserve-global-slot` 之前读到的 `existingClientKey`：旧 socket 若在该 RPC 期间关闭，transfer 既不 acquire 也不 release，新连接不计数，每出口 IP 上限被悄悄放宽（仅分片模式） | `src/worker.ts` 在 `ejectExisting` 里按实际归属补判：`ownsExistingClient` 为真则把席位记在新连接账上（`seatAcquired = true`，失败回滚才释放得回去），否则补一次 `tryAcquire`；补领失败置 `seatTransferLost`，动作跑完后回滚名额并按 `rate-limited`/4029 拒绝 | `signalingHub.test.ts` 两例：①「同 IP 接管时旧 socket 在名额 RPC 期间断开：席位要补领」（负对照：去掉补领 ⇒ 该 IP 的第 2 条被错误放行，红）；②「同 IP 接管投递 registered 失败：席位随回滚释放」（负对照：不记 transfers 席位 ⇒ 该 IP 名额被永久吃掉，红） |
| 握手预算模块注释写着「单例模式不会消耗预算」，与 `src/worker.ts:949` 的无条件消费相反 | 注释改为「单例模式没有这次 RPC，但预算仍对所有握手生效：计费点在 accept 之前、不区分模式」 | 注释与代码对齐，行为不变（无需测试） |
| 第 7 个观众：share-full 是 best-effort，送达失败时静默返回，观众侧又把 `call.close` 当断链重连 → 20s 后报「连接超时，请检查网络」 | 抽 `services/screenShare/viewerShareFullFallback.ts`：`planViewerCallEndOutcome` 只在「没收到画面且数据通道从未 open」时判 `suspected-share-full`（保守，避免把真网络故障误诊为人数问题），且不自动重连；`shareFullTelemetry` 记录送达失败 | `viewerShareFullFallback.test.ts` + `shareFullTelemetry.test.ts`；`e2e/screenshare.spec.ts` 新增 7 观众满员用例（断言「人数已满」而不是超时文案） |
| 分享端两条终态（重建耗尽、首连看门狗）只有代码没有测试 | 抽 `services/screenShare/sharerRecoveryPolicy.ts`：`planSharerRecovery` 枚举 `terminal`/`initialize-peer`/`retry-signaling`/`rebuild-peer`/`wait`，`planSharerFirstConnectWatchdog` 判超时；`retry-signaling` 之后用重读的状态再判一次，保持旧实现「retry 后可能当场重建」的语义 | `sharerRecoveryPolicy.test.ts`（预算耗尽必进终态、retry 后重读、watchdog 不误判已就绪）；负对照：去掉 peerMissing 的终态分支 ⇒ 红 |
| 分享端复用观众视角文案（「请让发送端重新分享」「换一个口令」），而用户自己就是发送端 | `services/connectionGuidance.ts` 新增 `getSharerPeerRuntimeErrorMessage`（unauthorized / unavailable-id → 「分享凭证已过期，请重新开始共享（旧链接会失效）」）与 `getSuspectedShareFullMessage` | `connectionGuidance.test.ts` 分享端分支 + 回退（负对照：把分享端分支改 false ⇒ 红） |
| 登记结果还没回来就发「屏幕共享已开始」 | `services/screenShare/shareStartNotice.ts`：`queue` 只排队，`takeOnReady` 在信令 ready 后才取走并提示一次 | `shareStartNotice.test.ts`（未 ready 不取、只取一次） |
| 429 给了 `Retry-After` 却不展示，终态唯一次 CTA 正是会再次 429 的动作 | `services/screenShare/shareRoomRetryCooldown.ts`：`describeShareRoomRetryCooldown(retryAt, now)` → `{secondsLeft, canRetry}`；`ScreenShareUI` 冷却期禁用「重新开始共享」并显示「N 秒后可重试」 | `shareRoomRetryCooldown.test.ts` + `ScreenShareUI.test.ts`（删秒数插值 / `disabled` 改 false ⇒ 红） |
| 房号过期检测 60s 轮询，最长 1 分钟内链接仍可复制、徽章仍「正在共享」 | `services/screenShare/shareRoomExpiry.ts`：按 `expiresAt` 挂一次性 `setTimeout`，续期成功自动重排 | `shareRoomExpiry.test.ts` + `ScreenShareUI.test.ts`（过期卡主按钮） |
| `SHARE_SIGNALING_LOST_MESSAGE` 一屏出现三次（状态行 + 琥珀提示 + toast） | 状态行只留短状态「链接已失效」，长句只在琥珀提示出现；`senderSession` 删掉重复 toast | `senderSession.test.ts:647`（恢复 notify 的负对照 ⇒ 红） |

仍然存在的已知取舍（本节之后）：

- **offer 限流是每出口 IP 每分钟 24 条、每个观众需 2 条**（`SIGNALING_OFFER_RATE_LIMIT`，`services/signalingRateLimitPolicy.ts`）：24 恰好容得下 6 个观众各一次重连。这是有意的滥用防护，不是缺陷；7 观众用例因此能在单个窗口内占满（用例约 27s），但同一 preview 进程连跑多个吃配额的用例仍会互相干扰，重跑前必须重启 preview（workerd 内存里的计数与封锁期不会自清）。
- 满员提示分「确定的 share-full」与「疑似推断」两条分支；E2E 只断言 `/人数已满/` 任一命中，推断分支由单测钉住。
- `components/Receiver.tsx`（3367 行）仍因 streamsaver 在模块顶层读 `document` 而无法在 Node 里 import，只能靠 Playwright 覆盖（`ScreenShare.tsx` / `Sender.tsx` 已可通过惰性信令基址 import，只是没有渲染层测试）；`noUncheckedIndexedAccess` 实测 200 个错误，本轮未启用。
- 活跃分享口令行没有全局上限（安全评审判为低危可用性项）：每个 IP 10 次/10s、24h TTL，多 IP 可持续占码。

## 8.9 第七轮复评后的补齐（2026-11-14）

三项复评：安全 **88**（`reachable_95: yes`）、产品 **88**、工程 **93**。三边缺口按下表补齐；本轮不再新增依赖、不改 `package.json`。

### 安全（P1–P5）

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| **P1 分片名额 fail-open**：`reserveSignalingSessionSlot` 非 2xx 与异常都返回 `true`，调用侧当作已授予并写入一个从未落库的 slotId。shard 0 抖动时整台出口 IP 绕过全局 12 会话上限（`src/worker.ts:1972-1997`） | 名额判定改三态 `'granted' \| 'exhausted' \| 'unavailable'`；`unavailable` 走新 `respondSlotUnavailable()`：先 `close(1013)` 再回 `503 + Retry-After: SIGNALING_QUOTA_UNAVAILABLE_RETRY_AFTER_SECONDS`（5s，`constants/signaling.ts`），不再注册成功 | `signalingHub.test.ts`「shard 0 名额表不可达：升级回 503 + Retry-After」（断言 `webSocket === null`、`closedCode === 1013`、本地槽位行 0、指标 `signal_session_slot_unavailable` 且无 `..._rejected`）；负对照：把 `unavailable` 当 `granted` ⇒ 503 变 101，红 |
| **P2 口令重登记先删后插**：`registerShareCode` 先按 peer_id 无条件删旧码再分配新码；自定义码撞车时旧活跃码已被销毁，观众 404、发送端重连 unauthorized（`src/worker.ts:2082-2084`） | `insertShareCode` 改 upsert：`ON CONFLICT(code) DO UPDATE ... WHERE share_codes.peer_id = excluded.peer_id`（同 peerId 原地续期，别家撞车时旧行不动）；`deleteShareCodesByPeerId(sql, peerId, keepCode?)` 只删刚分配成功的同一 peer 的其它码；`registerShareCode` 改为「先分配成功，再删旧码」 | 两条 SQLite 契约用例（抢码时旧行分毫未动、keepCode 保留新码）+ `signalingHub.test.ts`「口令重登记撞车：旧活跃码必须原样保留」（抢码 409、owner 原码 lookup 仍 200）；负对照：恢复先删后插 ⇒ 旧码 404，红 |
| **P3 凭证在 URL query**：token / sessionProof 落在完整 URL，被边缘与代理日志捕获；先进日志者还能抢先轮换把原持有者锁成 4010（`services/peerRuntime.ts:250-263`、`src/worker.ts:934-942`） | 新增 `services/signaling/wsCredentialTransport.ts`：凭证 JSON → base64url 编进 `Sec-WebSocket-Protocol`（`aerodrop.v1` + 凭证协议），`peerRuntime` 改 `new WebSocket(url, protocols)`、URL 只留 `peerId`；worker 升级路径协议头优先、query 回落（旧页面兜底），`acceptClient()` 统一 101 且只回显非秘密协议 | `wsCredentialTransport.test.ts`（往返、非 ASCII、坏 base64/坏 JSON/字段类型错 → null）+ `signalingHub.test.ts`「只带协议头可注册并保持 4010 语义」「协议头坏掉回落 query」+ `peerRuntime.test.ts`（query 无秘密） |
| **P4（低）未绑定会话可被无限次接管**：在首次绑定建立前的窗口里，知道 peerId 即可反复踢下线 | 未在本轮修：首次注册也签发 proof 需要改客户端首连与观众路径，风险大于收益；保持「24h 绑定 + 60s 摘要窗口」并把窗口以外的接管全部 4010 | 现状即有覆盖（`sessionBinding.test.ts` 摘要窗口用例；`signalingHub.test.ts` 无凭证接管 4010）。已记入下方已知取舍 |
| **P5 读路径写库**：`findActiveShareCode` 每次都跑 `deleteExpiredShareCodes`，未认证 `GET /api/share-code/:code` 会在 shard 0 开写事务 | 读路径只按 `expires_at` / `revoke_after` 过滤，不再清理；过期清理由写路径（登记/撤销/恢复前的 `purgeExpiredShareCodes`）与 alarm 承担 | `sessionStore.sqlite.test.ts`「读路径只过滤不写库（行数 1、无墓碑）」；负对照：读路径恢复删除 ⇒ 行数变 0，红 |

### 产品（第七轮 88 → 目标的 3 条）

| 缺口（复评） | 修法 | 回归测试 |
| --- | --- | --- |
| **同出口第 5–6 个观众被 offer 限流拦住**（10 条/分、每人 2 条），而且拒绝被当成「人数已满」展示；被误锁的整出口还得等 10 分钟 | `constants/signaling.ts` 新增 `SIGNALING_OFFER_RATE_LIMIT = { windowMs: 60_000, maxAttemptsPerClientWindow: 24, blockMs: 60_000 }`（24 = 6 观众首连 + 各自一次重连；静默期 10 分钟 → 1 个窗口，因为整出口被锁时刷新也救不回来），`services/signalingRateLimitPolicy.ts` 的默认值改为引用它；新增 `services/screenShare/viewerPeerErrorPolicy.ts` 的 `planViewerPeerError` → `ignore`/`share-gone`/`rate-limited`/`report`，观众 `peer.on('error')` 先判限流再判满员；`viewerShareFullFallback` 增加 `rateLimited` 输入与 `'rate-limited'` 结论（顺序：share-ended → share-full → manual-stop → rate-limited → suspected-share-full → reconnect），后续 `call.close` 不会把限流结论覆盖成「可能人数已满」 | `signalingRateLimitPolicy.test.ts`「默认配额容得下同一出口坐满 6 个观众」（负对照：24 改回 10 ⇒ 红）；`viewerShareFullFallback.test.ts`「同一出口被限流时先判限流」（负对照：删 `rateLimited && !receivedStream` 分支 ⇒ 红）；E2E 负对照：`maxAttemptsPerClientWindow` 改回 10 ⇒ 7 观众用例因第 6 个被出口限流而红（`viewer video never produced frames`） |
| 限流拒绝只有 `code`，客户端拿不到该等多久，只能显示「立刻可重试」，再点又 429 | 端到端下发 `retryAfterMs`：`src/worker.ts` 的 `sendError(...)` 增第 7 参并在 offer 限流分支传 `rateLimitDecision.retryAfterMs`（`SignalingEnvelope` 的 error 变体加可选字段）；`services/peerRuntime.ts` 的 `ErrorEnvelope` 解析该字段并挂到 `PeerRuntimeError.retryAfterMs`；`ScreenShare` 用已有的 `readRetryAfterMs` 读它，缺失时回退 `SIGNALING_OFFER_RATE_LIMIT.blockMs`（倒计时宁可偏长）；`ScreenShareUI` 冷却期禁用「重试连接」并显示「N 秒后可重试」 | `signalingHub.test.ts`「offer 限流的 error 必须带上 retryAfterMs」（负对照：不传第 7 参 ⇒ 红）；`peerRuntime.test.ts`「rate-limited 信封把 retryAfterMs 透给上层」（无字段时保持 `undefined`，不许凭空造值）；`ScreenShareUI.test.ts` 冷却禁用 + 倒计时（负对照：`disabled` 改 false ⇒ 红） |
| 打开已停止/已过期的链接：自动重试 5 次（2/4/6/8/10s），30s 后落到「请手动重试」，还把这条死链留在 sessionStorage 里，刷新继续重连 | `services/connectionGuidance.ts` 新增 `VIEWER_SHARE_GONE_MESSAGE = '分享已结束或链接已失效，请向分享者索取新链接'`；`planViewerPeerError` 把 `peer-unavailable` 直接判 `share-gone`；观众侧走 `stopViewing(true)`（顺带清掉持久化 viewId，刷新不再自动重连）+ 终态文案，删掉整条重试链 | `viewerPeerErrorPolicy.test.ts`「分享者不存在直接终态」（负对照：该分支改 false ⇒ 红）；`connectionGuidance.test.ts`「分享已结束的观众进终态」（负对照：文案换回「连接超时，请检查网络」⇒ 红） |
| 房号过期后点「重新开始共享」会新建房间，正在观看的观众全部掉线，而文案只说「新观众无法加入」 | 不做「复用旧房号」（要 bump `peerSessionToken` 并重建 Peer，改动面过大且无法在不改协议的前提下证明观众存活）；把 `ScreenShareUI` 的过期卡文案改为「分享链接已失效，需要重新开始共享才能让新观众加入；重新开始会新建房间，正在观看的观众会断开」 | `ScreenShareUI.test.ts`「过期卡说明会断开现有观众」（负对照：删掉后半句 ⇒ 红） |

顺带把 `services/screenShare/shareRoomRetryCooldown.ts` 泛化为 `retryCooldown.ts`（`describeRetryCooldown`），房号冷却与观众「重试连接」冷却共用一个实现。

### 工程（A / B / D）

| 缺口（复评） | 修法 | 验证 |
| --- | --- | --- |
| **A** screenshare 的 9 条 E2E 不在 CI（`ci.yml:82`、`playwright.config.ts:5` 的 `testIgnore`），"产品级回归"只在本地跑过 | `.github/workflows/ci.yml` 新增独立 job `e2e-product`（ubuntu-24.04，timeout 30m）：`npm ci` → 装 chromium → 断言 8787 空闲 → `npm run test:e2e:product-transfer`（= `npm run build` 的生产构建 + `wrangler dev` local:8787；注意它**不是** `vite build --mode e2e`，跑的是真实 Worker）→ `if: always()` 清理 wrangler/workerd → 失败上传 `test-results/` 与 `playwright-report/` | 本地同命令 **12 passed / 3m38.9s**；负对照（改坏满员终态文案断言）同一命令链 exit 1，随后还原；CI YAML 用 PyYAML 解析确认 3 个 job |
| **B** 覆盖率守卫按 basename 比对，同名文件（如两处 `Receiver.tsx`）会互相遮蔽，缺文件也能过关 | `parseReport` 保留报告里的完整路径；`resolveRowFiles(name, expected)` 先精确匹配相对路径、再按路径后缀匹配；后缀命中多个文件即 `ambiguous` 失败（把遮蔽变成红灯） | `--self-test` 从 9 条扩到 **12/12**（含遮蔽 fixture）；负对照：把脚本复制到 `.tmp/` 改回 basename 语义 ⇒ `--self-test` exit 1；真实树 services（117 个生产文件；services+src 共 118）与 components（13 文件）两端 OK |
| **D** `docs/ROADMAP-next.md` 过度声明「CI 覆盖率与 E2E job 完成」 | 改写为准确的三段式：`verify`（typecheck + 单测 + 两个 scope 的分母守卫 + build）、`e2e`（chromium，只跑 sender-sharing / receiver-recovery）、`e2e-product`（真实 workerd + product config），并写明 CI **不拦** Cloudflare Git 集成部署，除非在分支保护里设为必需检查 | 文档与 `ci.yml` 的 job 名一一对应 |
| **C**（未修，记录）结构债：`components/Receiver.tsx` 3367 行、`ScreenShare.tsx` 2823 行、`Sender.tsx` 1670 行；生产代码 16 处 `as any` 分布在 `ScreenShare.tsx` 11、`Sender.tsx` 2、`services/send/sendFileSequence.ts` 1、`services/peerRuntime.ts` 1、`services/crc32.worker.ts` 1；`noUncheckedIndexedAccess` 实测 200 个错误 | 本轮不拆（拆 3000 行组件超出「补齐复评缺口」的范围，且会与产品修复抢同一批行）；`noUncheckedIndexedAccess` 实测超门槛不启用 | 数字记在本表，供下一阶段立项 |

## 8.10 第八轮补齐（2026-11-14）

第七轮复评为安全 90 / 产品 91 / 工程 91，三条都判「未达 95」。本轮按评审给的 must-fix 逐条收口。

### 安全（名额账本的三处 fail-open）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| 名额按 `slot_id` 盲删：并发接管时落败方复用同一个 slotId 回滚，`DELETE ... WHERE slot_id = ?` 会把胜出方刚拿到、并且已经投递完 `registered` 的名额删掉（全局 12 会话上限被悄悄放宽） | `services/signaling/sessionStore.ts` 的 `applySessionSlotRelease(sql, slotId, clientKey?)` 带归属条件删除；`src/worker.ts` 的 `releaseSignalingSessionSlot`、`rollbackQuota`、`unregisterSocket`（把 `clientKey` 读取提到 slot 块之前）与 `/internal/session-slot` 的 `release` 分支全部透传 clientKey。**注意：clientKey 方案在第十轮被证明无效（clientKey 是出口 IP，并发接管时双方相同）并已被每连接自铸的 `releaseToken` 取代，见 §8.11、§8.12；本节保留的是当时的过渡状态** | `sessionStore.test.ts`「带 clientKey 时 SQL 必须含 `AND client_key = ?` 且参数顺序正确，不传时保持旧语义」；`sessionStore.sqlite.test.ts`「别的 client 释放同一个 slotId 是空操作」（负对照：去掉条件 ⇒ 该断言红） |
| 名额 RPC 的 2xx 坏 body 被当成 granted：`{}`、字段改名或被截断的 JSON 都能让任何连接绕过全局名额 | `reserveSignalingSessionSlot` 只认 `body.granted === true` 为 granted、`=== false` 为 exhausted，其余一律 `unavailable` + warn（调用方回 503 + Retry-After） | `signalingHub.test.ts`「shard 0 名额表不可达 ⇒ 503 + Retry-After + 1013」（负对照：把 unavailable 当 granted ⇒ 503 变 101，红） |
| reserve 响应丢失时不回收已落库的新 slotId：每次重试留一行孤儿，12 行就能把整片名额占到 6h TTL 之后 | `reserveGlobalSlot` 的 `unavailable` 分支**无条件**`ctx.waitUntil(releaseSignalingSessionSlot(slotId, slotReleaseToken))`。每条连接（含接管）都用自己新铸的 slotId + token，所以回收只可能删到自己那张；条件删除的 token 不匹配时是 no-op，不会误删别人的行 | `signalingHub.test.ts`「接管时名额 RPC 丢响应：本次新铸的 slotId 必须按自己的 token 回收，不留孤儿行」（接管 503、只发一次 release、slotId 与 token 都对得上本次连接、旧会话仍在册）；负对照：把回收改回 `if (!isTakeover)` ⇒ 该用例红 |

### 产品（拒绝文案归因 + 限流优先级）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| 每出口会话数（12 个/IP）的拒绝被显示成「连接请求过多，60 秒后可重试」——名额被同出口别的标签页占着，等多久都没用 | error 信封新增 `limit: 'session' \| 'offer'`（`src/worker.ts` 的 `sendError` 第 8 参、`respondRateLimited` 标 session、offer 限流标 offer）；`services/peerRuntime.ts` 透传到 `PeerRuntimeError.limit`；`planViewerPeerError` 新增 `session-limit` 结论；观众侧显示 `VIEWER_SESSION_LIMIT_MESSAGE`（「同一网络下的其他设备占用了连接名额…」），不给倒计时 | `signalingHub.test.ts` 4029 用例断言 `limit === 'session'`、offer 用例断言 `limit === 'offer'`；`peerRuntime.test.ts` 断言 `limit` 透传且缺失时不伪造；`viewerPeerErrorPolicy.test.ts`「session 不给倒计时、offer/未标仍走倒计时」 |
| 媒体 offer 被限流时 `call.on('error')` 先跑满员推断：用户先看到「分享人数已满」，随后才被限流文案覆盖，或干脆停在满员终态 | 观众侧 `call.on('error')` 先读 `err.type === 'rate-limited'`：`limit === 'session'` 直接终态，否则置 `viewerRateLimitedRef` 并 `reportViewerRateLimited`，不再走满员推断 | 逻辑由 `viewerPeerErrorPolicy` 单测钉住；`ScreenShare.tsx` 的状态机仍无渲染层测试（仓库现状） |

### 工程（E2E 能力探测 + 文档数字）

| 缺口 | 修法 | 验证 |
| --- | --- | --- |
| `e2e/screenshare.spec.ts` 9 处 skip 谓词 `typeof navigator.mediaDevices?.getDisplayMedia === 'function'` 恒为真，等于永不 skip——没有 fake capture 的环境会硬红而不是跳过 | 换成 `ensureDisplayCapture(page)`：真的调一次 `getDisplayMedia` 并立刻 stop，抛错才 skip（9 处调用点全替换） | 本地 `test:e2e` 9 passed；CI `e2e-product` job 绿 |
| 文档与 CI 注释里的数字过期（`as any` 分布、组件行数、`noUncheckedIndexedAccess` 错误数、services 文件数、组件覆盖率、`product-transfer` 的构建方式） | 以实测重写：`as any` 16 处分布在 ScreenShare 11 / Sender 2 / sendFileSequence 1 / peerRuntime 1 / crc32.worker 1；ScreenShare 2823 行；`noUncheckedIndexedAccess` 200 错；services 117、services+src 118；components 覆盖率改按 scope 判定（63.35/68.42/42.86，见 §8.10）；`test:e2e:product-transfer` = `npm run build` + `wrangler dev`（不是 `--mode e2e`） | 数字均由本轮命令重新统计 |

### 仍然存在的已知取舍

- query 回落仍保留（旧客户端兼容）；`Sec-WebSocket-Protocol` 是首选路径。
- `resolveSignalingClientKey` 缺 `CF-Connecting-IP` 时回落 `ip:unknown`（本地/测试环境才有意义）。
- 观众侧 `peer-unavailable` 先 3 秒有限重试一次，仍失败才落「分享暂时不可用」终态（§8.10 MF1）：分享端重建窗口内不再被误判为死链，但重试只有一次，长于 3 秒的重建仍会让观众看到终态提示。
- `retryAfterMs` 没有上限 clamp；DO-to-DO fetch 没有显式超时（依赖运行时）。
- 千行组件（Receiver 3367、ScreenShare 2823、Sender 1670）与 `noUncheckedIndexedAccess`（200 错）未处理；生产 16 处 `as any` 仍在。

## 8.11 第九轮复评后的补齐（2026-11-14，复评基线 86 / 92 / 85）

### 安全（名额账本的归属不能靠 clientKey）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| 并发接管同一个 `peerId` 时，两条连接都复用旧会话的 `slotId`；`applySessionSlotReserve` 对既有 `slot_id` 无条件 `UPDATE client_key`，后 reserve 的一方就把归属改成自己，落败方 `rollbackQuota` 按「条件删除」删掉的正是胜出方（已收到 `registered`）那行 → 该会话之后的 renew 永远失败，12 会话全局上限退化成「每片各 12 条」。用 `clientKey` 做归属从根上无效：它是出口 IP，同一 NAT 下完全相同 | ①每条连接都用自己新铸的 `slotId`，`release_token = crypto.randomUUID()` 随 `SessionAttachment.slotReleaseToken` 一起持久化（socket 关闭时才找得回来）；②release 改成 `DELETE ... WHERE slot_id = ? AND release_token = ?`；③接管改用 `replaces: { slotId, releaseToken }` 在同一次 reserve 决策里让出旧行——按 `client_key` 计数时命中条件行就扣 1（IP 满额时接管仍能进来），判定通过后才按 token 删旧行，最后 `INSERT` 新行 | `sessionStore.sqlite.test.ts`「接管换名额：旧行靠 token 条件让出，并发接管事后只剩一条活名额」（满额 1/1 仍可接管、token 不符不删不绕过上限、落败方 token 删不到胜出方行）；`signalingHub.test.ts`「并发接管同一会话：事后只剩一条名额，且它归属已注册的那条连接」（旧会话先注册 → 第一个接管方的 reserve 在途时让第二个接管完整落定 → 断言恰好一条 `registered`、落败方 4010、槽位只剩 1 行且 `release_token` 等于胜出方 attachment 的 token、`applySessionSlotRenew` 仍为 true）；负对照：把 `reserveGlobalSlot` 改回复用 `existingAttachment.slotId` ⇒ 该用例红（`0 !== 1`） |

### 产品（重连窗口、采集泄漏、错误条、冷却）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| 分享端重建 Peer 的几秒窗口里，观众被 `peer-unavailable` 直接判成「链接已失效，请向分享者索取新链接」——可链接一直是有效的（重建复用同一房号） | `viewerPeerErrorPolicy` 的 `peer-unavailable` 改为「有限重试」：`shareUnavailableAttempts < maxShareUnavailableRetries` 返回 `share-unavailable-retry`，用尽才是 `share-unavailable`；常量 `SCREEN_SHARE_SHARE_UNAVAILABLE_RETRY_MS = 3_000`、`SCREEN_SHARE_SHARE_UNAVAILABLE_MAX_RETRIES = 1`；终态文案改为「分享暂时不可用（可能已结束，或分享者正在重连），请稍后重新打开此链接」，重试期文案「分享者暂时不在线，正在重试…」；收到画面时把重试预算清零 | `viewerPeerErrorPolicy.test.ts`「分享者先查不到时有限重试一次」；`connectionGuidance.test.ts` 终态/重试文案两条；负对照：分支加 `&& false` ⇒ 红，文案改回「链接已失效」⇒ 两条文案断言红 |
| 房号过期后点「重新开始共享」没停旧采集：`streamRef` 仍指向旧流，覆盖前不 stop 旧轨，旧轨的 `onended` 还绑着 `stopScreenShare` → 旧采集继续跑、关闭旧采集会把新分享一起停掉 | 新增 `services/screenShare/shareStreamLifecycle.ts` 的 `releaseCapturedStream`：先摘 `videoTrack.onended` 再停全部轨道；`releaseShareStream`、`startScreenShare` 覆盖前、切换窗口三处都走它 | `shareStreamLifecycle.test.ts`「停轨之前先摘掉旧轨的 onended」；负对照：去掉摘除 ⇒ 红 |
| 观看中收到信令级 peer 错误会落一条不可关闭的红条，画面其实还在放；恢复与出画面都不清它 | 新增 `services/screenShare/viewerErrorSurface.ts` 的 `planViewerErrorSurface`：媒体仍健康时吞掉信令错误（只记 warn）；`ScreenShareUI` 通用红条加「关闭提示」按钮（`dismissError`）；`signaling:restored` 清旧错误（限流文案保留，它自带倒计时）；收到画面时 `setError(null)` | `viewerErrorSurface.test.ts`「画面还在放时的信令错误不落红条」；`ScreenShareUI.test.ts`「通用错误条带关闭入口」；负对照：永远返回 `'surface'` ⇒ 红；红条 `aria-label` 改坏 ⇒ 红 |
| 429 冷却可被绕过：点「关闭」只清终态卡，主按钮「开始共享屏幕」没有 disabled，`startScreenShare` 直接清 `shareRoomRetryAt` | 冷却跨终态卡保留：`startScreenShare` 冷却期直接 return、只在 `Date.now() >= shareRoomRetryAt` 时才清；`stopScreenShare` 顺带清；主 CTA 与过期卡按钮 `disabled` + `aria-describedby` 带剩余秒数 | `ScreenShareUI.test.ts`「冷却期内主按钮禁用并显示倒计时」「房号过期卡的『重新开始共享』同样禁用」；负对照：`disabled={false}` ⇒ 红（断言已改成「禁用属性必须出现在含目标文案的那颗 button 内」，避免同屏复制按钮造成的假绿） |
| 状态区对读屏不可见；只是信令抖动时链接标题也写「已失效」 | 状态区 `role="status" aria-live="polite"`；标题区分「分享链接暂不可用」/「分享链接已失效」 | `ScreenShareUI.test.ts` 两条（去掉 `aria-live` ⇒ 红；标题写死「已失效」⇒ 红） |

### 工程（门槛口径、白名单、惰性基址、失败证据、CI skip、死代码）

| 缺口 | 修法 | 验证 |
| --- | --- | --- |
| 组件覆盖率门槛其实是「整份报告」的门槛：报告 16 行里 9 个组件 + 7 个范围外文件，组件真实覆盖率跌到 ~51.8% 仍能过 60 | `SCOPES.components.coverageExclude = ['services/**','constants/**','types/**','src/**']`，用 `NODE_TEST_COVERAGE_EXCLUDE` 让 node 自己算 `all files` 汇总行，门槛只按 scope 内行判定；成功输出同时打印「scope 内」与「混合口径（仅参考）」。顺带修了解析的真 bug：报告是**按目录分组 + 缩进的裸文件名**，旧逻辑会把 `constants/signaling.ts` 认成 `services/signaling.ts` | 实测组件 scope 内 **63.35 行 / 68.42 分支 / 42.86 函数**（门槛 60/58/40），混合口径 68.60/68.37/41.94 只打印；负对照：`--min-lines=64` ⇒ 红（按旧混合口径 68.60 会过）；`--self-test` 18 条 fixture（分组缩进还原、同名遮蔽、范围外污染、门槛口径、未跟踪文件） |
| 白名单理由与代码不符：`sessionCoordinator` 其实全注入 IoC 却没有测试；`crc32.worker` 的理由引用了一个不存在的测试文件 | `services/receive/sessionCoordinator.ts` 移出白名单，新增 18 条单测覆盖三个 repair 分支与收尾（行覆盖 99.60%）；`crc32.worker.ts` 理由改为「模块顶层读 `self` 并挂 `self.onmessage`，Node 无 `self`」；`persistedDirectoryHandle.ts` 理由改为「存的是 FileSystemDirectoryHandle，Node 造不出可结构化克隆的句柄」；新增数据驱动卫生检查：路径必须在 `git ls-files` 里、理由 ≥20 字、理由引用的测试文件必须存在、`coverageExclude` 不得排掉本 scope 自己的文件 | 负对照：临时移走 `sessionCoordinator.test.ts` ⇒ 门禁报「没有被任何测试加载」并 exit 1；`--self-test` 覆盖卫生检查 |
| `services/peerRuntime.ts` 模块顶层读 `window.location.origin`，Node import 即抛 → `ScreenShare.tsx` / `Sender.tsx` / `Receiver.tsx` 永久进不了单测 | 改为惰性 `getSignalingBase()`：`VITE_*` 覆盖优先，`typeof window === 'undefined'` 时返回 `''` | `peerRuntime.test.ts` 两条：无浏览器全局的子进程 import 必须退出码 0；`window` 缺失返回 `''`、注入 origin 返回该值。负对照：还原顶层常量 ⇒ 「import 即抛」用例红 |
| E2E 失败没有证据：`retries: 0` 配 `trace: 'on-first-retry'` 等于永不产 trace，product 配置 trace 为 off，无截图/视频，CI 只上传从不产出的 `playwright-report/` | 两个配置 trace `retain-on-failure` + screenshot `only-on-failure`；两个 CI e2e job `if: always()` 上传 `test-results/`（`if-no-files-found: warn`），删掉不产出的目录 | 实证：写一条临时失败 spec ⇒ `test-results/.../{trace.zip, test-failed-1.png, error-context.md}` 三件齐全（临时 spec 已删） |
| screenshare 9 条在 CI 里可以整体 skip 仍绿：`ensureDisplayCapture` catch 所有异常后 `test.skip` | `process.env.CI` 下探测失败改 `expect(supported).toBe(true)` 并给出排查项，非 CI 才 skip | 负对照：`CI=1` + 去掉 fake-capture flags ⇒ `1 failed`（旧行为是 `1 skipped` 全绿） |
| `test:e2e:product-transfer` 里的 TURN 注入是死代码：生产包 `__AERODROP_E2E__` 不生效，init script 与 `getProductIceConfig` 只喂一条日志，`playwright.product.config.ts` 的注释与实现相反 | 删掉 `ProductIceConfig`、`getProductIceConfig`、`addInitScript` 注入与假日志分支（净 -46 行），把「生产构建里 E2E 钩子不生效」写成注释 | 删完 `test:e2e:product-transfer` 仍 12 passed |

### 本轮实测数字

- `--scope=services`：118 文件 / 报告 116 行 / 2 例外，scope 内 91.27 行 / 83.83 分支 / 84.69 函数；白名单预算 152/17361 行（0.88%，上限 5%）。
- `--scope=components`：13 文件 / 报告 10 行 / 3 例外，scope 内 65.24 / 69.95 / 42.86；白名单预算 7860/10412 行（75.49%，上限 80%）。
- 守卫脚本 `--self-test`：18 条 fixture。
- `noUncheckedIndexedAccess` 实测 200 个错误；生产 16 处 `as any`；`ScreenShare.tsx` 2823 行、`Receiver.tsx` 3367 行、`Sender.tsx` 1670 行、`src/worker.ts` 2471 行。
- 单测：services 711 / components 46 / scripts 14。

### 仍然存在的取舍

- 服务覆盖率门禁现在跑两遍（带 exclude 的判定 + 不带 exclude 的参考数字），本地约 34s、CI 相应变长：换来「判定口径」和「全仓数字」两件事互不污染。
- 组件渲染层仍无测试（仓库没有 jsdom/Testing Library，且不新增依赖），组件行为靠 Playwright 覆盖。
- CI 三个 job 是信号不是闸门：Cloudflare Git 集成的部署不读 GitHub 检查，除非在分支保护里把 `verify` / `e2e-product` 设为必需检查。

## 8.12 第十轮复评后的补齐（2026-11-14，复评基线 90 / 82 / 90）

### 安全（名额回收的旧假设、两条空断言）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| 接管现在也新铸 `slotId`，但 `reserveGlobalSlot` 的孤儿回收仍写着 `if (!isTakeover)`（照抄「接管复用旧会话 slotId」的旧假设）——分片模式下「接管 + shard 0 的 `/internal/session-slot` 丢响应」每次泄漏一行到 6h TTL，12 次后同出口全部 4029，而那行没人持有 token（生产未开分片，暴露面 0） | `unavailable` 分支改为**无条件** `ctx.waitUntil(releaseSignalingSessionSlot(slotId, slotReleaseToken))`：每条连接（含接管）都用自己新铸的 slotId + token，条件删除的 token 不匹配时是 no-op，所以只会删到自己那张 | `signalingHub.test.ts`「接管时名额 RPC 丢响应：本次新铸的 slotId 必须按自己的 token 回收，不留孤儿行」（接管 503、只发一次 release、slotId/token 与本次连接一致、旧会话仍 registered 且未被关）；负对照：改回 `if (!isTakeover)` ⇒ 红 |
| 「接管换名额」用例里 token 对不上的分支把 `replaces.slotId` 指向已经消失的 `slot-old`，等于只测了「陈旧 replaces」；把 `applySessionSlotRelease` 与 `replaces` 的 token 条件整个删掉，172 条测试仍全绿 | 改成让 `replaces` 指向**真实存在**、归属 `tok-new` 的那行但带旧 token：断言 reserve 返回 false（撞上限）、行数与归属都没变 | `sessionStore.sqlite.test.ts` 同一用例；负对照：去掉两处 `AND release_token = ?` ⇒ 3 条红（含 `slot release 带 releaseToken` 与并发接管用例） |
| 文档与注释按旧假设描述「接管复用旧会话的 slotId，不删避免误删」 | 改 `docs/design-scale-out.md` 该行与 §8.11 的措辞；`src/worker.ts`（`reserveGlobalSlot`、`unregisterSocket`）与 `services/signaling/sessionStore.ts`（`applySessionSlotRelease` 的 docblock）同步 | — |

### 产品（重试预算被清零、冷却 ticker、读屏、裸 stop）

| 缺口 | 修法 | 回归测试 |
| --- | --- | --- |
| `shareUnavailableAttemptsRef.current = 0` 与 `setViewerRetryAt(null)` 落在 `if (!isRetry)` **之外**：3s 重试分支把计数 +1，`connectToSharer(sharerId, true)` 又被清零 ⇒ attempts 永远 0 < 1，观众永远停在「正在连接」，每 3s 一轮注册+offer（≈20 次/分钟，刚好低于 24/60s 的限流），20s 全局超时也被清掉——「看起来正常实际坏了」。纯函数测试只测入参，SSR 组件测试看不到这条链 | 把这两行移进 `if (!isRetry)`，并在注释里写明「放在外面会让 3 秒自动重试每次清零计数，永远停在重试态」 | 新增 E2E「a link whose sharer has no live session ends in a terminal state instead of retrying forever」：用 `crypto.randomUUID()` 造一个从未注册的 peerId 打开 `/?view=<uuid>`，45s 内必须出现终态文案，随后 8s 内不许出现「正在重试」、也不许退化成「连接超时」（实测 3–4s 进终态并稳定）；负对照：把清零放回 `isRetry` 之外 ⇒ 该用例红（永不出现终态） |
| 冷却 ticker 不归零：`shareRoomRetryAt` / `viewerRetryAt` 到期后没有代码置 null，一次 429 之后 2800 行的 `ScreenShare.tsx` 永久 1Hz 重渲染 | 新增 effect：`describeRetryCooldown(...).canRetry` 为真时 `setXxxRetryAt(null)`（依赖里带 `retryCooldownTick`） | 冷却期禁用与倒计时的既有组件测试仍覆盖「有冷却」；归零由 effect + typecheck 兜底（无 SSR 级断言，记录为已知取舍） |
| 观众侧「正在连接」「错误+重试」「终态卡」都不是 live region；toast 全仓没有 `aria-live` | 四处按语义加 `role`/`aria-live`（连接中 `status`+`polite`，阻断错误与终态 `alert`+`assertive`，各带注释说明理由）；toast 用 sonner，其容器自带 `aria-live="polite"`，把配置抽成无 JSX 的 `components/toasterProps.ts`（`containerAriaLabel: '通知'`）让 `App.tsx` 可测 | `ScreenShareUI.test.ts` 4 条（同一标签内 `role=...[^>]*aria-live=...`）、`components/toasterProps.test.ts` 渲 `<Toaster {...TOASTER_PROPS} />` 断言 `aria-live="polite"` 与中文标签；负对照：逐个删 `role/aria-live` 或 `containerAriaLabel` ⇒ 对应断言红 |
| `stopScreenShare`、`failSharerSession`、卸载清理仍用裸 `getTracks().stop()`，没摘 `onended`（`track.stop()` 不触发 `ended`，暂无可见后果，但以后改成「stop + ended」就会误触发停止流程） | 三处统一走 `releaseCapturedStream`（先摘 `videoTrack.onended` 再停轨），组件内已无裸 `stop()` | `shareStreamLifecycle.test.ts`「释放之后旧轨迟到的 ended 不会再跑原回调」；负对照：去掉 `onended = null` ⇒ 红 |

### 工程（白名单机械上限、两条空保障、理由与事实、job 依赖）

| 缺口 | 修法 | 验证 |
| --- | --- | --- |
| 组件白名单没有机械上限：`Receiver.tsx` / `ScreenShare.tsx` / `Sender.tsx` 整块登记出分母后，组件门禁只在约 1/4 的组件代码上算 60%，而 `minimumReported` 会跟着条目数自动下降——再给一条白名单也照样过 | 新增 `allowlistBudget`：services `{maxEntries: 2, maxExcludedLineShare: 0.05}`、components `{maxEntries: 3, maxExcludedLineShare: 0.8}`，条目数与行数占比都判；`--self-test` 对条目数也判，行数占比只在运行时判（自检只 warn，否则真实树会让 `--self-test` 永久红、标志物失效） | `--scope=components` 打印「白名单预算 7860/10412 行（75.49%，上限 80%），条目上限 3 条」；负对照：上限改 0.7 ⇒ exit 1 且只余预算失败；给 components 加第 4 条 ⇒ 先撞条目上限 exit 1 |
| 自测里「分组缩进的裸文件名按目录栈还原」这条 fixture 是空的：把 `prefix` 置空它仍然通过（后缀兜底把裸名认成了 `services/send/sendFileSequence.ts`） | fixture 改成「两个目录各有 `sendChunkSize.ts`」，让后缀兜底产生遮蔽；`prefix` 置空后 3 条 fixture 立即红 | `--self-test` 18 条报告 fixture + 4 条预算 fixture + 3 条理由 fixture |
| 白名单理由的存在性检查被自身的 `.filter((file) => !/\.test\.(ts|tsx)$/)` 击穿：理由引用**真实存在**的测试文件反而报「不存在」，所以这段检查从未生效 | 改用 `git ls-files -co --exclude-standard`（含未跟踪、含测试文件）判断存在性 | 负对照：理由引用真实存在的 `services/connectionPolicy.test.ts` ⇒ 通过；引用不存在的 `services/hashUtils.test.ts` ⇒ exit 1 |
| 白名单理由与代码相反：`ScreenShare.tsx` / `Sender.tsx` 说「顶层访问 window」，但 M4 惰性化之后它们在 Node 里 import 得进来 | 理由改成真实情况：不是加载不了，是**没有测试 import 它**，渲染依赖真实 `getDisplayMedia`/`RTCPeerConnection`/`DataChannel`，由 `test:e2e` 与 `test:e2e:product-transfer` 覆盖；`Receiver.tsx` 保留 streamsaver 顶层读 `document` 的真实原因 | 理由文案在 `--scope` 成功输出里逐条打印，供复核 |
| CI 三个 job 互相没有 `needs`，任一红不影响其余；组件门禁又是一盏会随预算变色的灯 | `e2e` / `e2e-product` 都 `needs: verify`；组件门禁拆成独立 job `coverage-components`（不能塞进 verify，否则它一红浏览器用例就被整批 skip，等于抹掉刚接进 CI 的 screenshare E2E） | `.github/workflows/ci.yml`（PyYAML 解析 4 job，`needs` 如述） |

### 仍然存在的已知取舍

- 组件白名单占了约 75.49% 的组件行数，门禁实际只在四分之一的代码上算覆盖率；要真正降下来只能把 `ScreenShare`/`Receiver` 里可测的状态机继续抽到 `services/`（不新增测试依赖的前提下）。
- 冷却归零、三处采集释放只有 helper 契约测试 + typecheck，没有组件渲染级断言（仓库无 jsdom，且不加依赖）。
- CI 仍是信号不是闸门：Cloudflare Git 集成的部署不读 GitHub 检查，除非在分支保护里把 `verify` / `coverage-components` / `e2e-product` 设为必需。
- `components/Receiver.tsx`（3367 行）、`components/ScreenShare.tsx`（约 2800 行）的体量与 AGENTS「不在 components 里堆传输逻辑」仍有张力，拆分属结构性工作，未在本轮做。

### 8.13 第十一轮复评后的收口（2026-11-14）

第十一轮三项只读复评（安全 91 / 产品 91 / 工程 91，HEAD `c607f04`）没有 must-fix 之外的新架构问题，
但每项都抓到「上一轮修法只对了一半」的地方。逐条如下。

| 缺口 | 修法 | 验证 |
| --- | --- | --- |
| 安全：`replaces` 抵扣不看被顶替行的归属。`occupied` 从「本出口 IP 的行数」里减去一条被顶替行，但没检查那条行属于谁——B 接管 A 的会话时，等于拿 A 的名额抵 B 的上限，12 会话上限变成 13 | `services/signaling/sessionStore.ts` 的 `replaces` 查询改成 `SELECT slot_id, client_key ... WHERE slot_id = ? AND release_token = ?`，只有 `replaced[0].client_key === input.clientKey`（同一出口）才扣 1；注释写明「账本按出口 IP 记账，拿别人的行扣自己 IP 的数会让上限失真」 | 新增 SQLite 用例「跨出口接管：别人的名额不能拿来抵自己的上限」（ip:1、ip:2 各 1/1 满额，ip:2 接管 ip:1 必须 `false` 且两行原样）；负对照：判据改成 `replaced.length > 0` ⇒ 1 红 |
| 安全：注释与文档仍在描述「接管复用旧会话的 slotId」这个已被推翻的假设（`slotOwnerSocket` 注释、`/internal/session-slot` release 分支、`releaseSignalingSessionSlot` docblock、§8.11 的过渡段落） | 三处代码注释改成 `releaseToken` 语义（「槽位每次注册都新铸，接管也不例外；这里是防重复关闭时重复释放」）；§8.11 那段加显式作废说明，指向 §8.12/§8.13 | 读代码即真话；无行为改动，靠 typecheck + 既有 174 条信令测试兜底 |
| 产品：分享终态卡是 `role="alert" aria-live="assertive"`，而「N 秒后可重试」倒计时在它的子树里 ⇒ 1Hz 变化让读屏每秒重播整张卡（含失败原因） | `components/screen-share/ScreenShareUI.tsx` 把倒计时 `<p>` 移到 alert 容器的 `</div>` 之后（兄弟节点）；顺带把 9 处 `xxxRetrySeconds !== null` 改成 `typeof ... === 'number'`，防止 undefined 渲染成「undefined 秒后可重试」 | 新增两条 SSR 测试：用 `divDepthAt` 量出倒计时与 alert 的 div 嵌套深度 = 0；无冷却时不渲染「秒后可重试」；负对照：把倒计时塞回 alert 子树 ⇒ 1 红 |
| 产品（低）：`e2e/screenshare.spec.ts` 断言「连接超时，请检查网络」在仓库里不存在，等于永远为真 | 改成 `/连接超时\|请检查网络\|网络连接中断/`（这三类串在 `services/connectionGuidance.ts` 里真实存在），语义仍是「没有退化成通用网络故障」 | 断言语义不再是恒真；该用例本轮跑绿 |
| 产品（低）：「取消连接」按钮被包在 `role="status"` 的 live region 里；观众倒计时不在任何 live region 里 | 按钮移到 live region 外的独立容器；倒计时视觉部分 `aria-hidden`，另加 `sr-only` 的 `role="status" aria-live="polite"`，按 10 秒一档播报（避免每秒一次） | 新增两条测试：按钮与 status 容器的 div 深度 = 0；`30 秒内可重试` 出现在 polite live region 里；负对照：去掉 `role/aria-live` ⇒ 1 红 |
| 工程：白名单行数预算在 `totalLines === 0` 时静默失效（`totalLines > 0` 守卫直接跳过判定） | `evaluateAllowlistBudget` 在 `totalLines === 0 && entries.length > 0` 时记失败（文案「总行数算出来是 0」）；`BUDGET_CASES` 加一条对应 fixture | 负对照：给该分支加 `false &&` ⇒ `--self-test` 红 |
| 工程：白名单理由的存在性检查没有自测钉住；范围外白名单条目会静默降低 `minimumReported` | `runSelfTest` 用真实 `knownPaths` 铆钉两条断言（真实存在的 `scripts/check-coverage-scope.test.ts` 必须判存在）；`inspect` 新增 `strayAllowed`（白名单里有、本 scope 期望清单里没有）作为失败项，`minimumReported` 改成 `expected.filter(不在白名单).length` | 负对照：`strayAllowed` 分支加 `false &&` ⇒ 红；`knownPaths` 加回 `.filter(!/\.test\./)` ⇒ 红；`--self-test` 19 报告 fixture + 5 预算 fixture + 3 理由 fixture |
| 工程：文档与 CI 注释里的「实测」数字全错（services 117/118 文件、组件 13 文件 / 10 行、组件 scope 覆盖率、`ScreenShare.tsx` 2823 行、`worker.ts` 2471 行、单测 711/46/14、白名单预算 7860/10412 = 75.49%） | 以本轮命令重写 `docs/design-scale-out.md` §8.7–§8.12 与 `.github/workflows/ci.yml` 三处注释；§8.7 开头加「快照说明」横幅、旧数字标成当轮快照并指向 §8.13 | 数字全部来自本轮实际命令输出（见下） |

本轮实测（干净树，2026-11-14）：

- `npm run typecheck` → 0；`npm run test:all` → services **711** / components **46** / scripts **14** 全 pass。
- `--scope=services`：118 个生产源文件 / 报告 116 行 / 2 例外，scope 内 **91.27 / 83.83 / 84.69**，白名单预算 152/17361 行（0.88%，上限 5%）。
- `--scope=components`：13 文件 / 报告 10 行 / 3 例外，scope 内 **65.24 / 69.95 / 42.86**，白名单预算 7860/10412 行（75.49%，上限 80%）。
- `npm run test:e2e` → 9 passed；`npm run test:e2e:product-transfer` → 13 passed；`npm run build` → `index-B2IHxy-t.js` 715.80 kB / gzip 225.70 kB。
- 规模：`components/ScreenShare.tsx` 2823 行、`components/Receiver.tsx` 3367、`components/Sender.tsx` 1670、`src/worker.ts` 2471；`git ls-files services src` 生产文件 services 117 / services+src 118；生产 `as any` 16 处；`noUncheckedIndexedAccess` 200 错。

仍然存在的已知取舍（与 §8.12 相比仅数字更新，性质未变）：组件白名单仍占 75.49% 行数；冷却归零与采集释放只有 helper 契约测试；
CI 仍是信号不是闸门（Cloudflare Git 集成不读 GitHub 检查，除非分支保护设为必需）；千行组件与 AGENTS 的张力未解。

### 8.14 第十二轮复评后的收口（2026-11-14，复评基线 安全 93 / 产品 89 / 工程 92）

第十二轮三项只读复评（HEAD `924fc72`）共同的主题是「上一轮写的测试没钉住要钉的东西」。
三份 must-fix 的修法与验证如下。

| 缺口 | 修法 | 验证 |
| --- | --- | --- |
| 安全：每连接自铸的 `slotReleaseToken` 没有任何能变红的测试——把 `src/worker.ts` 的 `crypto.randomUUID()` 换成常量，174 条信令测试仍全绿 | `services/signaling/signalingHub.test.ts` 的「并发接管同一会话」用例收集每一次 `reserve` 的 `slotId` / `releaseToken`，断言三条连接（旧会话 + 两个接管方）的 token 与 slotId 两两不同，且接管方的 token 不等于被顶替会话 attachment 里的值 | 负对照：把 `slotReleaseToken` 换成常量 `'tok-constant'` ⇒ 该用例红；改回后 174 pass |
| 安全：`applySessionSlotReserve` 命中已存在 slotId 时无条件 `UPDATE ... SET client_key=?, release_token=?` 并 `return true`（跳过 COUNT），docblock 还写着「接管续期、直接改归属」——按注释重新引入复用就会再次打开「改写他人行归属 + 绕过上限」 | `services/signaling/sessionStore.ts` 先 `SELECT slot_id, release_token`，token 不符直接 `return false`，相同才 `UPDATE ... SET expires_at = ? WHERE slot_id = ? AND release_token = ?`（不再改 `client_key`）；docblock 改成「slotId 每条连接现铸，命中已存在只可能是同连接重试，token 不符一律拒绝，改写归属正是落败方删胜出方名额的成因」 | `sessionStore.test.ts` 拆成「同 token ⇒ 续期且不数名额」与「不同 token ⇒ false 且不发 UPDATE」；`sessionStore.sqlite.test.ts` 拆成「同 token 续期、归属不变」与「换 token 返回 false、行原样」；负对照：删掉 token 判定 ⇒ 3 红 |
| 产品：分享终态卡整体 `role="alert"`，倒计时与按钮都在它子树里 ⇒ 读屏每秒重播整卡；回归测试本身是假绿（`divDepthAt` 的 `from` 落在 alert 属性之后，且文件里 `\b` 被写成一个 0x08 退格字节，深度恒 0） | `components/screen-share/ScreenShareUI.tsx` 重构成「普通容器 + `role="alert"` 只包文字 + 控件行在外」，倒计时 `<span id="share-terminal-cooldown-hint">` 成为按钮的 `aria-describedby`；测试改用 `elementHtmlAt(markup, attrAt)` 按 `<div>` 标签配对切片断言子树内容 | 负对照：把倒计时塞回 alert 子树 ⇒ 1 红；去掉 sr-only 播报的 `role/aria-live` ⇒ 1 红 |
| 工程：CI 注释、覆盖率守卫理由、ROADMAP 与设计文档里的 screenshare 用例数写着 9 条，实际 10 条；`docs/design-scale-out.md:615` 声称「历史数字都标了快照」但只有一处标了 | `.github/workflows/ci.yml` 两处改 10 条并补充用例清单；`scripts/check-coverage-scope.mjs` 的白名单理由改 10 条；`docs/ROADMAP-next.md` 阶段 6 明标「当时结构」；`docs/design-scale-out.md` §8.7 加「数字说明」横幅，§8.7 / §8.12 的历史数字逐处标成当轮快照并指向 §8.14 | 数字逐条对照本轮实跑（见下）；`git grep` 复核「9 条」只剩历史叙述 |
| 工程（低）：第 7 观众满员用例在全量 product 套件里偶发「viewer video never produced frames」，单跑必过（同出口 offer 配额与代理网络抖动叠加） | `e2e/screenshare.spec.ts` 该用例 `test.setTimeout(480_000)`，`openViewerWithFrames` 允许最多 2 次重开（先 `context().close()` 再等 2s；命中「连接请求过多」立即抛出，因为那是限流而非抖动） | 全量 product 套件本轮 13 passed |

本轮实测（干净树，2026-11-14）：

- `npm run typecheck` → 0；`npm run test:all` → services **711** / components **46** / scripts **14** 全 pass。
- `node ./scripts/run-node-tests.mjs services/signaling` → **174 tests / 174 pass**。
- `--scope=services`：118 个生产源文件 / 报告 116 行 / 2 例外，scope 内 **91.27 / 83.83 / 84.69**，白名单预算 152/17371 行（0.88%，上限 5%）。
- `--scope=components`：13 文件 / 报告 10 行 / 3 例外，scope 内 **65.30 / 70.43 / 42.86**，白名单预算 7860/10419 行（75.44%，上限 80%）。
- `--self-test` → 19 个报告 fixture + 5 个预算 fixture + 3 个理由 fixture 全过。
- 仍然存在的已知取舍：与 §8.13 相同（组件白名单占约 3/4 行数、冷却归零与采集释放只有 helper 契约测试、CI 仍是信号不是闸门、千行组件与 AGENTS 的张力未解）。

