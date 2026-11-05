import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixedWindowRateLimiter } from './fixedWindowRateLimit.ts';

test('caps the number of tracked keys during a burst of fresh clients', () => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: 10,
    maxTrackedKeys: 3,
    windowMs: 60_000,
  });

  for (let index = 0; index < 50; index += 1) {
    limiter.consume(`ip-${index}`, 1_000 + index);
    assert.ok(
      limiter.getTrackedKeyCount() <= 3,
      `tracked ${limiter.getTrackedKeyCount()} keys after ${index + 1} clients`,
    );
  }
});

test('evicts the oldest window first so recent clients keep their budget', () => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: 2,
    maxTrackedKeys: 2,
    windowMs: 60_000,
  });

  limiter.consume('old', 1_000);
  limiter.consume('old', 1_000);
  assert.equal(limiter.consume('old', 1_000).allowed, false, 'old client is exhausted');

  limiter.consume('new-a', 2_000);
  limiter.consume('new-b', 3_000);

  // 'old' 已被淘汰：重新出现时按新窗口计数。
  assert.equal(limiter.consume('old', 4_000).allowed, true);
  assert.ok(limiter.getTrackedKeyCount() <= 2);
});

test('still enforces the per-key attempt budget and retry delay', () => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: 2,
    maxTrackedKeys: 10,
    windowMs: 1_000,
  });

  assert.equal(limiter.consume('ip', 0).allowed, true);
  assert.equal(limiter.consume('ip', 100).allowed, true);
  const denied = limiter.consume('ip', 400);
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.retryAfterMs, 600);

  assert.equal(limiter.consume('ip', 1_100).allowed, true);
});
