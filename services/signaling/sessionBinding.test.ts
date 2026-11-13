import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_SECRET_BYTES,
  createSessionSecretHash,
  isValidSessionSecretHash,
  shouldAcceptSessionReplacement,
} from './sessionBinding.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('only accepts a 64-character hex digest', () => {
  assert.equal(isValidSessionSecretHash(HASH_A), true);
  assert.equal(isValidSessionSecretHash('A'.repeat(64)), true);
  // 长度、字符集、空白都不能放过：格式错等于「凭证不存在」。
  assert.equal(isValidSessionSecretHash(HASH_A.slice(1)), false);
  assert.equal(isValidSessionSecretHash(`${HASH_A}a`), false);
  assert.equal(isValidSessionSecretHash('g'.repeat(64)), false);
  assert.equal(isValidSessionSecretHash(`${HASH_A} `), false);
  assert.equal(isValidSessionSecretHash(undefined), false);
  assert.equal(isValidSessionSecretHash(null), false);
  assert.equal(isValidSessionSecretHash(42), false);
});

test('unbound sessions keep the historical takeover behaviour', () => {
  // 文件传输与旧版本客户端不带摘要：仍允许接管，否则重连会卡在 unavailable-id。
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: null, incomingSecretHash: null }),
    'allow'
  );
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: undefined, incomingSecretHash: HASH_A }),
    'allow'
  );
});

test('replacement needs the same secret as the existing session', () => {
  // 同一份密钥的重连/重建（大小写不同也还是同一份）。
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: HASH_A }),
    'allow'
  );
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: HASH_A.toUpperCase() }),
    'allow'
  );
  // 知道 peerId 但拿不到密钥的人（或旧标签页换了新密钥）只能被拒。
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: HASH_B }),
    'reject'
  );
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: null }),
    'reject'
  );
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: undefined }),
    'reject'
  );
  // 记录本身损坏时也不能放行：宁可拒绝，也不要退化成「谁都能接管」。
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: 'not-a-hash', incomingSecretHash: 'not-a-hash' }),
    'reject'
  );
  assert.equal(
    shouldAcceptSessionReplacement({ existingSecretHash: HASH_A, incomingSecretHash: HASH_A.slice(1) }),
    'reject'
  );
});

test('createSessionSecretHash returns a fresh lowercase sha256 digest', async () => {
  const first = await createSessionSecretHash();
  const second = await createSessionSecretHash();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(isValidSessionSecretHash(first), true);
  assert.notEqual(first, second);
  // 摘要长度由 SHA-256 决定，和随机字节数解耦；改字节数不该悄悄改变格式。
  assert.equal(SESSION_SECRET_BYTES * 8, 256);
});
