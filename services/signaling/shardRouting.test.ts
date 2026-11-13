import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SIGNALING_SHARDS,
  SIGNALING_SHARD_ZERO_NAME,
  rendezvousShardIndex,
  resolveSignalingShardCount,
  signalingShardIndex,
  signalingShardName,
} from './shardRouting.ts';

const PEER_IDS = Array.from({ length: 400 }, (_, index) => `AERO-TEST${String(index).padStart(4, '0')}`);

test('分片名：shard 0 必须是现有单例名，其余按 signaling-shard-<i>', () => {
  assert.equal(signalingShardName(0), SIGNALING_SHARD_ZERO_NAME);
  assert.equal(signalingShardName(1), 'signaling-shard-1');
  assert.equal(signalingShardName(7), 'signaling-shard-7');
  // 小数/负数不应产生非法 DO 名，统一落回 shard 0。
  assert.equal(signalingShardName(-1), SIGNALING_SHARD_ZERO_NAME);
  assert.equal(signalingShardName(2.9), 'signaling-shard-2');
  assert.equal(signalingShardName(Number.NaN), SIGNALING_SHARD_ZERO_NAME);
});

test('分片下标可从 DO 名反解，未知名字返回 null', () => {
  assert.equal(signalingShardIndex(SIGNALING_SHARD_ZERO_NAME), 0);
  assert.equal(signalingShardIndex('signaling-shard-5'), 5);
  assert.equal(signalingShardIndex('signaling-shard-0'), null);
  assert.equal(signalingShardIndex('signaling-shard-x'), null);
  assert.equal(signalingShardIndex(''), null);
  assert.equal(signalingShardIndex(undefined), null);
  // 名字与下标必须能互相对上，否则转发会认错自己那片。
  for (const index of [0, 1, 2, 17, 63]) {
    assert.equal(signalingShardIndex(signalingShardName(index)), index);
  }
});

test('同一 peerId 与片数得到稳定结果，片数为 1 时恒为 shard 0', () => {
  for (const peerId of PEER_IDS.slice(0, 20)) {
    assert.equal(rendezvousShardIndex(peerId, 1), 0);
    assert.equal(rendezvousShardIndex(peerId, 0), 0);
    assert.equal(rendezvousShardIndex(peerId, 4), rendezvousShardIndex(peerId, 4));
    assert.ok(rendezvousShardIndex(peerId, 4) >= 0 && rendezvousShardIndex(peerId, 4) < 4);
  }
});

test('分片分布大致均匀（400 个 id 落到 4 片，每片不少于 15%）', () => {
  const counts = [0, 0, 0, 0];
  for (const peerId of PEER_IDS) {
    counts[rendezvousShardIndex(peerId, 4)]! += 1;
  }
  for (const count of counts) {
    assert.ok(count >= PEER_IDS.length * 0.15, `分片过少：${counts.join('/')}`);
  }
  assert.equal(counts.reduce((sum, count) => sum + count, 0), PEER_IDS.length);
});

test('扩容 4 → 5 只移动约 1/5 的键（rendezvous 的迁移上界）', () => {
  const moved = PEER_IDS.filter(
    (peerId) => rendezvousShardIndex(peerId, 4) !== rendezvousShardIndex(peerId, 5)
  ).length;
  const ratio = moved / PEER_IDS.length;
  // 理论上界是 1/5 = 0.2；取模路由会是 0.8，这条断言就是防止有人改成取模。
  assert.ok(ratio > 0.12 && ratio < 0.3, `迁移比例异常：${ratio}`);
});

test('片数解析：空值/非法值回落到 1，超范围 clamp 到 64', () => {
  assert.equal(resolveSignalingShardCount(undefined), 1);
  assert.equal(resolveSignalingShardCount(null), 1);
  assert.equal(resolveSignalingShardCount(''), 1);
  assert.equal(resolveSignalingShardCount('   '), 1);
  assert.equal(resolveSignalingShardCount('abc'), 1);
  assert.equal(resolveSignalingShardCount('0'), 1);
  assert.equal(resolveSignalingShardCount('-3'), 1);
  assert.equal(resolveSignalingShardCount('1'), 1);
  assert.equal(resolveSignalingShardCount('3'), 3);
  assert.equal(resolveSignalingShardCount(' 5 '), 5);
  assert.equal(resolveSignalingShardCount('9999'), MAX_SIGNALING_SHARDS);
  assert.equal(resolveSignalingShardCount(2.6), 2);
});

test('golden 值：固定 peerId 的分片下标不能被实现细节悄悄改掉', () => {
  // 这些值一旦变化，已部署环境里同一 peerId 会落到别的 DO，等于强制全体重连。
  const peerId = 'peer-11111111-1111-4111-8111-111111111111';
  assert.deepEqual(
    [2, 3, 4, 5, 8].map((count) => rendezvousShardIndex(peerId, count)),
    [1, 1, 3, 3, 3]
  );
  const legacyId = 'AERO-ABCDEF';
  assert.deepEqual(
    [2, 3, 4, 5, 8].map((count) => rendezvousShardIndex(legacyId, count)),
    [1, 1, 1, 1, 1]
  );
  // 默认单片时恒为 0，保证未配置分片的行为与单例完全一致。
  for (const id of [peerId, legacyId, 'x']) {
    assert.equal(rendezvousShardIndex(id, 1), 0);
  }
});
