import test from 'node:test';
import assert from 'node:assert/strict';

import { decideViewerHeartbeat } from './viewerHeartbeatPolicy.ts';

const NOW = 1_000_000;
const THIRTY_ONE_SECONDS_AGO = NOW - 31_000;
const SIX_MINUTES_AGO = NOW - 6 * 60 * 1000;

test('传输健康时无视心跳缺失：数据通道还开着就不是死连接', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: SIX_MINUTES_AGO,
      now: NOW,
      connectionState: 'connected',
      dataChannelOpen: true,
      tabHidden: false,
    }),
    { action: 'keep', refresh: true },
  );
});

test('PC 已 failed/closed 时立即关闭，与心跳新旧无关', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: NOW,
      now: NOW,
      connectionState: 'failed',
      dataChannelOpen: true,
      tabHidden: false,
    }),
    { action: 'close', reason: 'transport-failed' },
  );
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: NOW,
      now: NOW,
      connectionState: 'closed',
      dataChannelOpen: false,
      tabHidden: false,
    }),
    { action: 'close', reason: 'transport-failed' },
  );
});

test('没有心跳基线时交给连接超时兜底，不在这里误杀', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: null,
      now: NOW,
      connectionState: 'connecting',
      dataChannelOpen: false,
      tabHidden: false,
    }),
    { action: 'keep', refresh: false },
  );
});

test('31 秒没心跳且传输不健康：可见标签页按软超时关闭', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: THIRTY_ONE_SECONDS_AGO,
      now: NOW,
      connectionState: 'disconnected',
      dataChannelOpen: false,
      tabHidden: false,
    }),
    { action: 'close', reason: 'heartbeat-timeout' },
  );
});

test('分享端自己在后台时节流导致的时间跳变不算观众掉线', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: THIRTY_ONE_SECONDS_AGO,
      now: NOW,
      connectionState: 'connecting',
      dataChannelOpen: true,
      tabHidden: true,
    }),
    { action: 'keep', refresh: false },
  );
});

test('超过硬超时才是真死：后台豁免不能覆盖 5 分钟', () => {
  assert.deepEqual(
    decideViewerHeartbeat({
      lastHeartbeatAt: SIX_MINUTES_AGO,
      now: NOW,
      connectionState: 'disconnected',
      dataChannelOpen: true,
      tabHidden: true,
    }),
    { action: 'close', reason: 'hard-timeout' },
  );
});

test('阈值可由调用方覆写，便于按弱网档位调整', () => {
  assert.deepEqual(
    decideViewerHeartbeat(
      {
        lastHeartbeatAt: NOW - 11_000,
        now: NOW,
        connectionState: 'disconnected',
        dataChannelOpen: false,
        tabHidden: false,
      },
      { heartbeatTimeoutMs: 10_000, hardTimeoutMs: 60_000 },
    ),
    { action: 'close', reason: 'heartbeat-timeout' },
  );
});
