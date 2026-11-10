import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canAttemptFastReconnect,
  createHappyEyeballsPlan,
  getFastReconnectDelayMs,
  shouldAbandonExhaustedFastReconnect,
  shouldResetReconnectBudget,
} from './connectionPolicy.ts';
import { TransferState } from '../types/index.ts';
import type { BrowserNetworkProfile } from './networkProfile.ts';
import type { IceConfigResult } from './stunService.ts';

const baseIceConfig = (overrides: Partial<IceConfigResult> = {}): IceConfigResult => ({
  iceServers: [{ urls: 'turn:example.com?transport=udp' }],
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy: 'all',
  hasTurn: true,
  relayRecommended: false,
  relayReason: null,
  fetchLatencyMs: 200,
  ...overrides,
});

const baseProfile = (overrides: Partial<BrowserNetworkProfile> = {}): BrowserNetworkProfile => ({
  isMobileDevice: false,
  connectionType: 'unknown',
  effectiveType: '4g',
  saveData: false,
  rtt: 50,
  downlink: 30,
  isLikelyMobileNetwork: false,
  isConstrained: false,
  profileKey: 'desktop',
  ...overrides,
});

const options = {
  defaultInitialTimeoutMs: 15000,
  relayInitialTimeoutMs: 25000,
  relayParallelDelayMs: 1200,
  p2pBackfillDelayMs: 2200,
};

test('desktop relay recommendation keeps all as primary and relay as background fallback', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: true,
      relayReason: 'network',
    }),
    baseProfile(),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, 'relay');
  assert.equal(plan.reason, 'relay_recommended');
});

test('desktop normal network keeps all as the only initial route when no prewarm is needed', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: false,
      relayReason: null,
      fetchLatencyMs: 200,
    }),
    baseProfile(),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, null);
  assert.equal(plan.backgroundDelayMs, null);
  assert.equal(plan.reason, 'default');
});

test('constrained mobile network keeps all first and relay as fast background fallback', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: true,
      relayReason: 'network',
    }),
    baseProfile({
      isMobileDevice: true,
      connectionType: 'cellular',
      effectiveType: '3g',
      isLikelyMobileNetwork: true,
      isConstrained: true,
      profileKey: 'mobile',
    }),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, 'relay');
  assert.equal(plan.reason, 'mobile_network');
});

test('a stalled committed transfer retries through relay without changing the default P2P policy', () => {
  const forced = createHappyEyeballsPlan(baseIceConfig(), baseProfile(), {
    ...options,
    forceRelay: true,
  });
  const withoutTurn = createHappyEyeballsPlan(
    baseIceConfig({ hasTurn: false, iceServers: [] }),
    baseProfile(),
    { ...options, forceRelay: true },
  );

  assert.deepEqual(forced, {
    initialPolicy: 'relay',
    backgroundPolicy: null,
    initialTimeoutMs: 25000,
    backgroundDelayMs: null,
    backgroundTimeoutMs: null,
    reason: 'stalled_transfer',
  });
  assert.equal(withoutTurn.initialPolicy, 'all');
  assert.equal(withoutTurn.reason, 'default');
});

test('shouldResetReconnectBudget 只在连接稳定活过窗口后返回 true', () => {
  assert.equal(
    shouldResetReconnectBudget({ connectedSinceMs: null, nowMs: 20_000, stableWindowMs: 15_000 }),
    false,
  );
  assert.equal(
    shouldResetReconnectBudget({ connectedSinceMs: 0, nowMs: 14_999, stableWindowMs: 15_000 }),
    false,
  );
  assert.equal(
    shouldResetReconnectBudget({ connectedSinceMs: 1_000, nowMs: 15_999, stableWindowMs: 15_000 }),
    false,
  );
  assert.equal(
    shouldResetReconnectBudget({ connectedSinceMs: 1_000, nowMs: 16_000, stableWindowMs: 15_000 }),
    true,
  );
});

test('快速重连上限与退避延迟只由策略函数决定', () => {
  assert.equal(canAttemptFastReconnect(5, 6), true);
  assert.equal(canAttemptFastReconnect(6, 6), false);

  const delays = [1, 2, 3, 4, 5, 6].map((attempt) =>
    getFastReconnectDelayMs({ attempt, baseMs: 700, maxMs: 5_000 }),
  );
  assert.deepEqual(delays, [700, 1_400, 2_800, 5_000, 5_000, 5_000]);
  // attempt 从 1 起算的防御：0/负数按第 1 次算，不会算出 350ms 之类的怪值。
  assert.equal(getFastReconnectDelayMs({ attempt: 0, baseMs: 700, maxMs: 5_000 }), 700);
});

test('shouldAbandonExhaustedFastReconnect 只在还没连上且没有其它在途尝试时放弃', () => {
  assert.equal(
    shouldAbandonExhaustedFastReconnect({
      currentState: TransferState.WAITING_FOR_PEER,
      hasOtherRouteAttempt: false,
    }),
    true,
  );
  assert.equal(
    shouldAbandonExhaustedFastReconnect({
      currentState: TransferState.WAITING_FOR_PEER,
      hasOtherRouteAttempt: true,
    }),
    false,
  );
  assert.equal(
    shouldAbandonExhaustedFastReconnect({
      currentState: TransferState.TRANSFERRING,
      hasOtherRouteAttempt: false,
    }),
    false,
  );
});
