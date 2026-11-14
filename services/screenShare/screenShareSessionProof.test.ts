import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forgetScreenShareSessionProof,
  rememberScreenShareSessionProof,
  resolveScreenSharePeerCredentials,
} from './screenShareSessionProof.ts';
import type { ProofStorage } from './sessionProofStore.ts';

const ROOM = {
  peerId: 'AERO-000000000000000001',
  code: '123456',
  secret: 'room-secret',
  secretHash: 'a'.repeat(64),
};

const createStorage = (): ProofStorage & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
};

test('重建凭证走同一入口：拿到 proof 后只出示 proof，不再带静态摘要', () => {
  const storage = createStorage();
  rememberScreenShareSessionProof(ROOM, 'proof-2', storage);

  const credentials = resolveScreenSharePeerCredentials(ROOM, storage);

  assert.equal(credentials.sessionProof, 'proof-2');
  assert.equal(
    'sessionSecretHash' in credentials,
    false,
    '重建还带摘要说明组件没接回 proof：过了静态摘要宽限期就是必然 4010'
  );
  assert.equal(credentials.signalingCode, ROOM.code);
  assert.equal(credentials.signalingToken, ROOM.secret);
});

test('还没收到过 proof 时退回首连的静态摘要，不是直接不给凭证', () => {
  const credentials = resolveScreenSharePeerCredentials(ROOM, createStorage());

  assert.equal(credentials.sessionSecretHash, ROOM.secretHash);
  assert.equal('sessionProof' in credentials, false);
});

test('storage 抛错/不可用时重建不能失败：退化成一旧行为而不是把共享打断', () => {
  const throwing: ProofStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };

  assert.doesNotThrow(() => rememberScreenShareSessionProof(ROOM, 'proof-3', throwing));
  const credentials = resolveScreenSharePeerCredentials(ROOM, throwing);
  assert.equal(credentials.sessionSecretHash, ROOM.secretHash);

  assert.doesNotThrow(() => resolveScreenSharePeerCredentials(ROOM, null));
  assert.doesNotThrow(() => forgetScreenShareSessionProof(ROOM, null));
  assert.doesNotThrow(() => forgetScreenShareSessionProof(ROOM, throwing));
});

test('终态清理之后重建拿不到 proof：撤销的房号不该留着一份还能用的凭证', () => {
  const storage = createStorage();
  rememberScreenShareSessionProof(ROOM, 'proof-4', storage);

  forgetScreenShareSessionProof(ROOM, storage);

  const credentials = resolveScreenSharePeerCredentials(ROOM, storage);
  assert.equal(storage.entries.size, 0);
  assert.equal('sessionProof' in credentials, false);
  assert.equal(credentials.sessionSecretHash, ROOM.secretHash);
});

test('proof 按房号隔离：别的 peerId 的 proof 不会被新建的房号拿去用', () => {
  const storage = createStorage();
  rememberScreenShareSessionProof(ROOM, 'proof-5', storage);

  const otherRoom = { ...ROOM, peerId: 'AERO-000000000000000002' };
  const credentials = resolveScreenSharePeerCredentials(otherRoom, storage);

  assert.equal('sessionProof' in credentials, false);
  assert.equal(credentials.sessionSecretHash, otherRoom.secretHash);
});
