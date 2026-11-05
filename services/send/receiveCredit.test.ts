import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSendSequenceCurrent,
  ReceiveCreditGate,
  shouldReleasePeerState,
} from './receiveCredit.ts';

test('credit gate bounds sent bytes by durable progress', async () => {
  const gate = new ReceiveCreditGate(8 * 1024, 0, 1024);

  assert.equal(await gate.waitForAvailable(2048), 1024);
  gate.recordSent(1024);

  let released = false;
  const waiting = gate.waitForAvailable(2048).then((bytes) => {
    released = true;
    return bytes;
  });
  await Promise.resolve();
  assert.equal(released, false);

  gate.update(512, 1024, 8 * 1024);
  assert.equal(await waiting, 512);
});

test('credit gate clamps regressed durable offsets and rejects impossible or mismatched ones', () => {
  const gate = new ReceiveCreditGate(4096, 1024, 1024);
  gate.recordSent(512);
  gate.update(1280, 1024, 4096);

  // 回退＝接收端统计口径从 committedBytes 切到 receivedSize，clamp 后继续，不再抛错断连。
  gate.update(1279, 1024, 4096);
  assert.equal(gate.snapshot().persistedOverallBytes, 1280);
  assert.throws(() => gate.update(1537, 1024, 4096), /between 0 and 1536/);
  assert.throws(() => gate.update(1280, 1024, 4095), /overallTotalBytes changed/);
});

test('credit gate rejects pending wait when connection closes', async () => {
  const gate = new ReceiveCreditGate(4096, 0, 1024);
  gate.recordSent(1024);
  const waiting = gate.waitForAvailable(1024);

  gate.cancel('connection closed');

  await assert.rejects(waiting, /connection closed/);
  await assert.rejects(gate.waitForAvailable(1024), /connection closed/);
});

test('late close from an old connection cannot release replacement peer state', () => {
  assert.equal(shouldReleasePeerState('conn-old', 'conn-new', true), false);
  assert.equal(shouldReleasePeerState('conn-old', 'conn-old', true), false);
  assert.equal(shouldReleasePeerState('conn-current', 'conn-current', false), true);
});

test('an epoch change invalidates a sequence after an async wait', () => {
  assert.equal(isSendSequenceCurrent(1, 1, 3, 3, true), true);
  assert.equal(isSendSequenceCurrent(1, 1, 4, 3, true), false);
  assert.equal(isSendSequenceCurrent(1, 1, 3, 3, false), false);
});

test('credit gate clamps a regressed durable offset without stalling later waiters', async () => {
  const gate = new ReceiveCreditGate(8 * 1024, 0, 1024);
  gate.recordSent(1024);
  gate.update(1024, 1024, 8 * 1024);

  gate.recordSent(1024);
  assert.equal(gate.snapshot().sentOverallBytes, 2048);

  let released = false;
  const waiting = gate.waitForAvailable(1024).then((bytes) => {
    released = true;
    return bytes;
  });
  await Promise.resolve();
  assert.equal(released, false);

  gate.update(512, 1024, 8 * 1024);
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(gate.snapshot().persistedOverallBytes, 1024);

  gate.update(2048, 1024, 8 * 1024);
  assert.equal(await waiting, 1024);
  assert.equal(gate.snapshot().persistedOverallBytes, 2048);
});
