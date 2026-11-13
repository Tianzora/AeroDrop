import test from 'node:test';
import assert from 'node:assert/strict';

import { createScreenSharePeerCredentials } from './screenSharePeerCredentials.ts';

const ROOM = { code: '123456', secret: 'room-secret', secretHash: 'a'.repeat(64) };

test('拿到 proof 之后重建只出示 proof：过了静态摘要宽限期，摘要不再被接受', () => {
  const credentials = createScreenSharePeerCredentials(ROOM, 'proof-2');

  assert.equal(credentials.sessionProof, 'proof-2');
  assert.equal(
    'sessionSecretHash' in credentials,
    false,
    '重建时同时带摘要会让服务端继续看到长期 bearer，且掩盖「忘了传 proof」的回归'
  );
  assert.equal(credentials.signalingCode, ROOM.code);
  assert.equal(credentials.signalingToken, ROOM.secret);
});

test('首次连接还没有 proof：照旧用登记的静态摘要', () => {
  const credentials = createScreenSharePeerCredentials(ROOM, null);

  assert.equal(credentials.sessionSecretHash, ROOM.secretHash);
  assert.equal('sessionProof' in credentials, false);
});

test('空串按「没有 proof」处理：不要把空值塞进 WS URL', () => {
  const credentials = createScreenSharePeerCredentials(ROOM, '');

  assert.equal(credentials.sessionSecretHash, ROOM.secretHash);
  assert.equal('sessionProof' in credentials, false);
});
