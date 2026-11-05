import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_CODE_GET_RATE_LIMIT,
  SHARE_CODE_POST_RATE_LIMIT,
  createShareCodeRateLimiters,
  getShareCodeRetryAfterSeconds,
} from './shareCodeRateLimitPolicy.ts';

test('allows 10 share-code creations per 10 second window', () => {
  const limiters = createShareCodeRateLimiters();

  for (let index = 0; index < SHARE_CODE_POST_RATE_LIMIT.maxAttempts; index += 1) {
    assert.equal(limiters.post.consume('ip:a', 1_000 + index).allowed, true);
  }

  const blocked = limiters.post.consume('ip:a', 1_500);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? 0 : blocked.retryAfterMs, 9_500);
  assert.equal(blocked.allowed ? 0 : getShareCodeRetryAfterSeconds(blocked.retryAfterMs), 10);

  assert.equal(limiters.post.consume('ip:b', 1_500).allowed, true);
});

test('allows 30 share-code lookups per 10 second window', () => {
  const limiters = createShareCodeRateLimiters();

  for (let index = 0; index < SHARE_CODE_GET_RATE_LIMIT.maxAttempts; index += 1) {
    assert.equal(limiters.get.consume('ip:a', 0).allowed, true);
  }

  assert.equal(limiters.get.consume('ip:a', 0).allowed, false);
});

test('keeps post and get budgets independent', () => {
  const limiters = createShareCodeRateLimiters();

  for (let index = 0; index < SHARE_CODE_POST_RATE_LIMIT.maxAttempts; index += 1) {
    limiters.post.consume('ip:a', 0);
  }

  assert.equal(limiters.post.consume('ip:a', 0).allowed, false);
  assert.equal(limiters.get.consume('ip:a', 0).allowed, true);
});

test('opens a fresh window after it expires', () => {
  const limiters = createShareCodeRateLimiters();

  for (let index = 0; index < SHARE_CODE_POST_RATE_LIMIT.maxAttempts; index += 1) {
    limiters.post.consume('ip:a', 0);
  }

  assert.equal(limiters.post.consume('ip:a', 5_000).allowed, false);
  assert.equal(limiters.post.consume('ip:a', 10_000).allowed, true);
});

test('prunes stale client keys once the tracked map is full', () => {
  const limiters = createShareCodeRateLimiters({ get: { maxTrackedKeys: 2 } });

  limiters.get.consume('ip:a', 0);
  limiters.get.consume('ip:b', 0);
  limiters.get.consume('ip:c', 0);
  // 硬上限：超出后淘汰最旧窗口，不再允许 map 无界增长。
  assert.ok(limiters.get.getTrackedKeyCount() <= 2);

  limiters.get.consume('ip:d', 60_000);
  assert.equal(limiters.get.getTrackedKeyCount(), 1);
});
