import test from 'node:test';
import assert from 'node:assert/strict';

import { createSingleFlight } from './peerInitGuard.ts';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('慢速初始化在飞时第二次调用被拒绝：并发不会登记两个房号', async () => {
  const flight = createSingleFlight();
  const registrations: string[] = [];

  // 模拟 initializePeer：登记房号是慢操作，期间看门狗/退避会再次触发同一个函数。
  const initializePeer = async () => {
    if (!flight.tryEnter()) return false;
    try {
      await wait(20);
      registrations.push('room');
      return true;
    } finally {
      flight.leave();
    }
  };

  const results = await Promise.all([initializePeer(), initializePeer()]);

  assert.deepEqual(results, [true, false], '第二次调用应该被闸门挡下');
  assert.equal(registrations.length, 1, '并发初始化只能登记一个房号');
  assert.equal(flight.isInFlight(), false, '结束之后闸门必须放开');
});

test('初始化抛错也要释放闸门：一次失败不能把后续重试永久卡死', async () => {
  const flight = createSingleFlight();

  const failing = async () => {
    if (!flight.tryEnter()) return false;
    try {
      throw new Error('registration exploded');
    } finally {
      flight.leave();
    }
  };

  await assert.rejects(failing, /registration exploded/);
  assert.equal(flight.isInFlight(), false);
  assert.equal(flight.tryEnter(), true, '失败后下一轮重试必须能重新进入');
  flight.leave();
});

test('串行调用不受影响：一次结束之后下一次照常进入', () => {
  const flight = createSingleFlight();
  assert.equal(flight.tryEnter(), true);
  assert.equal(flight.tryEnter(), false);
  flight.leave();
  assert.equal(flight.tryEnter(), true);
  flight.leave();
});
