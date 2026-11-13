import {
  createFixedWindowRateLimiter,
  getRetryAfterSeconds,
  type FixedWindowRateLimitDecision,
} from '../fixedWindowRateLimit.ts';

/**
 * 分片模式下的 WS 握手预算。
 *
 * 注册要读口令表，而口令表只在 shard 0：落在其它片上的注册每次都要一次跨 DO RPC，
 * 且发生在会话名额与消息节流之前——不加预算的话，未认证的连接就能用握手放大成
 * 「每个请求一次 DO 调用」。单例模式（默认）不需要这次 RPC，因此也不会消耗预算。
 *
 * 状态按 isolate 计，只负责削弱放大，不是硬配额。
 */

export const MAX_SIGNALING_HANDSHAKE_LOOKUPS_PER_WINDOW = 20;
export const SIGNALING_HANDSHAKE_WINDOW_MS = 10 * 1000;
export const MAX_TRACKED_SIGNALING_HANDSHAKE_CLIENTS = 8192;

export type SignalingHandshakeBudgetOptions = {
  maxLookupsPerWindow?: number;
  windowMs?: number;
  maxTrackedClients?: number;
};

export type SignalingHandshakeBudget = {
  consume(clientKey: string, now: number): FixedWindowRateLimitDecision;
  getTrackedClientCount(): number;
};

export const createSignalingHandshakeBudget = (
  options: SignalingHandshakeBudgetOptions = {}
): SignalingHandshakeBudget => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: options.maxLookupsPerWindow ?? MAX_SIGNALING_HANDSHAKE_LOOKUPS_PER_WINDOW,
    maxTrackedKeys: options.maxTrackedClients ?? MAX_TRACKED_SIGNALING_HANDSHAKE_CLIENTS,
    windowMs: options.windowMs ?? SIGNALING_HANDSHAKE_WINDOW_MS,
  });

  return {
    consume: limiter.consume,
    getTrackedClientCount: limiter.getTrackedKeyCount,
  };
};

export const getSignalingHandshakeRetryAfterSeconds = getRetryAfterSeconds;
