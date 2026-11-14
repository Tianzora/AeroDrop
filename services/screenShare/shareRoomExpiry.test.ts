import test from 'node:test';
import assert from 'node:assert/strict';

import { planShareRoomExpiryCheck } from './shareRoomExpiry.ts';

test('未过期：一次性定时器直接对齐到 expiresAt', () => {
  const now = 1_700_000_000_000;
  const room = { expiresAt: now + 90_000 };
  assert.deepEqual(planShareRoomExpiryCheck(room, now), {
    delayMs: 90_000,
    expiresAt: now + 90_000,
  });
});

test('剩余时间不是整分也按剩余时间排期，不等下一个轮询边界', () => {
  // 反证点：改回固定 60s 轮询时，这里的 delayMs 不可能等于 7_000，
  // 「过期后最多 59s 还挂着绿色正在共享」的窗口就会回来。
  const now = 1_700_000_000_000;
  assert.equal(planShareRoomExpiryCheck({ expiresAt: now + 7_000 }, now)?.delayMs, 7_000);
});

test('已经过期：delayMs 归零，调用方立刻翻转，不再等一个周期', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(planShareRoomExpiryCheck({ expiresAt: now - 1 }, now), {
    delayMs: 0,
    expiresAt: now - 1,
  });
});

test('expiresAt 不是有限数：不排期，避免 NaN 定时器', () => {
  assert.equal(planShareRoomExpiryCheck({ expiresAt: Number.NaN }, 1_700_000_000_000), null);
});
