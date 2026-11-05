// /api/share-code 端点的固定窗口限流：POST 与 GET 分开计数。
import {
  createFixedWindowRateLimiter,
  getRetryAfterSeconds,
  type FixedWindowRateLimiter,
  type FixedWindowRateLimitDecision,
} from './fixedWindowRateLimit.ts';

export const SHARE_CODE_POST_RATE_LIMIT = {
  maxAttempts: 10,
  windowMs: 10 * 1000,
  maxTrackedKeys: 4096,
};

export const SHARE_CODE_GET_RATE_LIMIT = {
  maxAttempts: 30,
  windowMs: 10 * 1000,
  maxTrackedKeys: 4096,
};

export type ShareCodeRateLimiters = {
  post: FixedWindowRateLimiter;
  get: FixedWindowRateLimiter;
};

export type ShareCodeRateLimitOverrides = {
  post?: Partial<typeof SHARE_CODE_POST_RATE_LIMIT>;
  get?: Partial<typeof SHARE_CODE_GET_RATE_LIMIT>;
};

export const createShareCodeRateLimiters = (
  overrides: ShareCodeRateLimitOverrides = {}
): ShareCodeRateLimiters => ({
  post: createFixedWindowRateLimiter({ ...SHARE_CODE_POST_RATE_LIMIT, ...overrides.post }),
  get: createFixedWindowRateLimiter({ ...SHARE_CODE_GET_RATE_LIMIT, ...overrides.get }),
});

export type ShareCodeRateLimitDecision = FixedWindowRateLimitDecision;

export const getShareCodeRetryAfterSeconds = getRetryAfterSeconds;
