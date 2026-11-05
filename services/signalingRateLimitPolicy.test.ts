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

test('prunes expired buckets once the tracked map grows past its cap', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 10,
    maxTrackedBuckets: 2,
    windowMs: 1_000,
  });

  limiter.recordOfferAttempt({ clientKey: 'ip:a', now: 0 });
  limiter.recordOfferAttempt({ clientKey: 'ip:b', now: 0 });
  limiter.recordOfferAttempt({ clientKey: 'ip:c', now: 0 });
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 3);

  // All previous windows are stale by now, so the next attempt collects them first.
  limiter.recordOfferAttempt({ clientKey: 'ip:d', now: 5_000 });
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 1);
});

test('keeps still-blocked buckets when pruning', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 60_000,
    maxAttemptsPerClientWindow: 1,
    maxTrackedBuckets: 1,
    windowMs: 1_000,
  });

  limiter.recordOfferAttempt({ clientKey: 'ip:blocked', now: 0 });
  assert.equal(limiter.recordOfferAttempt({ clientKey: 'ip:blocked', now: 10 }).allowed, false);

  limiter.recordOfferAttempt({ clientKey: 'ip:other', now: 20 });
  limiter.recordOfferAttempt({ clientKey: 'ip:third', now: 30 });
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 3);

  limiter.recordOfferAttempt({ clientKey: 'ip:fourth', now: 2_000 });
  assert.equal(limiter.getTrackedBucketCounts().clientBuckets, 2);
});
