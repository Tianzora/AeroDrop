import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCREEN_SHARE_BITRATE_LIMITS,
  SCREEN_SHARE_RELAY_BITRATE_CAP,
  resolveAggregateQuality,
  resolveBitrateCap,
  shouldDowngradeQuality,
  shouldUpgradeQuality,
} from './bitratePolicy.ts';

test('leaves LAN and P2P uncapped, but keeps the relay cost ceiling', () => {
  assert.equal(resolveBitrateCap('high'), 100_000_000);
  assert.equal(resolveBitrateCap('high', false), SCREEN_SHARE_BITRATE_LIMITS.high.max);
  assert.equal(resolveBitrateCap('high', true), SCREEN_SHARE_RELAY_BITRATE_CAP);
  assert.equal(resolveBitrateCap('medium', true), SCREEN_SHARE_RELAY_BITRATE_CAP);
  assert.equal(resolveBitrateCap('low', true), SCREEN_SHARE_BITRATE_LIMITS.low.max);
  assert.equal(resolveBitrateCap('medium', false), 8_000_000);
  assert.equal(resolveBitrateCap('low', false), 2_500_000);
});

test('aggregate quality follows the higher median viewer, not the worst one', () => {
  assert.equal(resolveAggregateQuality([]), 'high');
  assert.equal(resolveAggregateQuality(['high', 'low']), 'high');
  assert.equal(resolveAggregateQuality(['high', 'low', 'high']), 'high');
  assert.equal(resolveAggregateQuality(['low', 'low', 'medium']), 'low');
  assert.equal(resolveAggregateQuality(['medium', 'high', 'high']), 'high');
});

test('only downgrades on sustained severe congestion', () => {
  assert.equal(shouldDowngradeQuality('high', 0.01, 10_000_000), false);
  assert.equal(shouldDowngradeQuality('high', 0.13, 10_000_000), true);
  assert.equal(shouldDowngradeQuality('high', 0.04, 500_000), true);
  assert.equal(shouldDowngradeQuality('medium', 0.06, 100_000), true);
  assert.equal(shouldDowngradeQuality('low', 0.5, 1), false);
  assert.equal(shouldUpgradeQuality(0.004), true);
  assert.equal(shouldUpgradeQuality(0.05), false);
});
