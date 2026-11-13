import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverRegisteredThenCommit } from './sessionAdmissionDelivery.ts';

test('commits the rotation only after the registered frame was delivered', async () => {
  const order: string[] = [];
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => order.push('send'),
    commit: () => {
      order.push('commit');
    },
  });

  assert.equal(outcome, 'delivered');
  assert.deepEqual(order, ['send', 'commit']);
});

test('skips the commit when the registered frame cannot be delivered', async () => {
  let committed = false;
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => {
      throw new Error('socket closed');
    },
    commit: () => {
      committed = true;
    },
  });

  // 帧没送到客户端 → 不能落库：否则客户端只持有旧 proof，宽限期过后永久 4010。
  assert.equal(outcome, 'send-failed');
  assert.equal(committed, false);
});

test('reports a commit failure without undoing the delivered frame', async () => {
  const errors: unknown[] = [];
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => {},
    commit: async () => {
      throw new Error('binding store unavailable');
    },
    onCommitError: (error) => errors.push(error),
  });

  assert.equal(outcome, 'commit-failed');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /binding store unavailable/);
});
