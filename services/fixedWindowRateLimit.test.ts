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

test('fails closed for unseen keys once the tracked-key table is full', () => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: 2,
    maxTrackedKeys: 3,
    windowMs: 60_000,
  });

  limiter.consume('old', 1_000);
  limiter.consume('old', 1_000);
  assert.equal(limiter.consume('old', 1_000).allowed, false, 'old client is exhausted');

  assert.equal(limiter.consume('new-a', 2_000).allowed, true);
  assert.equal(limiter.consume('new-b', 3_000).allowed, true);

  // 键表满了：不再淘汰最旧 key 换新 key 放行，否则攻击者可以用无限多的源地址
  // 把每个真实客户端从表里挤出去，限流等于没有。新 key 一律拒绝。
  const denied = limiter.consume('new-c', 4_000);
  assert.equal(denied.allowed, false);
  assert.ok(
    denied.allowed === false && denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000,
    'rejection carries a retry hint bounded by the window',
  );
  assert.ok(limiter.getTrackedKeyCount() <= 3);

  // 已跟踪的 key 不受影响：fail-closed 只针对「表满时出现的新 key」。
  assert.equal(limiter.consume('new-a', 4_100).allowed, true);

  // 窗口滚过之后旧键被清理，新 key 自然恢复。
  assert.equal(limiter.consume('new-c', 65_000).allowed, true);
});

test('rejects new keys without evicting live windows when the table is full', () => {
  const limiter = createFixedWindowRateLimiter({
    maxAttempts: 5,
    maxTrackedKeys: 2,
    windowMs: 10_000,
  });

  assert.equal(limiter.consume('a', 0).allowed, true);
  assert.equal(limiter.consume('b', 0).allowed, true);
  assert.equal(limiter.consume('c', 0).allowed, false);
  // 'a' 的窗口仍在表里，不能被淘汰：它还有剩余预算。
  assert.equal(limiter.consume('a', 1).allowed, true);
  assert.equal(limiter.consume('a', 2).allowed, true);
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
