import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planViewerCallEndOutcome,
  shouldReconnectAfterCallEnd,
  type ViewerCallEndInput,
} from './viewerShareFullFallback.ts';

const base: ViewerCallEndInput = {
  manualStop: false,
  shareEnded: false,
  shareFull: false,
  receivedStream: true,
  dataChannelOpened: true,
};

test('共享方发了 share-ended：哪怕同时收到过画面也按「已结束」处理', () => {
  assert.equal(
    planViewerCallEndOutcome({ ...base, shareEnded: true, shareFull: true, manualStop: true }),
    'share-ended',
  );
});

test('已经收到 share-full：直接按满员处理，不再猜', () => {
  assert.equal(planViewerCallEndOutcome({ ...base, shareFull: true }), 'share-full');
});

test('用户自己取消：不要报成断链或满员', () => {
  assert.equal(planViewerCallEndOutcome({ ...base, manualStop: true }), 'manual-stop');
});

test('没收到画面且数据通道从未打开：判为疑似满员，而不是断链', () => {
  assert.equal(
    planViewerCallEndOutcome({ ...base, receivedStream: false, dataChannelOpened: false }),
    'suspected-share-full',
  );
});

test('收到过画面再断：照旧走重连', () => {
  assert.equal(planViewerCallEndOutcome({ ...base, receivedStream: true }), 'reconnect');
});

test('数据通道开过就没被名额挡下：早期断链仍走重连，不能误报满员', () => {
  // 反证点：把判定里的 `&& !dataChannelOpened` 去掉，这条会变成 'suspected-share-full'。
  assert.equal(
    planViewerCallEndOutcome({ ...base, receivedStream: false, dataChannelOpened: true }),
    'reconnect',
  );
});

test('只有 reconnect 允许自动重连：满员不会自己空出名额', () => {
  assert.equal(shouldReconnectAfterCallEnd('reconnect'), true);
  for (const outcome of ['share-ended', 'share-full', 'manual-stop', 'suspected-share-full'] as const) {
    assert.equal(shouldReconnectAfterCallEnd(outcome), false, outcome);
  }
});
