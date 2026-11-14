import test from 'node:test';
import assert from 'node:assert/strict';

import { planViewerReconnect } from './viewerReconnectPolicy.ts';

const INPUT = { attempts: 0, maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 10_000 };

test('重连等待线性递增并封顶：2/4/6/8/10 秒', () => {
  const delays = [0, 1, 2, 3, 4].map((attempts) => {
    const plan = planViewerReconnect({ ...INPUT, attempts });
    assert.equal(plan.kind, 'retry');
    if (plan.kind !== 'retry') throw new Error('unreachable');
    assert.equal(plan.attempt, attempts + 1);
    return plan.delayMs;
  });

  assert.deepEqual(delays, [2_000, 4_000, 6_000, 8_000, 10_000]);
});

test('用完预算就落终态：不能靠「信令又 open 了一次」把计数清零后无限重连', () => {
  const plan = planViewerReconnect({ ...INPUT, attempts: 5 });

  assert.deepEqual(plan, { kind: 'exhausted' });
});

test('超预算（例如上一轮计数残留）同样落终态，不会给出负延迟', () => {
  const plan = planViewerReconnect({ ...INPUT, attempts: 9 });

  assert.deepEqual(plan, { kind: 'exhausted' });
});

test('异常输入按保守值处理：NaN 计数当 0、预算当 0', () => {
  const fromNaN = planViewerReconnect({ ...INPUT, attempts: Number.NaN });
  assert.equal(fromNaN.kind, 'retry');
  if (fromNaN.kind === 'retry') assert.equal(fromNaN.delayMs, 2_000);

  const noBudget = planViewerReconnect({ ...INPUT, maxAttempts: 0 });
  assert.deepEqual(noBudget, { kind: 'exhausted' });

  const negativeDelay = planViewerReconnect({ ...INPUT, attempts: 0, baseDelayMs: -1_000 });
  assert.equal(negativeDelay.kind, 'retry');
  if (negativeDelay.kind === 'retry') assert.equal(negativeDelay.delayMs, 0);
});
