// /api/ice-config 的全局限流计数（跑在单例 SignalingHub DO 里，跨 colo 共享）。
// 与 isolate 内的 iceConfigRateLimitPolicy 的区别：后者多实例各算一份（上限 ≈ 30 × N），
// 这里是全站真上限 30 次/60s；isolate 版本降级为「DO 不可用时的兵底」。
import {
  createFixedWindowRateLimiter,
  getRetryAfterSeconds,
  type FixedWindowRateLimiterOptions,
} from './fixedWindowRateLimit.ts';

export const ICE_CONFIG_GLOBAL_LIMIT: FixedWindowRateLimiterOptions = {
  maxAttempts: 30,
  maxTrackedKeys: 4096,
  windowMs: 60 * 1000,
};

export type IceConfigGlobalLimitDecision =
  | { allowed: true; retryAfterSeconds: 0 }
  | { allowed: false; retryAfterSeconds: number };

export type IceConfigGlobalLimiter = {
  check(clientKey: string, now: number): IceConfigGlobalLimitDecision;
  getTrackedClientCount(): number;
};

/**
 * 固定窗口 30 次/60s，以 clientKey（出口 IP）为键。内部 Map 由
 * createFixedWindowRateLimiter 在超过 maxTrackedKeys 时清理过期窗口。
 */
export const createIceConfigGlobalLimiter = (
  overrides: Partial<FixedWindowRateLimiterOptions> = {}
): IceConfigGlobalLimiter => {
  const limiter = createFixedWindowRateLimiter({ ...ICE_CONFIG_GLOBAL_LIMIT, ...overrides });

  return {
    check(clientKey: string, now: number): IceConfigGlobalLimitDecision {
      const decision = limiter.consume(clientKey, now);
      if (decision.allowed) return { allowed: true, retryAfterSeconds: 0 };

      return { allowed: false, retryAfterSeconds: getRetryAfterSeconds(decision.retryAfterMs) };
    },
    getTrackedClientCount: limiter.getTrackedKeyCount,
  };
};
