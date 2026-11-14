import test from 'node:test';
import assert from 'node:assert/strict';

import { describeShareRoomRetryCooldown } from './shareRoomRetryCooldown.ts';

const now = 1_700_000_000_000;

test('没有 Retry-After：不进入冷却，重试按钮可用', () => {
  assert.deepEqual(describeShareRoomRetryCooldown(null, now), { secondsLeft: null, canRetry: true });
});

test('冷却中：给出向上取整的剩余秒数并禁用重试', () => {
  // 反证点：把 ceil 改成 floor（或丢掉 canRetry=false），1.5s 会显示「1 秒」或按钮仍可点，
  // 用户点了还是立刻吃一次 429。
  assert.deepEqual(describeShareRoomRetryCooldown(now + 1_500, now), {
    secondsLeft: 2,
    canRetry: false,
  });
});

test('冷却刚好结束：解除禁用', () => {
  assert.deepEqual(describeShareRoomRetryCooldown(now, now), { secondsLeft: null, canRetry: true });
});

test('冷却时间已过（后台标签页节流）：不再拦重试', () => {
  assert.deepEqual(describeShareRoomRetryCooldown(now - 30_000, now), {
    secondsLeft: null,
    canRetry: true,
  });
});

test('retryAt 不是有限数：按无冷却处理，不显示 NaN 秒', () => {
  assert.deepEqual(describeShareRoomRetryCooldown(Number.NaN, now), {
    secondsLeft: null,
    canRetry: true,
  });
});
