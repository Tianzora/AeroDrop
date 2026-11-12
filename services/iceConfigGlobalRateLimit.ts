// /api/ice-config 的全局限流计数（跑在单例 SignalingHub DO 里，跨 colo 共享）。
// 与 isolate 内的 iceConfigRateLimitPolicy 的区别：后者多实例各算一份（上限 ≈ 30 × N），
// 这里是全站真上限。一个办公室/NAT 后面同时有 30+ 观看端时，30 次/60s 会让后来者
// 静默退化成 STUN-only，因此按「每人一次 + 30 分钟内刷新」留出更宽的突发额度。
import {
  createFixedWindowRateLimiter,
  getRetryAfterSeconds,
  type FixedWindowRateLimiterOptions,
} from './fixedWindowRateLimit.ts';

export const ICE_CONFIG_GLOBAL_LIMIT: FixedWindowRateLimiterOptions = {
  maxAttempts: 120,
  maxTrackedKeys: 8192,
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
