import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRouteSelectionTimings,
  pickPreferredRouteKind,
  type RouteSelectionContext,
} from './routeSelectionPolicy.ts';

test('desktop relay recommendation keeps all as primary and relay as background fallback', () => {
  const timings = getRouteSelectionTimings({
    isMobileDevice: false,
    isConstrained: false,
    relayRecommended: true,
  } satisfies RouteSelectionContext);

  assert.equal(timings.startAllImmediately, true);
  assert.equal(timings.startRelayDelayMs, 800);
  assert.equal(timings.p2pGraceWindowMs, 1500);
});

test('desktop normal network does not prewarm relay by default', () => {
  const timings = getRouteSelectionTimings({
    isMobileDevice: false,
    isConstrained: false,
    relayRecommended: false,
  } satisfies RouteSelectionContext);

  assert.equal(timings.startAllImmediately, true);
  assert.equal(timings.startRelayDelayMs, null);
  assert.equal(timings.p2pGraceWindowMs, 1800);
});

test('mobile or constrained network keeps all first and shortens relay prewarm delay', () => {
  const timings = getRouteSelectionTimings({
    isMobileDevice: true,
    isConstrained: true,
    relayRecommended: true,
  } satisfies RouteSelectionContext);

  assert.equal(timings.startAllImmediately, true);
  assert.equal(timings.startRelayDelayMs, 500);
  assert.equal(timings.p2pGraceWindowMs, 900);
});

test('LAN direct outranks relay', () => {
  const winner = pickPreferredRouteKind(
    { isDirect: false, isLanDirect: false, kind: 'relay' },
    { isDirect: true, isLanDirect: true, kind: 'all' }
  );

  assert.equal(winner, 'all');
});

test('equal route quality keeps all authoritative regardless of argument order', () => {
  const allRoute = { isDirect: true, isLanDirect: false, kind: 'all' } as const;
  const relayRoute = { isDirect: true, isLanDirect: false, kind: 'relay' } as const;

  assert.equal(pickPreferredRouteKind(relayRoute, allRoute), 'all');
  assert.equal(pickPreferredRouteKind(allRoute, relayRoute), 'all');
});
