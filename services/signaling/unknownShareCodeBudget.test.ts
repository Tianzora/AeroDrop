import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN_SHARE_CODE_BUDGET,
  createUnknownShareCodeBudget,
} from './unknownShareCodeBudget.ts';

test('allows the configured number of misses in a window and then fails closed', () => {
  const budget = createUnknownShareCodeBudget({ maxMisses: 3, windowMs: 10_000 });

  assert.deepEqual(budget.consume(0), { allowed: true, remaining: 2 });
  assert.deepEqual(budget.consume(0), { allowed: true, remaining: 1 });
  assert.deepEqual(budget.consume(0), { allowed: true, remaining: 0 });

  const denied = budget.consume(1_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.retryAfterMs, 9_000, 'retry hint points at the window end');
  assert.equal(budget.getMissCount(), 3);
});

test('opens a fresh budget once the window elapses', () => {
  const budget = createUnknownShareCodeBudget({ maxMisses: 1, windowMs: 1_000 });
  assert.equal(budget.consume(0).allowed, true);
  assert.equal(budget.consume(500).allowed, false);
  assert.equal(budget.consume(1_000).allowed, true, 'the window resets exactly at windowMs');
  assert.equal(budget.getMissCount(), 1);
});

test('defaults to 200 misses per 10 seconds and is not shared between instances', () => {
  assert.deepEqual(UNKNOWN_SHARE_CODE_BUDGET, { maxMisses: 200, windowMs: 10_000 });

  const first = createUnknownShareCodeBudget();
  const second = createUnknownShareCodeBudget();
  for (let index = 0; index < 200; index += 1) {
    assert.equal(first.consume(0).allowed, true);
  }
  assert.equal(first.consume(1).allowed, false);
  // 预算是每实例（每 DO isolate）独立的，不能被另一个实例提前消耗。
  assert.equal(second.consume(1).allowed, true);
});
