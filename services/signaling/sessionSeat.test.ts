import test from 'node:test';
import assert from 'node:assert/strict';

import { createSignalingSessionLimiter } from '../signalingRateLimitPolicy.ts';
import { planSignalingSessionSeat } from './sessionSeat.ts';

test('same-IP takeover transfers the seat instead of releasing and re-acquiring', () => {
  assert.deepEqual(
    planSignalingSessionSeat({ isTakeover: true, existingClientKey: 'ip:203.0.113.7', clientKey: 'ip:203.0.113.7' }),
    { kind: 'transfer' }
  );
});

test('fresh connections and cross-IP takeovers must acquire a seat', () => {
  assert.deepEqual(planSignalingSessionSeat({ isTakeover: false, clientKey: 'ip:203.0.113.7' }), { kind: 'acquire' });
  assert.deepEqual(
    planSignalingSessionSeat({
      isTakeover: true,
      existingClientKey: 'ip:198.51.100.9',
      clientKey: 'ip:203.0.113.7',
    }),
    { kind: 'acquire' }
  );
  assert.deepEqual(
    planSignalingSessionSeat({ isTakeover: true, existingClientKey: null, clientKey: 'ip:203.0.113.7' }),
    { kind: 'acquire' }
  );
});

test('the old release-then-fail sequence drifts the seat count; the plan does not', () => {
  const limiter = createSignalingSessionLimiter(1);
  const clientKey = 'ip:203.0.113.7';

  assert.equal(limiter.tryAcquire(clientKey), true);
  assert.equal(limiter.getActiveSessionCount(), 1);

  // 旧实现：接管时先 release 再 tryAcquire；中间任何失败都会让计数永久少 1。
  limiter.release(clientKey);
  assert.equal(limiter.getActiveSessionCount(), 0, 'release 之后计数已经掉了');
  assert.equal(limiter.tryAcquire(clientKey), true, '只有重新领回来才能守恒');
  assert.equal(limiter.getActiveSessionCount(), 1);

  // 新实现：同 IP 接管直接转移，不碰计数。
  const plan = planSignalingSessionSeat({ isTakeover: true, existingClientKey: clientKey, clientKey });
  assert.equal(plan.kind, 'transfer');
  assert.equal(limiter.getActiveSessionCount(), 1, 'transfer 不改变计数');

  // 跨 IP 接管才 acquire；失败时旧会话的席位仍在。
  const otherKey = 'ip:198.51.100.9';
  assert.equal(limiter.tryAcquire(otherKey), true);
  assert.equal(limiter.tryAcquire(otherKey), false, '同 IP 第二席位被拒');
  assert.equal(limiter.getActiveSessionCount(), 2, '拒绝不写坏计数，被接管方的席位也不受影响');
});
