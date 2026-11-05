import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIceConfigRateLimiter,
  getIceConfigRetryAfterSeconds,
  MAX_ICE_CONFIG_ATTEMPTS_PER_WINDOW,
} from './iceConfigRateLimitPolicy.ts';

test('allows a full 30 request window per client', () => {
  const limiter = createIceConfigRateLimiter();

  for (let index = 0; index < MAX_ICE_CONFIG_ATTEMPTS_PER_WINDOW; index += 1) {
    assert.equal(limiter.consume('ip:203.0.113.10', 1_000 + index).allowed, true);
  }

  assert.equal(limiter.consume('ip:203.0.113.10', 1_500).allowed, false);
  assert.equal(limiter.consume('ip:203.0.113.11', 1_500).allowed, true);
});

test('reports how long a blocked client must wait', () => {
  const limiter = createIceConfigRateLimiter({ maxAttemptsPerWindow: 1, windowMs: 60_000 });

  assert.equal(limiter.consume('ip:a', 1_000).allowed, true);

  const blocked = limiter.consume('ip:a', 2_000);
  assert.deepEqual(blocked, { allowed: false, retryAfterMs: 59_000 });
  assert.equal(getIceConfigRetryAfterSeconds(blocked.retryAfterMs), 59);
});

test('opens a fresh window once the previous one expires', () => {
  const limiter = createIceConfigRateLimiter({ maxAttemptsPerWindow: 1, windowMs: 1_000 });

  assert.equal(limiter.consume('ip:a', 0).allowed, true);
  assert.equal(limiter.consume('ip:a', 500).allowed, false);
  assert.equal(limiter.consume('ip:a', 1_000).allowed, true);
});

test('prunes stale clients once the tracked map grows past its cap', () => {
  const limiter = createIceConfigRateLimiter({
    maxAttemptsPerWindow: 1,
    maxTrackedClients: 2,
    windowMs: 1_000,
  });

  limiter.consume('ip:a', 0);
  limiter.consume('ip:b', 0);
  limiter.consume('ip:c', 0);
  // 硬上限：超出后淘汰最旧窗口。
  assert.ok(limiter.getTrackedClientCount() <= 2);

  limiter.consume('ip:d', 5_000);
  assert.equal(limiter.getTrackedClientCount(), 1);
});
