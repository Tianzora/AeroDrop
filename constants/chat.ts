// 屏幕共享房间聊天（M1：两人文本聊天）的共享常量。
//
// 约束（AGENTS.md）：信令/连接策略/超时只在 services/ 与 constants/ 改；消息大小上限
// 放 constants/。这里集中定义 aero-room DataChannel 的协议边界，services 与 components
// 只引用名字，不再各自内联数字。

export const CHAT_CONFIG = {
  /** 每条 room PC 上聊天专用的 DataChannel 标签；与分享控制用的 'data' 通道分离。 */
  CHANNEL_LABEL: 'aero-room',
  /**
   * 单条聊天消息（JSON 序列化后 UTF-8 字节数）上限。DataChannel 单消息硬上限约
   * 256 KiB，这里取 2 KiB：聊天是低带宽控制面，不需要大消息，也远低于 SCTP 上限。
   */
  MAX_MESSAGE_BYTES: 2 * 1024,
  /** 每端内存环形缓冲上限：超出后丢最旧；不持久化，刷新即清空。 */
  RING_BUFFER_CAPACITY: 1000,
  /** 单条文本字符数上限，与字节上限双保险，挡住超长输入。 */
  MAX_TEXT_LENGTH: 2000,
  /**
   * 接收端 per-peer 滑动窗口限流：窗口内最多 N 条。用于防刷，不惩罚正常聊天节奏
   * （10 秒 20 条远高于人手输入）。
   */
  RATE_LIMIT_WINDOW_MS: 10_000,
  RATE_LIMIT_MAX_MESSAGES: 20,
} as const;