import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCREEN_SHARE_AGGREGATE_UPLINK_BPS,
  SCREEN_SHARE_RELAY_BITRATE_CAP,
  resolveBitrateCap,
  resolvePerViewerBitrateCap,
} from './bitratePolicy.ts';

test('客厅单人观看：per-PC 上限仍受聚合预算约束，不是无限上行', () => {
  // 1 人时预算全部给这一个连接。
  assert.equal(
    resolvePerViewerBitrateCap('high', false, 1),
    Math.min(resolveBitrateCap('high'), SCREEN_SHARE_AGGREGATE_UPLINK_BPS),
  );
  assert.equal(resolvePerViewerBitrateCap('high', false, 1), 16_000_000);
  // 中继仍然先受成本上限约束。
  assert.equal(
    resolvePerViewerBitrateCap('high', true, 1),
    Math.min(SCREEN_SHARE_RELAY_BITRATE_CAP, SCREEN_SHARE_AGGREGATE_UPLINK_BPS),
  );
});

test('观众变多时聚合预算被均分，任何人都不再拿到单连接满额', () => {
  assert.equal(resolvePerViewerBitrateCap('high', false, 2), 8_000_000);
  assert.equal(resolvePerViewerBitrateCap('high', false, 4), 4_000_000);
  // 6 人：16M / 6 = 2.66M，低于 high 档的 100M 但高于 low 档上限。
  assert.equal(resolvePerViewerBitrateCap('high', false, 6), 2_666_666);
  // 低画质档位本身低于预算份额时以档位上限为准。
  assert.equal(resolvePerViewerBitrateCap('low', false, 6), 2_500_000);
  assert.equal(
    resolvePerViewerBitrateCap('medium', false, 6),
    Math.min(8_000_000, Math.floor(SCREEN_SHARE_AGGREGATE_UPLINK_BPS / 6)),
  );
});

test('异常观众数按 1 人处理，不能除出 Infinity 或负数上限', () => {
  assert.equal(resolvePerViewerBitrateCap('high', false, Number.NaN), 16_000_000);
  assert.equal(resolvePerViewerBitrateCap('high', false, 0), 16_000_000);
  assert.equal(resolvePerViewerBitrateCap('high', false, -3), 16_000_000);
  assert.equal(resolvePerViewerBitrateCap('high', false, 2.7), 8_000_000);
});
