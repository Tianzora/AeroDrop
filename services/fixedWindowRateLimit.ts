// 通用固定窗口限流器：ice-config 与 share-code 端点共用，避免两份相同实现漂移。

export type FixedWindowRateLimiterOptions = {
  maxAttempts: number;
  maxTrackedKeys: number;
  windowMs: number;
};

export type FixedWindowRateLimitDecision =
  | { allowed: true; retryAfterMs: 0 }
  | { allowed: false; retryAfterMs: number };

type RateWindow = {
  count: number;
  windowStartedAt: number;
};

export type FixedWindowRateLimiter = {
  consume(key: string, now: number): FixedWindowRateLimitDecision;
  /** 这个 key 当前是否已被跟踪（区分「配额用完」与「键表已满」两种拒绝）。 */
  hasTrackedKey(key: string): boolean;
  getTrackedKeyCount(): number;
};

export const createFixedWindowRateLimiter = (
  options: FixedWindowRateLimiterOptions
): FixedWindowRateLimiter => {
  const windows = new Map<string, RateWindow>();
  // 0 / 负数上限没有意义；当成「只跟踪一个 key」处理，避免下面的判定退化成恒拒绝。
  const maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys));

  const prune = (now: number): void => {
    // 到上限就开始找过期项：只在「地图已满」时多花这次扫描，平时 O(1) 返回。
    if (windows.size < maxTrackedKeys) return;

    for (const [key, window] of windows) {
      if (now - window.windowStartedAt >= options.windowMs) {
        windows.delete(key);
      }
    }
  };

  // 键被填满时的 fail-closed：淘汰「窗口最早」的 key 等于给新 key 发一张免费通行证，
  // 攻击者只要持续换 key 就能让被限流的键重新开始计数（旧实现正是如此）。
  // 所以满了就拒绝新 key，直到有窗口过期；连带说明：键是 CF 注入的真实出口 IP，
  // 调用方无法通过伪造请求头制造新 key，fail-closed 不会被用来锁死别人。
  const soonestExpiry = (now: number): number => {
    let retryAfterMs = options.windowMs;
    for (const window of windows.values()) {
      const remaining = window.windowStartedAt + options.windowMs - now;
      if (remaining < retryAfterMs) retryAfterMs = remaining;
    }
    return Math.max(1, retryAfterMs);
  };

  return {
    consume(key: string, now: number): FixedWindowRateLimitDecision {
      prune(now);
      if (windows.size >= maxTrackedKeys && !windows.has(key)) {
        return { allowed: false, retryAfterMs: soonestExpiry(now) };
      }

      const existing = windows.get(key);
      const window =
        existing && now - existing.windowStartedAt < options.windowMs
          ? existing
          : { count: 0, windowStartedAt: now };
      window.count += 1;
      windows.set(key, window);

      if (window.count <= options.maxAttempts) {
        return { allowed: true, retryAfterMs: 0 };
      }

      return {
        allowed: false,
        retryAfterMs: Math.max(1, window.windowStartedAt + options.windowMs - now),
      };
    },
    hasTrackedKey(key: string): boolean {
      return windows.has(key);
    },
    getTrackedKeyCount(): number {
      return windows.size;
    },
  };
};

export const getRetryAfterSeconds = (retryAfterMs: number): number =>
  Math.max(1, Math.ceil(retryAfterMs / 1000));
