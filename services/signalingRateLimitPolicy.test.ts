import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSignalingRateLimiter,
  createSignalingSessionLimiter,
  isSignalingMessageTooLarge,
  MAX_SIGNALING_MESSAGE_LENGTH,
  recordSignalingMessage,
} from './signalingRateLimitPolicy.ts';

test('limits offer attempts per client across any target', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 2,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 1_000 }).allowed, true);
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 1_100 }).allowed, true);

  const blocked = limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 1_200 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed ? 0 : blocked.retryAfterMs, 10_000);

  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:b', now: 1_200 }).allowed, true);
});

test('block outlives the count window and then resets', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 5_000,
    maxAttemptsPerClientWindow: 1,
    windowMs: 1_000,
  });

  limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 0 });
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 10 }).allowed, false);
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 1_000 }).allowed, false);
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 5_010 }).allowed, true);
});

test('caps concurrent signaling sessions per client key', () => {
  const limiter = createSignalingSessionLimiter(2);

  assert.equal(limiter.tryAcquire('ip:203.0.113.10'), true);
  assert.equal(limiter.tryAcquire('ip:203.0.113.10'), true);
  assert.equal(limiter.tryAcquire('ip:203.0.113.10'), false);
  assert.equal(limiter.tryAcquire('ip:203.0.113.11'), true);
  assert.equal(limiter.getActiveSessionCount(), 3);

  limiter.release('ip:203.0.113.10');
  assert.equal(limiter.tryAcquire('ip:203.0.113.10'), true);

  limiter.release('ip:203.0.113.10');
  limiter.release('ip:203.0.113.10');
  limiter.release('ip:203.0.113.10');
  assert.equal(limiter.getActiveSessionCount(), 1);
});

test('allows a burst of signaling messages and resets after the window', () => {
  const options = { maxMessages: 2, windowMs: 10_000 };

  const first = recordSignalingMessage(undefined, 1_000, options);
  assert.equal(first.allowed, true);

  const second = recordSignalingMessage(first.state, 1_100, options);
  assert.equal(second.allowed, true);

  const blocked = recordSignalingMessage(second.state, 1_200, options);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 9_800);

  const nextWindow = recordSignalingMessage(blocked.state, 11_000, options);
  assert.equal(nextWindow.allowed, true);
  assert.equal(nextWindow.state.count, 1);
});

test('flags signaling frames larger than the byte budget', () => {
  assert.equal(isSignalingMessageTooLarge('x'.repeat(MAX_SIGNALING_MESSAGE_LENGTH)), false);
  assert.equal(isSignalingMessageTooLarge('x'.repeat(MAX_SIGNALING_MESSAGE_LENGTH + 1)), true);
  // 中文每字 3 字节：超过 1/3 预算UTF-8 体积就会越界。
  const cjk = '口'.repeat(Math.floor(MAX_SIGNALING_MESSAGE_LENGTH / 3) + 1);
  assert.equal(isSignalingMessageTooLarge(cjk), true);
});

test('fails closed instead of growing the tracked bucket map past its cap', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 10,
    maxTrackedBuckets: 2,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 0 }).allowed, true);
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:b', now: 0 }).allowed, true);

  // 键表已满：新 key 直接拒绝，而不是淘汰旧 key 放它进来。
  const rejected = limiter.recordOfferAttempt({ clientKey: 'ip:c', now: 0 });
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.allowed === false && rejected.retryAfterMs > 0);
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 2);

  // 已跟踪的 key 不受影响。
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 10 }).allowed, true);

  // 旧窗口过期后腾出位置，新 key 恢复。
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:d', now: 5_000 }).allowed, true);
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 1);
});

test('never evicts still-blocked buckets when the bucket table is full', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 60_000,
    maxAttemptsPerClientWindow: 1,
    maxTrackedBuckets: 1,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:blocked', now: 0 }).allowed, true);
  const blocked = limiter.recordOfferAttempt({ clientKey: 'ip:blocked', now: 10 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed === false && blocked.retryAfterMs, 60_000, 'quota abuse triggers the silence window');

  // 表满时新 key 只拿窗口剩余时间作退避，不会被记 10 分钟静默期。
  const other = limiter.recordOfferAttempt({ clientKey: 'ip:other', now: 20 });
  assert.equal(other.allowed, false);
  assert.ok(other.allowed === false && other.retryAfterMs < 60_000);
  limiter.recordOfferAttempt({ clientKey: 'ip:third', now: 30 });
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 1);

  // 静默期内的原 key 仍然被拒（没有因为表满被淘汰掉）。
  const stillBlocked = limiter.recordOfferAttempt({ clientKey: 'ip:blocked', now: 2_000 });
  assert.equal(stillBlocked.allowed, false);
});

test('restored sockets are counted even past the cap, so hibernation cannot widen the limit', () => {
  const limiter = createSignalingSessionLimiter(2);

  limiter.restore('ip:a');
  limiter.restore('ip:a');
  limiter.restore('ip:a');

  // 恢复的三条本来就活着，计数必须是 3；否则上限会被悄悄放宽成「3 + 2」。
  assert.equal(limiter.getActiveSessionCount(), 3);
  assert.equal(limiter.tryAcquire('ip:a'), false, '计数已超上限时新 socket 必须被拒');
  assert.equal(limiter.tryAcquire('ip:b'), true, '按 clientKey 分桶，别的出口不受影响');

  limiter.release('ip:a');
  assert.equal(limiter.getActiveSessionCount(), 3);
  assert.equal(limiter.tryAcquire('ip:a'), false);
  limiter.release('ip:a');
  assert.equal(limiter.tryAcquire('ip:a'), true, '降到上限以下后恢复准入');
});
