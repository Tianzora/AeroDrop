import test from 'node:test';
import assert from 'node:assert/strict';

import { describeRetryCooldown } from './retryCooldown.ts';

test('没有冷却时返回 null 且允许重试', () => {
  const now = 1_000_000;
  assert.deepEqual(describeRetryCooldown(null, now), { secondsLeft: null, canRetry: true });
});

test('冷却中按整秒向上取整，避免显示「0 秒」却点不动', () => {
  const now = 1_000_000;
  assert.deepEqual(describeRetryCooldown(now + 1_500, now), {
    secondsLeft: 2,
    canRetry: false,
  });
});

test('冷却到点（剩余 0）立刻放行，不需要再等一拍', () => {
  const now = 1_000_000;
  assert.deepEqual(describeRetryCooldown(now, now), { secondsLeft: null, canRetry: true });
});

test('过去的截止时间视为已解除冷却', () => {
  const now = 1_000_000;
  assert.deepEqual(describeRetryCooldown(now - 30_000, now), {
    secondsLeft: null,
    canRetry: true,
  });
});

test('NaN 截止时间不允许把按钮永久禁用', () => {
  const now = 1_000_000;
  assert.deepEqual(describeRetryCooldown(Number.NaN, now), {
    secondsLeft: null,
    canRetry: true,
  });
});
