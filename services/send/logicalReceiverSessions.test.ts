import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisiblePeerIds, isSupersededPeerId } from './logicalReceiverSessions.ts';

test('isSupersededPeerId：peer 没有会话时不判为过期', () => {
  assert.equal(isSupersededPeerId('peer-a', new Map(), new Map()), false);
});

test('isSupersededPeerId：会话已归属另一个 peer 时判为过期', () => {
  const peerSessionIds = new Map([['peer-a', 'session-1']]);
  const sessionToPeer = new Map([['session-1', 'peer-b']]);
  assert.equal(isSupersededPeerId('peer-a', peerSessionIds, sessionToPeer), true);
});

test('isSupersededPeerId：会话仍归属自己时不算过期', () => {
  const peerSessionIds = new Map([['peer-a', 'session-1']]);
  const sessionToPeer = new Map([['session-1', 'peer-a']]);
  assert.equal(isSupersededPeerId('peer-a', peerSessionIds, sessionToPeer), false);
});

test('getVisiblePeerIds：过滤掉被顶替的 peer，保持原顺序', () => {
  const peerSessionIds = new Map([
    ['peer-a', 'session-1'],
    ['peer-b', 'session-2'],
    ['peer-c', 'session-3'],
  ]);
  const sessionToPeer = new Map([
    ['session-1', 'peer-b'],
    ['session-2', 'peer-b'],
    ['session-3', 'peer-c'],
  ]);

  assert.deepEqual(getVisiblePeerIds(['peer-a', 'peer-b', 'peer-c'], peerSessionIds, sessionToPeer), [
    'peer-b',
    'peer-c',
  ]);
});
