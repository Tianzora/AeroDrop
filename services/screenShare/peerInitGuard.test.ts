import test from 'node:test';
import assert from 'node:assert/strict';

import { createSingleFlight, createSingleFlightSlot } from './peerInitGuard.ts';

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

test('卡住的闸门会被判为过期、可以换掉：一次挂住的登记不该让分享永久停在 amber', () => {
  const flight = createSingleFlight();
  assert.equal(flight.tryEnter(), true);
  // 刚进入时当然没过期：这是「绕过兜底的死锁」的判据，不是超时的替代品。
  assert.equal(flight.isStale(Date.now(), 60_000), false);
  assert.equal(flight.isStale(Date.now() + 60_001, 60_000), true);

  const idle = createSingleFlight();
  assert.equal(idle.isStale(Date.now() + 10_000_000, 60_000), false, '没人持有的闸门无从过期');
});

test('停止后立刻再开始：换新闸门让新会话进得去，旧调用的 leave 不会放掉新闸门', () => {
  const slot = createSingleFlightSlot();
  const previous = slot.current();
  assert.equal(previous.tryEnter(), true, '旧会话的初始化还卡在 await 上');

  const fresh = slot.reset();
  assert.notEqual(fresh, previous, 'reset 必须换新对象，否则旧调用的 finally 会误放新会话的闸门');
  assert.equal(slot.current().tryEnter(), true, '新会话必须能抢到自己的闸门');

  previous.leave();
  assert.equal(slot.current().isInFlight(), true, '旧调用收尾只该影响它自己那一个闸门');
  assert.equal(slot.current().tryEnter(), false);
});
