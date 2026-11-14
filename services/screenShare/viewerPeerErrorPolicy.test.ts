import test from 'node:test';
import assert from 'node:assert/strict';

import { planViewerPeerError } from './viewerPeerErrorPolicy.ts';

const base = {
  type: 'peer-unavailable',
  manualStop: false,
  shareEnded: false,
  retryAfterMs: null as number | null,
  fallbackRetryAfterMs: 60_000,
};

test('分享者不存在（链接已死）直接终态，不再花重连预算', () => {
  assert.deepEqual(planViewerPeerError(base), { kind: 'share-gone' });
});

test('被信令层限流时给出冷却时长，而不是满员/网络结论', () => {
  assert.deepEqual(planViewerPeerError({ ...base, type: 'rate-limited' }), {
    kind: 'rate-limited',
    retryAfterMs: 60_000,
  });
});

test('信令层给了 Retry-After 就用它，没有才退回静默期兜底', () => {
  assert.deepEqual(
    planViewerPeerError({ ...base, type: 'rate-limited', retryAfterMs: 4_500 }),
    { kind: 'rate-limited', retryAfterMs: 4_500 },
  );
  // 0 / 负数 / NaN 都是「不知道还要等多久」，不能用它们把倒计时算成立刻可用。
  for (const bad of [0, -1, Number.NaN]) {
    assert.deepEqual(
      planViewerPeerError({ ...base, type: 'rate-limited', retryAfterMs: bad }),
      { kind: 'rate-limited', retryAfterMs: 60_000 },
    );
  }
});

test('每出口会话数被占满时不给倒计时：等多久都不会好', () => {
  assert.deepEqual(
    planViewerPeerError({ ...base, type: 'rate-limited', limit: 'session', retryAfterMs: 60_000 }),
    { kind: 'session-limit' },
  );
  // 显式标 offer 与完全没标都必须继续走倒计时那条路（旧行为不能回归）。
  assert.deepEqual(planViewerPeerError({ ...base, type: 'rate-limited', limit: 'offer' }), {
    kind: 'rate-limited',
    retryAfterMs: 60_000,
  });
  assert.deepEqual(planViewerPeerError({ ...base, type: 'rate-limited', limit: null }), {
    kind: 'rate-limited',
    retryAfterMs: 60_000,
  });
});

test('用户手动取消或分享方已结束时不产生错误状态', () => {
  assert.deepEqual(planViewerPeerError({ ...base, manualStop: true }), { kind: 'ignore' });
  assert.deepEqual(planViewerPeerError({ ...base, shareEnded: true }), { kind: 'ignore' });
});

test('其它信令错误仍然交给调用方翻译成通用文案', () => {
  for (const type of ['network', 'socket-error', 'server-error', 'webrtc-error']) {
    assert.deepEqual(planViewerPeerError({ ...base, type }), { kind: 'report' });
  }
});
