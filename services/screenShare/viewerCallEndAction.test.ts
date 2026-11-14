import test from 'node:test';
import assert from 'node:assert/strict';

import { planViewerCallEndAction, type ViewerCallEndAction } from './viewerCallEndAction.ts';
import {
  planViewerCallEndOutcome,
  type ViewerCallEndOutcome,
} from './viewerShareFullFallback.ts';

const ALL_OUTCOMES: ViewerCallEndOutcome[] = [
  'share-ended',
  'share-full',
  'manual-stop',
  'rate-limited',
  'sharer-unavailable',
  'media-failed',
  'suspected-share-full',
  'reconnect',
];

const EXPECTED: Record<ViewerCallEndOutcome, ViewerCallEndAction> = {
  'share-ended': 'end-share',
  'share-full': 'stop',
  'manual-stop': 'stop-manual',
  'rate-limited': 'await-peer-error',
  'sharer-unavailable': 'await-peer-error',
  'media-failed': 'media-error',
  'suspected-share-full': 'suspected-full',
  reconnect: 'reconnect',
};

test('每个结论都有动作，且不会被悄悄漏掉', () => {
  for (const outcome of ALL_OUTCOMES) {
    assert.equal(planViewerCallEndAction(outcome), EXPECTED[outcome], outcome);
  }
});

test('分享者不在线交给 peer 级错误分类，不重连', () => {
  // 反证点：把映射改成 'reconnect'，这条立刻红。之前 close 分支不看结论、无条件重连，
  // 纯函数返回 'sharer-unavailable' 也没人消费——分享者下线被兜成「连接超时」。
  assert.equal(planViewerCallEndAction('sharer-unavailable'), 'await-peer-error');
});

test('只有 reconnect 结论才允许自动重连', () => {
  // 反证点：任一把非 reconnect 结论映射到 'reconnect'，这条红。
  for (const outcome of ALL_OUTCOMES) {
    assert.equal(
      planViewerCallEndAction(outcome) === 'reconnect',
      outcome === 'reconnect',
      outcome,
    );
  }
});

test('媒体建连失败落到媒体失败动作，不是疑似满员', () => {
  const outcome = planViewerCallEndOutcome({
    manualStop: false,
    shareEnded: false,
    shareFull: false,
    receivedStream: false,
    dataChannelOpened: false,
    transportFailed: true,
  });
  assert.equal(outcome, 'media-failed');
  assert.equal(planViewerCallEndAction(outcome), 'media-error');
});
