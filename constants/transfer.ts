export const TRANSFER_CONFIG = {
  CHUNK_SIZE_LAN: 128 * 1024,
  CHUNK_SIZE_WAN: 64 * 1024,
  CHUNK_SIZE_RELAY: 64 * 1024,

  READ_BUFFER_SIZE: 32 * 1024 * 1024,
  // 协商上限异常偏小时逐次减半的兜底下限；继续减会让每片开销压过吞吐收益。
  MIN_CHUNK_SIZE: 16 * 1024,

  WRITE_BUFFER_FLUSH_THRESHOLD: 1 * 1024 * 1024,

  RECEIVE_WINDOW_BYTES: 2 * 1024 * 1024,
  WRITE_BATCH_BYTES: 1 * 1024 * 1024,
  MAX_PENDING_WRITE_BYTES: 4 * 1024 * 1024,
  PROGRESS_STALL_TIMEOUT_MS: 12_000,
  PROGRESS_STALL_CHECK_INTERVAL_MS: 1_000,
  MAX_STALL_RECONNECTS: 3,
} as const;

export const FLOW_CONTROL = {
  HIGH_WATER_MARK_LAN: 2 * 1024 * 1024,
  LOW_WATER_MARK_LAN: 512 * 1024,
  HIGH_WATER_MARK_WAN: 1 * 1024 * 1024,
  LOW_WATER_MARK_WAN: 256 * 1024,
  HIGH_WATER_MARK_RELAY: 1 * 1024 * 1024,
  LOW_WATER_MARK_RELAY: 256 * 1024,
  // 多个接收端同时拉取时，各连接独立排队会让总在途数据随人数线性增长。
  // 这里给发送端一个共享在途预算，按活跃连接数均分。
  TOTAL_UPLINK_BUFFER_BYTES: 4 * 1024 * 1024,
} as const;

// 连接、重试、心跳与屏幕共享时序。组件只允许引用这里，不要在组件体内再写字面量。
export const CONNECTION_TIMINGS = {
  /** 「永久」分享的口令续期间隔（服务端 TTL 上限 24h）。 */
  SHARE_CODE_RENEWAL_INTERVAL_MS: 30 * 60 * 1000,
  /** 接收端兑换口令的超时：断网/Worker 卡住时不能无限停在等待页。 */
  SHARE_CODE_LOOKUP_TIMEOUT_MS: 4_000,
  /** pagehide 时延后注销口令的窗口：期间原凭证可 resume，避免切后台被误杀。 */
  SHARE_CODE_REVOKE_GRACE_MS: 60_000,
  /** 续传检查点的最小写入间隔/增量，避免每收到一块就写 localStorage。 */
  RESUME_CHECKPOINT_MIN_INTERVAL_MS: 2_000,
  RESUME_CHECKPOINT_MIN_BYTES: 1024 * 1024,
  RECEIVER_INITIAL_CONNECT_MS: 15_000,
  RECEIVER_RELAY_CONNECT_MS: 25_000,
  RECEIVER_FAST_RETRY_BASE_MS: 700,
  RECEIVER_FAST_RETRY_MAX_MS: 5_000,
  RECEIVER_MAX_CONNECT_RETRY: 6,
  RECEIVER_MAX_COMMITTED_RECONNECT_RETRY: 3,
  /** 连接只有稳定存活这么久，才把重连预算（快速重试 + committed 重连）清零。 */
  RECEIVER_RECONNECT_BUDGET_STABLE_MS: 15_000,
  RECEIVER_MAX_AUTO_REPAIR_RETRIES_PER_FILE: 2,
  /** 传输层 'disconnected' 的宽限期：期间 ICE 有机会自行恢复，超时才按断链处理。 */
  TRANSPORT_DISCONNECTED_GRACE_MS: 12_000,
  /** initiator 在宽限期内发起 ICE restart 的延迟：先给 ICE 自愈的时间，再主动换候选。 */
  TRANSPORT_ICE_RESTART_DELAY_MS: 6_000,
  /** ICE restart 发出后等待新路径连通的额外时间。 */
  TRANSPORT_ICE_RESTART_GRACE_MS: 10_000,
  SENDER_SIGNALING_OPEN_TIMEOUT_MS: 10_000,
  SENDER_MAX_SIGNALING_OPEN_RETRY: 1,
  /** 信令连接稳定存活这么久才清零重连退避计数，否则「握手成功即被关」会让退避永远从 1s 起。 */
  SIGNALING_RECONNECT_STABLE_MS: 15_000,
  /**
   * 信令退避重连的次数上限。退避封顶 10s 后仍打不开（断网、被墙、Worker 不可达）时，
   * 再重连也只是让用户对着「正在连接」无限等待，不如停下来给一条可操作的错误。
   */
  MAX_SIGNALING_RECONNECT_ATTEMPTS: 8, // 退避基数/上限（1s、10s）在 services/peerRuntime.ts，调参时两处一起看
  SENDER_GHOST_SWEEP_INTERVAL_MS: 4_000,
  SENDER_GHOST_GRACE_MS: 10_000,
  SENDER_HEARTBEAT_TIMEOUT_MS: 30_000,
  SENDER_HARD_HEARTBEAT_TIMEOUT_MS: 5 * 60 * 1000,
  SCREEN_SHARE_CONNECT_TIMEOUT_MS: 20_000,
  SCREEN_SHARE_MAX_RECONNECT_ATTEMPTS: 5,
  // 信令预算耗尽后重建 PeerRuntime 的次数上限：每次重建都会拿到新的信令预算，不限次
  // 就会变成「重建-耗尽-重建」的慢循环。
  SCREEN_SHARE_MAX_PEER_REBUILDS: 2,
  SCREEN_SHARE_RECONNECT_BASE_DELAY_MS: 2_000,
  SCREEN_SHARE_RECONNECT_MAX_DELAY_MS: 10_000,
  SCREEN_SHARE_HEARTBEAT_INTERVAL_MS: 3_000,
  SCREEN_SHARE_BANDWIDTH_MONITOR_INTERVAL_MS: 2_000,
  SCREEN_SHARE_BANDWARMUP_MS: 8_000,
  // 观看端冻帧检测的采样间隔：5 秒内累计 2 次以上冻帧就认为画面已经卡死。
  SCREEN_SHARE_VIEWER_STATS_INTERVAL_MS: 5_000,
} as const;

// 屏幕共享走 P2P mesh：每个 viewer 一条独立 PC 和独立编码，发送端上行是 N 份。
// 这里不引入 SFU，只做纯客户端的上行预算与人数上限，避免住宅/移动网络被瞬间打满。
export const SCREEN_SHARE_LIMITS = {
  // 同时观看人数上限。超过后由分享端直接关闭新 call，而不是让信令 12 会话/IP 的隐式上限兜底。
  MAX_VIEWERS: 6,
} as const;

// 观众 call 已 answer、但 ICE 迟迟连不上时的回收时间。没有这道闸门，一条永远停在
// connecting 的 call 会一直占着 MAX_VIEWERS 名额，直到分享结束（观众自己断开不一定
// 会触发 close）。
export const SCREEN_SHARE_VIEWER_CONNECT_TIMEOUT_MS = 20_000;

// 接收端存储阈值与归档内存上限。
export const RECEIVE_STORAGE = {
  IOS_MEMORY_WARN_BYTES: 500 * 1024 * 1024,
  IOS_IDB_BUFFER_THRESHOLD_BYTES: 500 * 1024 * 1024,
  IOS_IDB_STALE_SESSION_TTL_MS: 24 * 60 * 60 * 1000,
  IOS_IDB_PRUNE_LOCK_TTL_MS: 45 * 1000,
  // 暂存总量超过该值时不再拼内存 zip，降级为逐个保存，避免收完之后 OOM。
  ARCHIVE_MAX_IN_MEMORY_BYTES: 1024 * 1024 * 1024,
  // 单文件自动直下（不弹保存框）的上限：直下要先在内存/IDB 里缓冲完整文件，
  // 超过该上限就回退成选择保存位置 + 零内存流式写入，避免大文件撑爆内存。
  DIRECT_DOWNLOAD_MAX_BYTES: 512 * 1024 * 1024,
} as const;

// 控制面消息上限：JSON 字符串再序列化时引号会转义，最坏情况体积翻倍，
// 所以原始分片取 96 KiB，保证单条消息远低于 256 KiB 的 SCTP 上限。
export const METADATA_CHUNKING = {
  MAX_MESSAGE_BYTES: 96 * 1024,
} as const;

export const EXPIRY_DURATIONS = {
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  never: undefined,
} as const;

export type ExpiryOption = keyof typeof EXPIRY_DURATIONS;
