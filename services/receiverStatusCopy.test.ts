import assert from 'node:assert/strict';
import test from 'node:test';

import { getReceiverWaitingStatusCopy } from './receiverStatusCopy.ts';

test('reconnecting stage surfaces recovery-specific title and detail', () => {
  const copy = getReceiverWaitingStatusCopy({
    stage: 'reconnecting',
    reconnectAttempt: 2,
  });

  assert.equal(copy.title, '连接中断，正在尝试恢复...');
  assert.equal(copy.detail, '第 2 次自动重连中，请保持此页面打开，无需重新输入口令');
  assert.equal(copy.cancelLabel, '停止重连');
});

test('connecting peer copy does not claim a point-to-point path before ICE selects one', () => {
  const copy = getReceiverWaitingStatusCopy({
    stage: 'connecting_peer',
    reconnectAttempt: 0,
  });

  assert.equal(copy.title, '正在建立连接...');
  assert.equal(copy.detail, '同时尝试直连与中继，连上后显示实际路径');
  assert.equal(copy.cancelLabel, '取消');
});

test('connecting signaling copy reflects AeroDrop signaling instead of legacy peerjs wording', () => {
  const copy = getReceiverWaitingStatusCopy({
    stage: 'connecting_signaling',
    reconnectAttempt: 0,
  });

  assert.equal(copy.title, '正在连接信令服务...');
  assert.equal(copy.detail, undefined);
  assert.equal(copy.cancelLabel, '取消');
});
