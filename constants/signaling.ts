// 信令与凭证的共享常量：这是唯一来源。
//
// 约束（AGENTS.md）：信令、连接策略、超时参数只在 services/ 与 constants/ 里定义。
// services/ 与 src/worker.ts 只允许引用这里的名字，不得再内联一份数字。
// 改这里的值等于改线上行为（会话锁定时长、枚举预算、TURN 凭证有效期），必须同步
// docs/design-scale-out.md 与相关测试。

/** 会话密钥摘要的字节数（SHA-256 之前）。 */
export const SESSION_SECRET_BYTES = 32;

/**
 * 轮换后的旧 proof 宽限期。
 *
 * `registered` 帧可能丢失（断线、4010/4029 截断），客户端只会拿着旧 proof 重连；
 * 宽限期必须覆盖「离线后重连」的预算，否则合法客户端会被自己拒成 4010 终态。
 * 语义不变：只认「当前 proof + 近 10 分钟内轮换掉的 proof」。
 */
export const SESSION_PROOF_GRACE_MS = 10 * 60 * 1000;

/**
 * 静态分享摘要的兜底窗口，只从首次绑定开始计。
 *
 * 首次 `registered` 帧可能丢了，客户端手里只有 `sessionSecretHash`；给一个短窗口
 * 让它还能注册一次。窗口从首次绑定开始，后续注册不续期，过期后把摘要置 NULL，
 * 之后只认 proof——否则等于把静态 bearer 永久保留。
 */
export const SESSION_SECRET_HASH_GRACE_MS = 10 * 60 * 1000;

/** 宽限期历史里最多保留几份旧 proof（正常重连只会用到最近一两份）。 */
export const SESSION_PROOF_HISTORY_LIMIT = 4;

/** 注销后保留 peerId 归属的时间窗：覆盖「同一个分享反复启停」。 */
export const SHARE_CODE_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

/** 会话绑定保留 24h：socket 断开后，同 peerId 的接管仍必须出示 proof。 */
export const SIGNALING_SESSION_BINDING_MS = 24 * 60 * 60 * 1000;

/**
 * 会话名额的兜底 TTL：正常路径由 socket 关闭时释放；进程被杀/DO 迁移可能漏掉释放，
 * 超过这个时间没有心跳的槽位在下次领取时被清掉，避免一次故障永久占满出口 IP 的名额。
 */
export const SIGNALING_SESSION_SLOT_TTL_MS = 6 * 60 * 60 * 1000;

/** 分片模式下名额续期间隔（随 ping 触发，节流）。 */
export const SIGNALING_SESSION_SLOT_REFRESH_MS = 30 * 60 * 1000;

/** 注销允许的最长宽限（客户端 pagehide 时用 sendBeacon 传 graceMs）。 */
export const SHARE_CODE_REVOKE_MAX_GRACE_MS = 120_000;

/**
 * 口令 GET 的「全局未知码」预算。
 *
 * 口令是 6 位数字，单 IP 预算（shareCodeRateLimitPolicy）挡不住分布式枚举；
 * 这里在 shard 0 的 DO 里加一个全局限额：只对「查不到的码」计数，正常查得到
 * 的注册不受影响，也不做逐码锁定（逐码锁定会被用来批量锁死别人的口令）。
 */
export const UNKNOWN_SHARE_CODE_BUDGET = {
  maxMisses: 200,
  windowMs: 10 * 1000,
} as const;

/** 未知码预算耗尽时返回的 Retry-After。 */
export const SHARE_CODE_UNKNOWN_LOOKUP_RETRY_AFTER_SECONDS = 5;

/** `/api/ice-config` 全局限流计数 RPC 的超时；宁可少计一次也不要拖垮 ICE 配置。 */
export const ICE_LIMIT_DO_TIMEOUT_MS = 800;

/** Cloudflare 短期 TURN 凭证的 TTL 与取值边界（秒）。 */
export const DEFAULT_CF_TURN_TTL_SECONDS = 3600;
export const MIN_CF_TURN_TTL_SECONDS = 60;
export const MAX_CF_TURN_TTL_SECONDS = 86_400;

/** 凭证缓存要提前多久失效，避免把即将过期的凭证发给客户端。 */
export const CF_TURN_CACHE_SAFETY_WINDOW_SECONDS = 60;
/**
 * 自建 TURN（`TURN_TTL_SECONDS`）与 Cloudflare 短期凭证用同一套边界：
 * 值只写一次，services/turnCredentials.ts 从这里导入。改这里等于同时改两条路径。
 */
export const DEFAULT_SELF_HOSTED_TURN_TTL_SECONDS = DEFAULT_CF_TURN_TTL_SECONDS;
export const MIN_SELF_HOSTED_TURN_TTL_SECONDS = MIN_CF_TURN_TTL_SECONDS;
export const MAX_SELF_HOSTED_TURN_TTL_SECONDS = MAX_CF_TURN_TTL_SECONDS;


/** 调用 Cloudflare TURN API 的超时。 */
export const CF_TURN_FETCH_TIMEOUT_MS = 4000;

/**
 * proof 轮换落库的重试次数（含首次）与退避基数。
 *
 * 落库是 shard 0 的一次写入；瞬时失败率虽低，但失败后的形态很坏：客户端拿着新
 * proof，服务端只有旧 proof，只能等 10 分钟宽限耗尽后把它拒成 4010。重试把这种
 * 错位压到「两次写入之间」，仍失败时由 appendPendingSessionProof 兜底。
 */
export const SESSION_COMMIT_ATTEMPTS = 3;

/** 第 n 次重试前等待 `SESSION_COMMIT_RETRY_DELAY_MS * n` 毫秒。 */
export const SESSION_COMMIT_RETRY_DELAY_MS = 50;

/** shard 0 绑定表不可达时，WS 升级返回 503 的 Retry-After（秒）。 */
export const SIGNALING_BINDING_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * shard 0 的全局会话名额表不可达时，WS 升级返回 503 的 Retry-After（秒）。
 *
 * 名额是防滥用而非身份校验，但 fail-open 会让整台出口 IP 在 shard 0 抖动期绕过全局上限，
 * 所以改成可重试的 503。5 秒与绑定不可达保持一致，客户端已有的退避逻辑直接复用。
 */
export const SIGNALING_QUOTA_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * 分片模式下按 peerId 回源查口令失败时，WS 升级返回 503 的 Retry-After（秒）。
 *
 * 这条查询回答的是「该 peerId 是否已被某份分享占用」。失败若按「没查到」放行，shard 0
 * 抖动期任何已绑定的 peerId 都会退回无凭证路径：攻击者不必知道口令，只要在抖动窗口
 * 反复重试就能以接收方身份抢占发送方的 peerId（rendezvous 之后接收方连上的是攻击者）。
 * 与绑定表、名额表两处不可达保持同一语义：宁可 503，也不在「不知道有没有主」时放行。
 */
export const SIGNALING_SHARE_CODE_LOOKUP_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * offer 的每出口配额与静默期。
 *
 * 一个观众要发两条 offer（数据通道 + 媒体），屏幕共享房号又最多 6 个观众，所以
 * 6 个观众 = 12 条 offer。旧值 10 条/分比容量本身更早生效：公司/校园这类共用出口
 * （CGNAT）打开第 6 个链接就被本地限流拒绝，还被误报成「人数已满」。
 *
 * 24 条/分 = 12 个观众首连，或 6 个观众各自再重连一次；静默期收到一个窗口，
 * 是因为 10 分钟封锁同样惩罚了被误触发的整出口（刷新页面也不会解除）。滥用成本
 * 仍由「每出口每分钟 24 条」+ 6 位口令 + 未知码预算约束，枚举不会因此变便宜。
 * 观众端点「重试连接」时用这里的 blockMs 做倒计时兜底。
 */
export const SIGNALING_OFFER_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxAttemptsPerClientWindow: 24,
  blockMs: 60 * 1000,
} as const;
