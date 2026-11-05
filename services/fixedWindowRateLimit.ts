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
  getTrackedKeyCount(): number;
};

export const createFixedWindowRateLimiter = (
  options: FixedWindowRateLimiterOptions
): FixedWindowRateLimiter => {
  const windows = new Map<string, RateWindow>();

  const prune = (now: number): void => {
    if (windows.size <= options.maxTrackedKeys) return;

    for (const [key, window] of windows) {
      if (now - window.windowStartedAt >= options.windowMs) {
        windows.delete(key);
      }
    }
  };

  return {
    consume(key: string, now: number): FixedWindowRateLimitDecision {
      prune(now);

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
    getTrackedKeyCount(): number {
      return windows.size;
    },
  };
};

export const getRetryAfterSeconds = (retryAfterMs: number): number =>
  Math.max(1, Math.ceil(retryAfterMs / 1000));
