import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createShareFullTelemetry,
  SHARE_FULL_TELEMETRY_PREFIX,
  type ShareFullDeliverySample,
} from './shareFullTelemetry.ts';

test('送达成功不计数、不回报', () => {
  const samples: ShareFullDeliverySample[] = [];
  const telemetry = createShareFullTelemetry((sample) => samples.push(sample));
  telemetry.record('open-connection', true);
  assert.deepEqual(samples, []);
  assert.equal(telemetry.failures(), 0);
});

test('送达失败要累加计数并带上投递方式', () => {
  // 反证点：组件侧把 deliverShareFull 的返回值丢掉（record 永不调用）时，
  // 观众被满员静默误导这件事在线上就是零可见度。
  const samples: ShareFullDeliverySample[] = [];
  const telemetry = createShareFullTelemetry((sample) => samples.push(sample));
  telemetry.record('new-connection', false);
  telemetry.record('pending-connection', false);
  assert.deepEqual(samples, [
    { delivery: 'new-connection', count: 1 },
    { delivery: 'pending-connection', count: 2 },
  ]);
  assert.equal(telemetry.failures(), 2);
});

test('遥测前缀是固定标量前缀，便于日志检索', () => {
  assert.equal(SHARE_FULL_TELEMETRY_PREFIX, 'screen_share_metric');
});
