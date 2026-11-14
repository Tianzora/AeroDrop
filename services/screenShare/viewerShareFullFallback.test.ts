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

test('分享者不在线（死链/重建窗口）不能报成「人数已满」', () => {
  // 反证点：把 sharerUnavailable 分支删掉，这条会掉到 'suspected-share-full'——
  // 观众先看到确定语气的「分享人数已满」，3 秒后才被 peer 级错误改成「分享者暂时不在线」。
  // 拿不准是满员还是分享者不在时，宁可交给 peer 级分类，也不要先吓一次人。
  assert.equal(
    planViewerCallEndOutcome({
      ...base,
      receivedStream: false,
      dataChannelOpened: false,
      sharerUnavailable: true,
    }),
    'sharer-unavailable',
  );
});

test('已经收到过画面时，分享者不在线仍按断链重连处理', () => {
  assert.equal(
    planViewerCallEndOutcome({ ...base, receivedStream: true, sharerUnavailable: true }),
    'reconnect',
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

test('同一出口被限流时先判限流，不能报成满员：等窗口过去就能连上', () => {
  // 反证点：把 rateLimited 分支删掉，这条会掉到 'suspected-share-full'，
  // 用户就会看到「可能人数已满」并放弃等待——而实际上等一分钟就能进。
  assert.equal(
    planViewerCallEndOutcome({
      ...base,
      receivedStream: false,
      dataChannelOpened: false,
      rateLimited: true,
    }),
    'rate-limited',
  );
});

test('已经收到过画面再被限流：仍按断链重连，限流只解释「一次都没连上」', () => {
  assert.equal(planViewerCallEndOutcome({ ...base, rateLimited: true }), 'reconnect');
});

test('只有 reconnect 允许自动重连：满员不会自己空出名额', () => {
  assert.equal(shouldReconnectAfterCallEnd('reconnect'), true);
  for (const outcome of ['share-ended', 'share-full', 'manual-stop', 'rate-limited', 'suspected-share-full'] as const) {
    assert.equal(shouldReconnectAfterCallEnd(outcome), false, outcome);
  }
});
