import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_PROOF_GRACE_MS,
  SESSION_PROOF_HISTORY_LIMIT,
  SESSION_SECRET_BYTES,
  buildNextSessionProofHistory,
  createSessionProof,
  createSessionSecretHash,
  hashSessionProof,
  isValidSessionProof,
  isValidSessionSecretHash,
  shouldAcceptSessionAdmission,
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

test('session proofs are 64 hex chars and rotate per issue', () => {
  const first = createSessionProof();
  const second = createSessionProof();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(isValidSessionProof(first), true);
  assert.notEqual(first, second);
  // 与分享密钥摘要同格式，但语义不同：proof 是 bearer，绝不等于密钥摘要。
  assert.equal(isValidSessionProof(HASH_A), true);
  assert.equal(isValidSessionProof(`${HASH_A} `), false);
  assert.equal(isValidSessionProof(undefined), false);
});

test('hashSessionProof is deterministic and hides the proof', async () => {
  const proof = createSessionProof();
  const hash = await hashSessionProof(proof);

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await hashSessionProof(proof), hash);
  assert.notEqual(hash, proof);
  assert.notEqual(await hashSessionProof(createSessionProof()), hash);
});

test('未轮换过的会话仍然按分享密钥摘要判定', () => {
  const unbound = {
    storedProofHash: null,
    incomingProofHash: null,
    now: 1_000,
  } as const;
  // 文件传输 / 旧版本客户端：没有绑定，保持历史放行。
  assert.equal(shouldAcceptSessionAdmission({ ...unbound }), 'allow');
  assert.equal(
    shouldAcceptSessionAdmission({ ...unbound, boundSecretHash: HASH_A, incomingSecretHash: HASH_A }),
    'allow'
  );
  assert.equal(
    shouldAcceptSessionAdmission({ ...unbound, boundSecretHash: HASH_A, incomingSecretHash: HASH_B }),
    'reject'
  );
  assert.equal(
    shouldAcceptSessionAdmission({ ...unbound, boundSecretHash: HASH_A, incomingSecretHash: undefined }),
    'reject'
  );
});

test('绑定过 proof 的会话只认 proof，不再回落到静态摘要', () => {
  const storedProofHash = 'c'.repeat(64);
  const base = {
    boundSecretHash: HASH_A,
    storedProofHash,
    incomingSecretHash: HASH_A,
    now: 1_000,
  } as const;

  // 即便拿着首次注册用的静态 bearer，也不能再接管：否则轮换没有意义。
  assert.equal(shouldAcceptSessionAdmission({ ...base }), 'reject');
  assert.equal(
    shouldAcceptSessionAdmission({ ...base, incomingProofHash: storedProofHash.toUpperCase() }),
    'allow'
  );
  assert.equal(
    shouldAcceptSessionAdmission({ ...base, incomingProofHash: 'd'.repeat(64) }),
    'reject'
  );
  assert.equal(shouldAcceptSessionAdmission({ ...base, incomingProofHash: undefined }), 'reject');
  // 损坏的绑定记录 fail-closed，绝不能退化成「谁都能接管」。
  assert.equal(
    shouldAcceptSessionAdmission({
      ...base,
      storedProofHash: 'not-a-proof',
      incomingProofHash: 'not-a-proof',
    }),
    'reject'
  );
});

test('轮换宽限期内的旧 proof 仍可重连，过期后失效', () => {
  const storedProofHash = 'c'.repeat(64);
  const previousProofHash = 'e'.repeat(64);
  const now = 10_000;
  const input = {
    boundSecretHash: HASH_A,
    storedProofHash,
    recentProofHashes: [{ proofHash: previousProofHash, expiresAt: now + SESSION_PROOF_GRACE_MS }],
    incomingProofHash: previousProofHash,
    now,
  } as const;

  assert.equal(shouldAcceptSessionAdmission({ ...input }), 'allow');
  // 恰好过期：不再放行（用 <= now 判定过期，边界上按拒绝处理）。
  assert.equal(
    shouldAcceptSessionAdmission({
      ...input,
      recentProofHashes: [{ proofHash: previousProofHash, expiresAt: now }],
    }),
    'reject'
  );
  // 历史条目缺失、损坏或时间非法：当作没有旧凭证。
  assert.equal(shouldAcceptSessionAdmission({ ...input, recentProofHashes: undefined }), 'reject');
  assert.equal(
    shouldAcceptSessionAdmission({ ...input, recentProofHashes: [{ proofHash: 'bad', expiresAt: now + 1 }] }),
    'reject'
  );
  assert.equal(
    shouldAcceptSessionAdmission({
      ...input,
      recentProofHashes: [{ proofHash: previousProofHash, expiresAt: Number.NaN }],
    }),
    'reject'
  );
  // 当前与历史都不匹配时不放行。
  assert.equal(
    shouldAcceptSessionAdmission({ ...input, incomingProofHash: 'f'.repeat(64) }),
    'reject'
  );
});

test('轮换历史保留当前摘要、丢弃过期项并限制条数', () => {
  const now = 5_000;
  const current = 'c'.repeat(64);
  const history = [
    { proofHash: 'a'.repeat(64), expiresAt: now - 1 }, // 已过期
    { proofHash: 'b'.repeat(64), expiresAt: now + 1_000 },
    { proofHash: 'bad', expiresAt: now + 1_000 }, // 损坏
  ];

  const next = buildNextSessionProofHistory({
    storedProofHash: current,
    recentProofHashes: history,
    now,
  });
  assert.deepEqual(next, [
    { proofHash: 'b'.repeat(64), expiresAt: now + 1_000 },
    { proofHash: current, expiresAt: now + SESSION_PROOF_GRACE_MS },
  ]);

  // 条数上限：连续轮换不会让记录无限增长。
  const many = Array.from({ length: SESSION_PROOF_HISTORY_LIMIT + 3 }, (_, index) => ({
    proofHash: `${index}`.repeat(64).slice(0, 64),
    expiresAt: now + 10_000,
  }));
  const capped = buildNextSessionProofHistory({
    storedProofHash: current,
    recentProofHashes: many,
    now,
  });
  assert.equal(capped.length, SESSION_PROOF_HISTORY_LIMIT);
  // 当前摘要一定在列表里（最坏情况下丢掉一条更老的）。
  assert.equal(capped.some((entry) => entry.proofHash === current), true);
  // 首次绑定没有历史：只记录当前摘要。
  assert.deepEqual(buildNextSessionProofHistory({ storedProofHash: null, now }), []);
});
