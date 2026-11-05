import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICE_CONFIG_GLOBAL_LIMIT,
  createIceConfigGlobalLimiter,
} from './iceConfigGlobalRateLimit.ts';

test('allows 30 requests per client window and blocks the 31st with a retry hint', () => {
  const limiter = createIceConfigGlobalLimiter();

  for (let index = 0; index < ICE_CONFIG_GLOBAL_LIMIT.maxAttempts; index += 1) {
    assert.deepEqual(limiter.check('ip:a', 1_000 + index), { allowed: true, retryAfterSeconds: 0 });
  }

  const blocked = limiter.check('ip:a', 5_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? 0 : blocked.retryAfterSeconds, 56);
});

test('keeps clients independent and reopens the window after 60s', () => {
  const limiter = createIceConfigGlobalLimiter();

  for (let index = 0; index < ICE_CONFIG_GLOBAL_LIMIT.maxAttempts; index += 1) {
    limiter.check('ip:a', 0);
  }
  assert.equal(limiter.check('ip:a', 0).allowed, false);
  assert.equal(limiter.check('ip:b', 0).allowed, true);

  assert.equal(limiter.check('ip:a', 60_000).allowed, true);
});

test('prunes stale client windows once the tracked map is full', () => {
  const limiter = createIceConfigGlobalLimiter({ maxAttempts: 1, maxTrackedKeys: 2, windowMs: 1_000 });

  limiter.check('ip:a', 0);
  limiter.check('ip:b', 0);
  limiter.check('ip:c', 0);
  assert.equal(limiter.getTrackedClientCount(), 3);

  limiter.check('ip:d', 60_000);
  assert.equal(limiter.getTrackedClientCount(), 1);
});

test('rounds the retry hint up to whole seconds', () => {
  const limiter = createIceConfigGlobalLimiter({ maxAttempts: 1, windowMs: 1_000 });

  limiter.check('ip:a', 0);
  const blocked = limiter.check('ip:a', 10);
  assert.equal(blocked.allowed ? 0 : blocked.retryAfterSeconds, 1);
});
