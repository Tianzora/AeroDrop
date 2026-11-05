import {
  createFixedWindowRateLimiter,
  getRetryAfterSeconds,
  type FixedWindowRateLimitDecision,
} from './fixedWindowRateLimit.ts';

export type IceConfigRateLimitOptions = {
  maxAttemptsPerWindow: number;
  maxTrackedClients: number;
  windowMs: number;
};

export type IceConfigRateLimitDecision = FixedWindowRateLimitDecision;

export const MAX_ICE_CONFIG_ATTEMPTS_PER_WINDOW = 30;
export const ICE_CONFIG_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const MAX_TRACKED_ICE_CONFIG_CLIENTS = 4096;

const DEFAULT_OPTIONS: IceConfigRateLimitOptions = {
  maxAttemptsPerWindow: MAX_ICE_CONFIG_ATTEMPTS_PER_WINDOW,
  maxTrackedClients: MAX_TRACKED_ICE_CONFIG_CLIENTS,
  windowMs: ICE_CONFIG_RATE_LIMIT_WINDOW_MS,
};

/**
 * Fixed-window limiter for /api/ice-config. State is per Worker isolate, so it
 * only blunts credential farming from one colo; it is not a hard quota.
 */
export const createIceConfigRateLimiter = (
  partialOptions: Partial<IceConfigRateLimitOptions> = {}
) => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...partialOptions,
  };
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: options.maxAttemptsPerWindow,
    maxTrackedKeys: options.maxTrackedClients,
    windowMs: options.windowMs,
  });

  return {
    consume: limiter.consume,
    getTrackedClientCount: limiter.getTrackedKeyCount,
  };
};

export const getIceConfigRetryAfterSeconds = getRetryAfterSeconds;
