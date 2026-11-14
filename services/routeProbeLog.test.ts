import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteProbeLogPayload, type RouteProbeLogPayload } from './routeProbeLog.ts';

test('createRouteProbeLogPayload：原样保留字段，便于日志端按固定结构消费', () => {
  const payload: RouteProbeLogPayload = {
    receiverSessionId: 'rcv-1',
    attemptId: 'attempt-1',
    attemptKind: 'all',
    openedAt: 1_700_000_000_000,
    peerId: 'AERO-TEST0001',
  };

  const created = createRouteProbeLogPayload(payload);

  assert.deepEqual(created, payload);
  assert.equal(created.peerId, 'AERO-TEST0001');
});
