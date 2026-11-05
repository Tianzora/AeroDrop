import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SIGNALING_MESSAGE_LENGTH,
  isSignalingMessageTooLarge,
} from './signalingRateLimitPolicy.ts';

test('accepts frames at the UTF-8 byte limit and rejects the next byte', () => {
  assert.equal(isSignalingMessageTooLarge('a'.repeat(MAX_SIGNALING_MESSAGE_LENGTH)), false);
  assert.equal(isSignalingMessageTooLarge('a'.repeat(MAX_SIGNALING_MESSAGE_LENGTH + 1)), true);
});

test('counts multi-byte characters by encoded size instead of code units', () => {
  // 每个汉字 3 字节：2 万汉字 = 60 000 字节（仍在限制内），4 万汉字 = 120 000 字节（超限）。
  const withinLimit = '汉'.repeat(20_000);
  const overLimit = '汉'.repeat(40_000);

  assert.equal(withinLimit.length, 20_000);
  assert.equal(isSignalingMessageTooLarge(withinLimit), false);
  assert.equal(isSignalingMessageTooLarge(overLimit), true);
});

test('keeps the fast path consistent for surrogate pairs', () => {
  // emoji 是 2 个 code unit / 4 个 UTF-8 字节：3 万个 = 120 000 字节，超限。
  assert.equal(isSignalingMessageTooLarge('😀'.repeat(30_000)), true);
  assert.equal(isSignalingMessageTooLarge('😀'.repeat(10_000)), false);
});
