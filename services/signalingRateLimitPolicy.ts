export type SignalingRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

type RateBucket = {
  blockedUntil: number;
  count: number;
  windowStartedAt: number;
};

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

const getBucket = (
  buckets: Map<string, RateBucket>,
  key: string,
  now: number,
  windowMs: number
): RateBucket => {
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartedAt >= windowMs) {
    const next = {
      blockedUntil: existing?.blockedUntil && existing.blockedUntil > now ? existing.blockedUntil : 0,
      count: 0,
      windowStartedAt: now,
    };
    buckets.set(key, next);
    return next;
  }

  return existing;
};

const recordBucket = (
  bucket: RateBucket,
  now: number,
  maxAttempts: number,
  blockMs: number
): { allowed: true } | { allowed: false; retryAfterMs: number } => {
  if (bucket.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterMs: bucket.blockedUntil - now,
    };
  }

  bucket.count += 1;
  if (bucket.count <= maxAttempts) {
    return { allowed: true };
  }

  bucket.blockedUntil = now + blockMs;
  return {
    allowed: false,
    retryAfterMs: blockMs,
  };
};

const pruneBuckets = (
  buckets: Map<string, RateBucket>,
  now: number,
  windowMs: number,
  maxTrackedBuckets: number
): void => {
  if (buckets.size <= maxTrackedBuckets) return;

  for (const [key, bucket] of buckets) {
    if (bucket.blockedUntil <= now && now - bucket.windowStartedAt >= windowMs) {
      buckets.delete(key);
    }
  }
};

export const createSignalingRateLimiter = (
  partialOptions: Partial<SignalingRateLimiterOptions> = {}
) => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...partialOptions,
  };
  const clientBuckets = new Map<string, RateBucket>();

  return {
    recordOfferAttempt(input: RecordOfferAttemptInput): SignalingRateLimitDecision {
      pruneBuckets(clientBuckets, input.now, options.windowMs, options.maxTrackedBuckets);

      const clientBucket = getBucket(clientBuckets, input.clientKey, input.now, options.windowMs);
      const clientDecision = recordBucket(
        clientBucket,
        input.now,
        options.maxAttemptsPerClientWindow,
        options.blockMs
      );
      if (!clientDecision.allowed) {
        return { allowed: false, retryAfterMs: clientDecision.retryAfterMs };
      }

      return { allowed: true };
    },
    getTrackedBucketCounts() {
      return { clientBuckets: clientBuckets.size };
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
