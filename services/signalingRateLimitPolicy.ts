import { createFixedWindowRateLimiter } from './fixedWindowRateLimit.ts';

export type SignalingRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

type SignalingRateLimiterOptions = {
  blockMs: number;
  maxAttemptsPerClientWindow: number;
  maxTrackedBuckets: number;
  windowMs: number;
};

type RecordOfferAttemptInput = {
  clientKey: string;
  now: number;
};

// 只保留 client 维度。6 位码改为服务端签发后，码空间 90 万，target 桶既挡不住枚举，
// 又会把同一出口（CGNAT/校园网）正常用户的重连归零；故删除 target 桶只留 client 上限。
const DEFAULT_OPTIONS: SignalingRateLimiterOptions = {
  blockMs: 10 * 60 * 1000,
  maxAttemptsPerClientWindow: 10,
  maxTrackedBuckets: 1024,
  windowMs: 60 * 1000,
};

/**
 * offer 的每客户端限流。
 *
 * 计数与「键表硬上限」都复用 services/fixedWindowRateLimit.ts：窗口内超过配额返回拒绝，
 * 键表填满时 fail-closed（拒绝新 key），不再淘汰最早窗口放行。超出配额后额外进入
 * blockMs 静默期——这是枚举/刷连接的成本，不是「等下个窗口再说」。
 */
export const createSignalingRateLimiter = (
  partialOptions: Partial<SignalingRateLimiterOptions> = {}
) => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...partialOptions,
  };
  const maxTrackedBuckets = Math.max(1, Math.floor(options.maxTrackedBuckets));
  const windows = createFixedWindowRateLimiter({
    maxAttempts: options.maxAttemptsPerClientWindow,
    maxTrackedKeys: maxTrackedBuckets,
    windowMs: options.windowMs,
  });
  // 静默期单独一张表（固定窗口表达不了「超过配额后锁 10 分钟」）。它同样有硬上限：
  // 满了只拒绝新 key，不淘汰已经在静默的 key（否则等于提前解除封锁）。
  const blockedUntil = new Map<string, number>();

  const pruneBlocks = (now: number): void => {
    if (blockedUntil.size < maxTrackedBuckets) return;
    for (const [key, until] of blockedUntil) {
      if (until <= now) blockedUntil.delete(key);
    }
  };

  return {
    recordOfferAttempt(input: RecordOfferAttemptInput): SignalingRateLimitDecision {
      pruneBlocks(input.now);

      const blocked = blockedUntil.get(input.clientKey);
      if (blocked !== undefined && blocked > input.now) {
        return { allowed: false, retryAfterMs: blocked - input.now };
      }

      const decision = windows.consume(input.clientKey, input.now);
      if (decision.allowed) {
        return { allowed: true };
      }

      // 只有「这个 key 自己把配额用完」才进静默期。键表满导致的新 key 拒绝不是滥用，
      // 记 10 分钟封锁会把无辜的新出口关在门外，且白占静默期表。
      const exhaustedQuota = windows.hasTrackedKey(input.clientKey);
      if (!exhaustedQuota) {
        return { allowed: false, retryAfterMs: decision.retryAfterMs };
      }
      if (blockedUntil.has(input.clientKey) || blockedUntil.size < maxTrackedBuckets) {
        blockedUntil.set(input.clientKey, input.now + options.blockMs);
      }
      return { allowed: false, retryAfterMs: options.blockMs };
    },
    getTrackedBucketCounts() {
      return { clientBuckets: windows.getTrackedKeyCount() };
    },
  };
};

// Every distinct client key may hold at most this many live signaling sockets.
export const MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT = 12;

export type SignalingSessionLimiter = {
  tryAcquire(clientKey: string): boolean;
  release(clientKey: string): void;
  getActiveSessionCount(): number;
};

export const createSignalingSessionLimiter = (
  maxSessionsPerClient: number = MAX_ACTIVE_SIGNALING_SESSIONS_PER_CLIENT
): SignalingSessionLimiter => {
  const activeSessions = new Map<string, number>();

  return {
    tryAcquire(clientKey: string): boolean {
      const active = activeSessions.get(clientKey) || 0;
      if (active >= maxSessionsPerClient) return false;

      activeSessions.set(clientKey, active + 1);
      return true;
    },
    release(clientKey: string): void {
      const active = activeSessions.get(clientKey) || 0;
      if (active <= 1) {
        activeSessions.delete(clientKey);
        return;
      }

      activeSessions.set(clientKey, active - 1);
    },
    getActiveSessionCount(): number {
      let total = 0;
      for (const active of activeSessions.values()) {
        total += active;
      }
      return total;
    },
  };
};

// Fixed-window budget for inbound frames on a single signaling socket.
export const SIGNALING_MESSAGE_WINDOW_MS = 10 * 1000;
export const MAX_SIGNALING_MESSAGES_PER_WINDOW = 240;
export const MAX_SIGNALING_MESSAGE_LENGTH = 64 * 1024;

export type SignalingMessageWindow = {
  count: number;
  windowStartedAt: number;
};

export type SignalingMessageWindowDecision = {
  allowed: boolean;
  retryAfterMs: number;
  state: SignalingMessageWindow;
};

export const recordSignalingMessage = (
  window: SignalingMessageWindow | undefined,
  now: number,
  options: { maxMessages: number; windowMs: number } = {
    maxMessages: MAX_SIGNALING_MESSAGES_PER_WINDOW,
    windowMs: SIGNALING_MESSAGE_WINDOW_MS,
  }
): SignalingMessageWindowDecision => {
  const base =
    window && now - window.windowStartedAt < options.windowMs
      ? window
      : { count: 0, windowStartedAt: now };
  const count = base.count + 1;

  return {
    allowed: count <= options.maxMessages,
    retryAfterMs: Math.max(0, base.windowStartedAt + options.windowMs - now),
    state: { count, windowStartedAt: base.windowStartedAt },
  };
};

// 限制按 UTF-8 字节计：按 UTF-16 code unit 计会让 3 字节字符放大到 ~3 倍体积。
export const isSignalingMessageTooLarge = (message: string): boolean => {
  if (message.length > MAX_SIGNALING_MESSAGE_LENGTH) {
    return true;
  }
  // 每个 code unit 至多编码成 3 个 UTF-8 字节；这个快速路径避免为小消息分配编码缓冲。
  if (message.length * 3 <= MAX_SIGNALING_MESSAGE_LENGTH) {
    return false;
  }
  return new TextEncoder().encode(message).length > MAX_SIGNALING_MESSAGE_LENGTH;
};
