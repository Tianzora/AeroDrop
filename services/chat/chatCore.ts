import { CHAT_CONFIG } from '../../constants/chat';

/**
 * 一条聊天消息的协议结构。
 *
 * id 用于接收端去重（同一帧重复投递只收一次）；ts 是发送端本地时间（毫秒）；
 * fromPeerId 是发送方 peerId，接收端据此做 per-peer 限流与展示。
 */
export interface ChatMessage {
  id: string;
  fromPeerId: string;
  ts: number;
  text: string;
}

export type ChatTranscriptFormatter = (ts: number) => string;

export type ChatSessionOptions = {
  /** 环形缓冲上限，默认 CHAT_CONFIG.RING_BUFFER_CAPACITY。 */
  capacity?: number;
  /** 单条消息 JSON UTF-8 字节上限，默认 CHAT_CONFIG.MAX_MESSAGE_BYTES。 */
  maxMessageBytes?: number;
  /** 单条文本字符上限，默认 CHAT_CONFIG.MAX_TEXT_LENGTH。 */
  maxTextLength?: number;
  /** 限流窗口与窗口内最大条数。 */
  rateLimitWindowMs?: number;
  rateLimitMaxMessages?: number;
  /** 本地 peerId：compose 生成的 fromPeerId。 */
  localPeerId?: string;
  /** 可注入的时钟与 id 生成器，便于测试。 */
  now?: () => number;
  createId?: () => string;
};

/** 用 UTF-8 字节数衡量一条消息序列化后的真实体积（不是字符数）。 */
export function measureChatMessageBytes(message: ChatMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/** 生成难以碰撞的消息 id；优先用 crypto.randomUUID，缺失时退化为时间戳+随机串。 */
export function createChatMessageId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把任意输入规整为 ChatMessage；结构不对就返回 null（调用方据此丢弃畸形消息）。
 * 只做结构与文本长度校验，字节上限由调用方另行判断，避免重复构造。
 */
export function normalizeChatMessage(
  value: unknown,
  maxTextLength: number = CHAT_CONFIG.MAX_TEXT_LENGTH,
): ChatMessage | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const { id, fromPeerId, ts, text } = candidate;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof fromPeerId !== 'string' || fromPeerId.length === 0) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (typeof text !== 'string') return null;
  if (text.length === 0 || text.length > maxTextLength) return null;
  return { id, fromPeerId, ts, text };
}

/**
 * per-peer 滑动窗口限流器。窗口内超过上限即拒绝，用于挡住刷屏/洪水。
 * 只保留窗口内的最近时间戳，过期条目在每次检查时惰性清理。
 */
export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly hits = new Map<string, number[]>();

  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  /** 记录一次到达并判断是否放行。 */
  allow(peerId: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(peerId);
    const recent = existing ? existing.filter((ts) => ts > cutoff) : [];
    if (recent.length >= this.maxMessages) {
      this.hits.set(peerId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(peerId, recent);
    return true;
  }

  /** 放弃记录（例如这条消息随后被判为重复/畸形，不该占用额度时使用）。 */
  forget(peerId: string, now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(peerId);
    if (!existing) return;
    const recent = existing.filter((ts) => ts > cutoff);
    if (recent.length <= 1) {
      this.hits.delete(peerId);
      return;
    }
    recent.pop();
    this.hits.set(peerId, recent);
  }

  reset(peerId?: string): void {
    if (peerId === undefined) this.hits.clear();
    else this.hits.delete(peerId);
  }
}

/**
 * 内存环形缓冲：上限 capacity，超出后丢最旧；按 id 去重（保留最近窗口内的 id）。
 * 不持久化——刷新页面即清空，这是产品要求（晚加入者无历史）。
 */
export class ChatHistory {
  private readonly capacity: number;
  private readonly messages: ChatMessage[] = [];
  private readonly seen = new Set<string>();

  constructor(capacity: number = CHAT_CONFIG.RING_BUFFER_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.messages.length;
  }

  /** 已经缓冲了同 id 的消息。 */
  has(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * 追加一条消息。重复 id 返回 false 且不改变顺序；超出容量时丢弃最旧。
   * 返回 true 表示确实入列。
   */
  add(message: ChatMessage): boolean {
    if (this.seen.has(message.id)) return false;
    this.messages.push(message);
    this.seen.add(message.id);
    while (this.messages.length > this.capacity) {
      const evicted = this.messages.shift();
      if (evicted) this.seen.delete(evicted.id);
    }
    return true;
  }

  /** 按时间正序（旧→新）返回副本，调用方改数组不影响内部。 */
  toArray(): ChatMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages.length = 0;
    this.seen.clear();
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 默认时间格式：本地时区 YYYY-MM-DD HH:mm:ss。 */
export function formatChatTimeLocal(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return String(ts);
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** 导出为纯文本：逐行「时间 发送者: 文本」，末尾带换行便于追加。 */
export function formatChatTranscript(
  messages: readonly ChatMessage[],
  formatter: ChatTranscriptFormatter = formatChatTimeLocal,
): string {
  if (messages.length === 0) return '';
  const lines = messages.map((message) => `${formatter(message.ts)} ${message.fromPeerId}: ${message.text}`);
  return `${lines.join('\n')}\n`;
}

/**
 * 聊天会话核心：环形缓冲 + 去重 + per-peer 限流 + 本地消息构造 + 导出。
 *
 * 与传输解耦——它不关心底层是 DataChannel 还是测试桩，只处理「收到的原始帧」和
 * 「要发出去的消息对象」。上层负责把 compose() 的结果通过 conn.send 发出去，并把
 * conn.on('data') 的原始帧交给 receive()。
 */
export class ChatSession {
  readonly history: ChatHistory;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly maxMessageBytes: number;
  private readonly maxTextLength: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly listeners = new Set<() => void>();
  private localPeerIdValue: string;

  constructor(options: ChatSessionOptions = {}) {
    this.history = new ChatHistory(options.capacity ?? CHAT_CONFIG.RING_BUFFER_CAPACITY);
    this.maxMessageBytes = options.maxMessageBytes ?? CHAT_CONFIG.MAX_MESSAGE_BYTES;
    this.maxTextLength = options.maxTextLength ?? CHAT_CONFIG.MAX_TEXT_LENGTH;
    this.limiter = new SlidingWindowRateLimiter(
      options.rateLimitMaxMessages ?? CHAT_CONFIG.RATE_LIMIT_MAX_MESSAGES,
      options.rateLimitWindowMs ?? CHAT_CONFIG.RATE_LIMIT_WINDOW_MS,
    );
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? createChatMessageId;
    this.localPeerIdValue = options.localPeerId ?? '';
  }

  setLocalPeerId(peerId: string): void {
    this.localPeerIdValue = peerId;
  }

  getLocalPeerId(): string {
    return this.localPeerIdValue;
  }

  /** 订阅会话变化（新消息/清理）。返回取消订阅函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // 监听器异常不应影响其它订阅者。
      }
    });
  }

  getMessages(): ChatMessage[] {
    return this.history.toArray();
  }

  /**
   * 由本地文本构造一条待发送消息并写入本地历史。空文本/超长/超字节返回 null。
   * 调用方拿到非 null 后自行通过 DataChannel 发送。
   */
  compose(text: string): ChatMessage | null {
    if (typeof text !== 'string') return null;
    if (text.trim().length === 0) return null;
    if (text.length > this.maxTextLength) return null;
    const message: ChatMessage = {
      id: this.createId(),
      fromPeerId: this.localPeerIdValue,
      ts: this.now(),
      text,
    };
    if (measureChatMessageBytes(message) > this.maxMessageBytes) return null;
    if (!this.history.add(message)) return null;
    this.notify();
    return message;
  }

  /**
   * 处理一条入站原始帧：字符串先 JSON.parse，然后结构校验、字节上限、per-peer 限流、
   * 按 id 去重。任何一步不通过都返回 null（静默丢弃，不抛错）。
   *
   * sourcePeerId 由传输层按真实 DataConnection.peer 盖章，绝不信任报文里的
   * fromPeerId——否则任何人都能冒名顶替或绕过 per-peer 配额。载荷里的 fromPeerId
   * 只做结构占位，进入历史与限流前会被可信来源覆盖。
   */
  receive(raw: unknown, sourcePeerId: string): ChatMessage | null {
    if (typeof sourcePeerId !== 'string' || sourcePeerId.trim().length === 0) return null;
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    const message = normalizeChatMessage(value, this.maxTextLength);
    if (!message) return null;
    message.fromPeerId = sourcePeerId;
    if (measureChatMessageBytes(message) > this.maxMessageBytes) return null;
    const now = this.now();
    if (!this.limiter.allow(sourcePeerId, now)) return null;
    if (!this.history.add(message)) {
      // 重复帧不应占用限流额度：撤销刚才那一次计数。
      this.limiter.forget(sourcePeerId, now);
      return null;
    }
    this.notify();
    return message;
  }

  exportTranscript(formatter?: ChatTranscriptFormatter): string {
    return formatChatTranscript(this.getMessages(), formatter);
  }

  clear(): void {
    this.history.clear();
    this.limiter.reset();
    this.notify();
  }
}