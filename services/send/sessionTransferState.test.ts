import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureLogicalReceiverState,
  restoreLogicalReceiverState,
  type LogicalReceiverState,
} from './sessionTransferState.ts';

const createStateMaps = () => ({
  peerProgress: new Map<string, number>(),
  peerRealtimeSpeed: new Map<string, number>(),
  peerAverageSpeed: new Map<string, number>(),
  peerTransferredBytes: new Map<string, number>(),
  peerTotalBytes: new Map<string, number>(),
  peerSyncStartAt: new Map<string, number>(),
  peerSyncBaseBytes: new Map<string, number>(),
  peerTransferEpoch: new Map<string, number>(),
  peerConnectionType: new Map<string, never>(),
  peerIsLAN: new Map<string, boolean>(),
  peerNames: {} as Record<string, string>,
  peerHasProgressSync: new Set<string>(),
  peerAwaitingFinalizeAck: new Set<string>(),
  pendingSendPeers: new Set<string>(),
  activeSendingPeers: new Set<string>(),
});

test('captureLogicalReceiverState：没有任何字段时不返回快照', () => {
  const state = createStateMaps();
  assert.equal(captureLogicalReceiverState('peer-a', state as never), null);
});

test('captureLogicalReceiverState：只采集目标 peer 的字段', () => {
  const state = createStateMaps();
  state.peerProgress.set('peer-a', 42);
  state.peerTotalBytes.set('peer-a', 100);
  state.peerProgress.set('peer-b', 7);

  const snapshot = captureLogicalReceiverState('peer-a', state as never);

  assert.ok(snapshot);
  assert.equal(snapshot.peerProgress, 42);
  assert.equal(snapshot.peerTotalBytes, 100);
  assert.equal(snapshot.peerRealtimeSpeed, undefined);
});

test('restoreLogicalReceiverState：往返之后数值与集合标记都回到新 peer 名下', () => {
  const source = createStateMaps();
  source.peerProgress.set('peer-a', 42);
  source.peerTransferEpoch.set('peer-a', 3);
  source.peerNames['peer-a'] = '笔记本';
  source.peerHasProgressSync.add('peer-a');
  source.pendingSendPeers.add('peer-a');

  const snapshot = captureLogicalReceiverState('peer-a', source as never) as LogicalReceiverState;
  const target = createStateMaps();
  restoreLogicalReceiverState(snapshot, 'peer-copy', target as never);

  assert.equal(target.peerProgress.get('peer-copy'), 42);
  assert.equal(target.peerTransferEpoch.get('peer-copy'), 3);
  assert.equal(target.peerNames['peer-copy'], '笔记本');
  assert.equal(target.peerHasProgressSync.has('peer-copy'), true);
  assert.equal(target.pendingSendPeers.has('peer-copy'), true);
  assert.equal(target.activeSendingPeers.has('peer-copy'), false, '快照里为 false 的标记不该被写入');
});

test('restoreLogicalReceiverState：undefined 字段不覆盖目标已有值', () => {
  const target = createStateMaps();
  target.peerProgress.set('peer-a', 99);

  restoreLogicalReceiverState(
    {
      hasProgressSync: false,
      awaitingFinalizeAck: false,
      pendingSend: false,
      activeSending: false,
    } as LogicalReceiverState,
    'peer-a',
    target as never
  );

  assert.equal(target.peerProgress.get('peer-a'), 99);
});
