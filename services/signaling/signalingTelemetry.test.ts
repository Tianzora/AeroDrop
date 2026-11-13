import assert from 'node:assert/strict';
import test from 'node:test';

import { createSignalingTelemetry } from './signalingTelemetry.ts';

test('每条事件计数一次，并输出可解析的一行 JSON', () => {
  const lines: string[] = [];
  const telemetry = createSignalingTelemetry((line) => lines.push(line), () => 1_700_000_000_000);

  telemetry.record('signal_shard_selected', { shard: 2, shardCount: 3 });
  telemetry.record('signal_shard_selected', { shard: 0, shardCount: 3 });
  telemetry.record('signal_session_conflict');

  assert.equal(lines.length, 3);
  const [first] = lines;
  const parsed = JSON.parse(first) as Record<string, unknown>;
  assert.equal(parsed.type, 'signaling_metric');
  assert.equal(parsed.event, 'signal_shard_selected');
  assert.equal(parsed.at, 1_700_000_000_000);
  assert.equal(parsed.shard, 2);
  assert.equal(parsed.shardCount, 3);

  assert.deepEqual(telemetry.snapshot(), {
    signal_shard_selected: 2,
    signal_session_conflict: 1,
  });
});

test('undefined 字段不进入日志行，空事件也能输出', () => {
  const lines: string[] = [];
  const telemetry = createSignalingTelemetry((line) => lines.push(line), () => 1);
  telemetry.record('signal_cross_shard_failed', { targetShard: 1, reason: undefined });
  telemetry.record('signal_handshake_budget_exhausted');

  const failed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(failed.targetShard, 1);
  assert.equal('reason' in failed, false);
  assert.deepEqual(JSON.parse(lines[1]), {
    type: 'signaling_metric',
    event: 'signal_handshake_budget_exhausted',
    at: 1,
  });
});

test('sink 抛错不会打断信令流程，计数仍然有效', () => {
  const telemetry = createSignalingTelemetry(() => {
    throw new Error('log pipeline down');
  }, () => 1);
  assert.doesNotThrow(() => telemetry.record('signal_cross_shard_delivered', { targetShard: 1 }));
  assert.deepEqual(telemetry.snapshot(), { signal_cross_shard_delivered: 1 });
});

test('reset 清空计数，便于按测试隔离', () => {
  const telemetry = createSignalingTelemetry(() => {}, () => 1);
  telemetry.record('signal_session_slot_rejected');
  telemetry.reset();
  assert.deepEqual(telemetry.snapshot(), {});
});