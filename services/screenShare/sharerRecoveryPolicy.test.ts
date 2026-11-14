import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planSharerFirstConnectWatchdog,
  planSharerRecovery,
  type SharerRecoveryInput,
} from './sharerRecoveryPolicy.ts';

const base: SharerRecoveryInput = {
  hasShareRoom: true,
  attempt: 1,
  maxAttempts: 5,
  peerMissing: false,
  peerRebuilds: 0,
  maxPeerRebuilds: 2,
  signalingState: 'connecting',
  roomFailureMessage: null,
  unreachableMessage: '无法连接信令服务器，请检查网络后重试',
  reconnectExhaustedMessage: '信令连接持续失败，请刷新页面后重新开始共享',
  sessionRejectedMessage: '信令服务拒绝了当前会话，请重新开始共享',
};

test('房号还没登记成功且预算未耗尽：重试完整初始化', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, hasShareRoom: false, attempt: 1 }),
    { kind: 'initialize-peer' },
  );
});

test('房号登记不上且重试预算耗尽：落终态，并用登记失败的具体文案', () => {
  assert.deepEqual(
    planSharerRecovery({
      ...base,
      hasShareRoom: false,
      attempt: 6,
      roomFailureMessage: '创建共享房间过于频繁，请稍后再试',
    }),
    { kind: 'terminal', message: '创建共享房间过于频繁，请稍后再试' },
  );
});

test('没有登记失败记录时，终态退回「信令不可达」而不是空文案', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, hasShareRoom: false, attempt: 6 }),
    { kind: 'terminal', message: base.unreachableMessage },
  );
});

test('peer 没了但房号还在、重建预算未用尽：重建 peer，链接继续有效', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, peerMissing: true, peerRebuilds: 0 }),
    { kind: 'rebuild-peer' },
  );
});

test('重建次数耗尽必须进终态「信令连接持续失败」', () => {
  // 反证点：删掉 peerMissing 分支里的预算比较，这里会返回 'rebuild-peer'，
  // 界面就永远停在「正在重建共享连接...」而没有「重新开始共享」入口。
  assert.deepEqual(
    planSharerRecovery({ ...base, peerMissing: true, peerRebuilds: 2 }),
    { kind: 'terminal', message: base.reconnectExhaustedMessage },
  );
});

test('信令被服务端明确拒绝：同一个房号重试不会好，直接终态', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, signalingState: 'rejected' }),
    { kind: 'terminal', message: base.sessionRejectedMessage },
  );
});

test('信令预算耗尽但还能重建 peer：先重建', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, signalingState: 'exhausted', peerRebuilds: 1 }),
    { kind: 'rebuild-peer' },
  );
});

test('信令预算耗尽且重建也用尽：终态「信令连接持续失败」', () => {
  assert.deepEqual(
    planSharerRecovery({ ...base, signalingState: 'destroyed', peerRebuilds: 2 }),
    { kind: 'terminal', message: base.reconnectExhaustedMessage },
  );
});

test('WS 空闲但未到预算上限：先拉信令，不销毁 peer', () => {
  assert.deepEqual(planSharerRecovery({ ...base, signalingState: 'idle' }), {
    kind: 'retry-signaling',
  });
});

test('还在连接中：等待，不做任何动作', () => {
  assert.deepEqual(planSharerRecovery({ ...base, signalingState: 'connecting' }), { kind: 'wait' });
  assert.deepEqual(planSharerRecovery({ ...base, signalingState: 'connected' }), { kind: 'wait' });
});

test('首连看门狗：未到超时不判超时', () => {
  assert.equal(
    planSharerFirstConnectWatchdog({
      isSharing: true,
      isPeerReady: false,
      elapsedMs: 19_999,
      timeoutMs: 20_000,
    }),
    'wait',
  );
});

test('首连看门狗：到点判超时，交给恢复流程落终态', () => {
  assert.equal(
    planSharerFirstConnectWatchdog({
      isSharing: true,
      isPeerReady: false,
      elapsedMs: 20_000,
      timeoutMs: 20_000,
    }),
    'timeout',
  );
});

test('已就绪或已停止分享时看门狗不判超时', () => {
  assert.equal(
    planSharerFirstConnectWatchdog({
      isSharing: true,
      isPeerReady: true,
      elapsedMs: 60_000,
      timeoutMs: 20_000,
    }),
    'wait',
  );
  assert.equal(
    planSharerFirstConnectWatchdog({
      isSharing: false,
      isPeerReady: false,
      elapsedMs: 60_000,
      timeoutMs: 20_000,
    }),
    'wait',
  );
});
