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
    // 到上限就开始找过期项：只在「地图已满」时多花这次扫描，平时 O(1) 返回。
    if (windows.size < options.maxTrackedKeys) return;

    for (const [key, window] of windows) {
      if (now - window.windowStartedAt >= options.windowMs) {
        windows.delete(key);
      }
    }
  };

  // 分布式突发时所有条目都还没过期，光靠 prune 清不掉：这里给一个硬上限，
  // 超了就先淘汰窗口最早的那条，保证 map 永远不会无界增长。
  const enforceHardCap = (incomingKey: string): void => {
    while (windows.size >= options.maxTrackedKeys && !windows.has(incomingKey)) {
      let oldestKey: string | null = null;
      let oldestStart = Number.POSITIVE_INFINITY;
      for (const [key, window] of windows) {
        if (window.windowStartedAt < oldestStart) {
          oldestStart = window.windowStartedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      windows.delete(oldestKey);
    }
  };

  return {
    consume(key: string, now: number): FixedWindowRateLimitDecision {
      prune(now);
      enforceHardCap(key);

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
