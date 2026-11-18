import test from 'node:test';
import assert from 'node:assert/strict';

import type { MediaConnection } from '../peerRuntime';
import {
  describeCaptureError,
  findLiveAudioSender,
  hasUserActivation,
  isEmbeddedFrame,
  readRateLimitLayer,
  readRetryAfterMs,
  viewerMediaIsHealthy,
} from './screenShareHelpers.ts';
import { startBandwidthMonitoring, type BandwidthMonitorEntry } from './bandwidthMonitor.ts';

function makeStats(reports: Record<string, Record<string, unknown>>) {
  const map = new Map(Object.entries(reports));
  return {
    forEach(callback: (report: unknown, id: string) => void) {
      for (const [id, report] of map) callback(report, id);
    },
    get(id: string) {
      return map.get(id);
    },
    has(id: string) {
      return map.has(id);
    },
  };
}

function makeCall(peer: string, pc: unknown): MediaConnection {
  return { peer, peerConnection: pc } as unknown as MediaConnection;
}

test('isEmbeddedFrame 在无 window 或顶层窗口时为 false，在 iframe 内为 true', () => {
  const g = globalThis as { window?: unknown };
  const original = g.window;
  try {
    delete g.window;
    assert.equal(isEmbeddedFrame(), false);
    g.window = { self: {}, top: {} };
    assert.equal(isEmbeddedFrame(), true);
    const self = {};
    g.window = { self, top: self };
    assert.equal(isEmbeddedFrame(), false);
  } finally {
    if (original === undefined) delete g.window;
    else g.window = original;
  }
});

test('hasUserActivation 读取 navigator.userActivation，缺失时按已激活处理', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userActivation: { isActive: false } },
    });
    assert.equal(hasUserActivation(), false);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userActivation: { isActive: true } },
    });
    assert.equal(hasUserActivation(), true);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    assert.equal(hasUserActivation(), true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('viewerMediaIsHealthy 只认 connected 的媒体连接', () => {
  assert.equal(viewerMediaIsHealthy(null), false);
  assert.equal(
    viewerMediaIsHealthy({ peerConnection: { connectionState: 'failed' } } as unknown as MediaConnection),
    false,
  );
  assert.equal(
    viewerMediaIsHealthy({ peerConnection: { connectionState: 'connected' } } as unknown as MediaConnection),
    true,
  );
});

test('readRetryAfterMs 只接受正有限数，其余返回 null', () => {
  assert.equal(readRetryAfterMs({ retryAfterMs: 5000 }), 5000);
  assert.equal(readRetryAfterMs({ retryAfterMs: 0 }), null);
  assert.equal(readRetryAfterMs({ retryAfterMs: -1 }), null);
  assert.equal(readRetryAfterMs({ retryAfterMs: '5000' }), null);
  assert.equal(readRetryAfterMs(null), null);
});

test('readRateLimitLayer 只识别 session/offer', () => {
  assert.equal(readRateLimitLayer({ limit: 'session' }), 'session');
  assert.equal(readRateLimitLayer({ limit: 'offer' }), 'offer');
  assert.equal(readRateLimitLayer({ limit: 'other' }), null);
  assert.equal(readRateLimitLayer(undefined), null);
});

test('describeCaptureError 返回可展示的失败说明', () => {
  const failure = describeCaptureError(new Error('Permission denied'));
  assert.ok(failure && typeof failure === 'object');
});

test('findLiveAudioSender 跳过 stopped 的 transceiver 并返回 sender', () => {
  const sender = { track: null };
  assert.equal(findLiveAudioSender(undefined), null);
  assert.equal(
    findLiveAudioSender({
      getTransceivers: () => [
        { receiver: { track: { kind: 'video' } }, direction: 'sendrecv', sender: { track: null } },
        { receiver: { track: { kind: 'audio' } }, direction: 'stopped', sender: { track: null } },
      ],
    } as unknown as RTCPeerConnection),
    null,
  );
  assert.equal(
    findLiveAudioSender({
      getTransceivers: () => [
        { receiver: { track: { kind: 'audio' } }, direction: 'sendrecv', sender },
      ],
    } as unknown as RTCPeerConnection),
    sender,
  );
});

test('startBandwidthMonitoring 采样统计并应用码率上限', async () => {
  const stats = makeStats({
    out: { type: 'outbound-rtp', kind: 'video', bytesSent: 1000, packetsSent: 10, remoteId: 'rin' },
    rin: { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 2 },
    pair: { type: 'candidate-pair', selected: true, localCandidateId: 'lc', remoteCandidateId: 'rc' },
    lc: { type: 'local-candidate', candidateType: 'host' },
    rc: { type: 'remote-candidate', candidateType: 'srflx' },
  });
  const slowStats = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return stats;
  };
  const pc = { getStats: slowStats } as unknown as RTCPeerConnection;
  const monitors = new Map<string, BandwidthMonitorEntry>();
  const peerQualityLevels = new Map<string, 'high' | 'medium' | 'low'>();
  const peerRelay = new Map<string, boolean>();
  const peerAppliedCaps = new Map<string, number>();
  const applied: string[] = [];
  const deps = {
    monitors,
    peerQualityLevels,
    peerRelay,
    peerAppliedCaps,
    getUniqueViewerCount: () => 1,
    applyBitrateConstraints: async (pcArg: RTCPeerConnection, level: string) => {
      assert.equal(pcArg, pc);
      applied.push(level);
      return true;
    },
    setPeerQualityLevel: () => {},
    notifyQualityChange: () => {},
  };
  const call = makeCall('peer-1', pc);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  try {
    startBandwidthMonitoring(call, deps);
    for (let i = 0; i < 100 && applied.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(monitors.size, 1);
    assert.ok(applied.length >= 1);
    assert.ok(peerAppliedCaps.has('peer-1'));
    assert.equal(peerRelay.get('peer-1'), false);
    const first = monitors.get('peer-1');
    assert.equal(first?.pc, pc);
    if (first) timers.push(first.timer);

    // 同一个 pc 重复调用不重建监控；换成新 pc 时先清掉旧监控。
    const manualTimer = setInterval(() => {}, 1000);
    timers.push(manualTimer);
    monitors.set('peer-1', { timer: manualTimer, pc });
    startBandwidthMonitoring(call, deps);
    assert.equal(monitors.size, 1);
    const nextPc = { getStats: slowStats } as unknown as RTCPeerConnection;
    startBandwidthMonitoring(makeCall('peer-1', nextPc), deps);
    assert.equal(monitors.get('peer-1')?.pc, nextPc);
    const switched = monitors.get('peer-1');
    if (switched) timers.push(switched.timer);
  } finally {
    for (const timer of timers) clearInterval(timer);
    const remaining = monitors.get('peer-1');
    if (remaining) clearInterval(remaining.timer);
  }
});

test('startBandwidthMonitoring 无 peerConnection 时直接返回，getStats 失败不抛', async () => {
  const monitors = new Map<string, BandwidthMonitorEntry>();
  const deps = {
    monitors,
    peerQualityLevels: new Map<string, 'high' | 'medium' | 'low'>(),
    peerRelay: new Map<string, boolean>(),
    peerAppliedCaps: new Map<string, number>(),
    getUniqueViewerCount: () => 1,
    applyBitrateConstraints: async () => true,
    setPeerQualityLevel: () => {},
    notifyQualityChange: () => {},
  };
  startBandwidthMonitoring(makeCall('peer-2', null), deps);
  assert.equal(monitors.size, 0);

  const failing = { getStats: async () => { throw new Error('stats failed'); } } as unknown as RTCPeerConnection;
  startBandwidthMonitoring(makeCall('peer-3', failing), deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(monitors.size, 1);
  clearInterval(monitors.get('peer-3')?.timer);
});