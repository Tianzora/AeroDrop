import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COMMIT_ATTEMPTS,
  SESSION_COMMIT_RETRY_DELAY_MS,
  deliverRegisteredThenCommit,
} from './sessionAdmissionDelivery.ts';

const noWait = async () => {};

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
    wait: noWait,
    onCommitError: (error) => errors.push(error),
  });

  // 重试耗尽后只报一次：告警按事件计数，逐次上报会把一次故障放大成 N 次。
  assert.equal(outcome, 'commit-failed');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /binding store unavailable/);
});

test('retries a transient commit failure before giving up', async () => {
  const attempts: number[] = [];
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => {},
    commit: (attempt) => {
      attempts.push(attempt);
      if (attempt < SESSION_COMMIT_ATTEMPTS) throw new Error(`attempt ${attempt} failed`);
    },
    wait: noWait,
  });

  assert.equal(outcome, 'delivered');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('backs off between commit attempts and never recovers on success', async () => {
  const delays: number[] = [];
  let recovered = 0;
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => {},
    commit: (attempt) => {
      if (attempt === 1) throw new Error('first attempt lost the write');
    },
    wait: async (ms) => {
      delays.push(ms);
    },
    recover: () => {
      recovered += 1;
    },
  });

  assert.equal(outcome, 'delivered');
  // 退避是递增的：瞬时抖动通常在第二次就能过，第一次的等待要短。
  assert.deepEqual(delays, [SESSION_COMMIT_RETRY_DELAY_MS]);
  assert.equal(recovered, 0);
});

test('falls back to the pending proof history when the commit never lands', async () => {
  const calls: string[] = [];
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => calls.push('send'),
    commit: () => {
      calls.push('commit');
      throw new Error('binding store unavailable');
    },
    wait: noWait,
    onCommitError: () => calls.push('report'),
    recover: () => {
      calls.push('recover');
    },
  });

  // 自愈排在记账之后：先记录真实故障，再做尽力补救，方便日志解释后续为何还能连上。
  assert.equal(outcome, 'commit-failed');
  assert.deepEqual(calls, ['send', 'commit', 'commit', 'commit', 'report', 'recover']);
});

test('keeps a failed recovery from escalating the delivery outcome', async () => {
  const recoverErrors: unknown[] = [];
  const outcome = await deliverRegisteredThenCommit({
    sendRegistered: () => {},
    commit: async () => {
      throw new Error('binding store unavailable');
    },
    wait: noWait,
    recover: async () => {
      throw new Error('fallback store unavailable');
    },
    onRecoverError: (error) => recoverErrors.push(error),
  });

  // 客户端已经拿到 registered；自愈失败也不能让调用方开始回滚一个已生效的注册。
  assert.equal(outcome, 'commit-failed');
  assert.equal(recoverErrors.length, 1);
  assert.match(String(recoverErrors[0]), /fallback store unavailable/);
});
