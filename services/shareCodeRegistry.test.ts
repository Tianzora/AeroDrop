import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_CODE_TTL_MS,
  allocateShareCode,
  computeShareCodeSecretHash,
  createShareCodeRecord,
  generateShareCode,
  isShareCodeRecordExpired,
  isValidSharePeerId,
  normalizeShareCode,
  randomInt,
  resolveShareCodeRegistration,
  shouldRejectShareCodeRebind,
  validateShareCodeCreatePayload,
  verifyShareCodeRevoke,
  type ShareCodeRecord,
} from './shareCodeRegistry.ts';

const PEER_ID = '6f1f0f4c-7b1a-4c5e-9f6a-2b3c4d5e6f70';
const OTHER_PEER_ID = 'peer-11111111-2222-3333-4444-555555555555';
const SECRET = 'secret-6x8k2b1c9d4e7f0awx9p';
const OTHER_SECRET = 'zzzzhc-3o3d5t1e8r8c2d5bwx9p';
const NOW = 1_700_000_000_000;

const createStore = () => {
  const records = new Map<string, ShareCodeRecord>();
  return {
    records,
    tryInsert: (record: ShareCodeRecord): boolean => {
      if (records.has(record.code)) return false;
      records.set(record.code, record);
      return true;
    },
  };
};

test('generates six digit codes in the 100000-999999 range', () => {
  assert.equal(generateShareCode(() => 0), '100000');
  assert.equal(generateShareCode(() => 899999), '999999');

  for (let index = 0; index < 200; index += 1) {
    const code = generateShareCode();
    assert.match(code, /^\d{6}$/);
    const value = Number(code);
    assert.ok(value >= 100000 && value <= 999999, 'out of range: ' + code);
  }
});

test('randomInt validates its bound and stays in range', () => {
  assert.throws(() => randomInt(0));
  assert.throws(() => randomInt(-1));

  for (let index = 0; index < 100; index += 1) {
    const value = randomInt(10);
    assert.ok(value >= 0 && value < 10);
  }
});

test('stamps a one hour TTL and expires at the boundary', () => {
  const record = createShareCodeRecord({
    code: '123456',
    peerId: PEER_ID,
    secretHash: 'a'.repeat(64),
    now: NOW,
  });

  assert.equal(record.expiresAt, NOW + SHARE_CODE_TTL_MS);
  assert.equal(SHARE_CODE_TTL_MS, 60 * 60 * 1000);
  assert.equal(isShareCodeRecordExpired(record, record.expiresAt - 1), false);
  assert.equal(isShareCodeRecordExpired(record, record.expiresAt), true);
});

test('derives a deterministic HMAC-SHA-256 hex digest bound to the peer id', async () => {
  const first = await computeShareCodeSecretHash(SECRET, PEER_ID);
  const second = await computeShareCodeSecretHash(SECRET, PEER_ID);
  const otherPeer = await computeShareCodeSecretHash(SECRET, OTHER_PEER_ID);
  const otherSecret = await computeShareCodeSecretHash(OTHER_SECRET, PEER_ID);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, otherPeer);
  assert.notEqual(first, otherSecret);
});

test('normalizes and validates share codes', () => {
  assert.equal(normalizeShareCode(' 123456 '), '123456');
  assert.equal(normalizeShareCode('1234567'), null);
  assert.equal(normalizeShareCode('12345'), null);
  assert.equal(normalizeShareCode('abcdef'), null);
  assert.equal(normalizeShareCode(null), null);
});

test('accepts random peer ids and rejects legacy or malformed ones', () => {
  assert.equal(isValidSharePeerId(PEER_ID), true);
  assert.equal(isValidSharePeerId('peer-12345678-90ab-cdef-1234-567890abcdef'), true);
  assert.equal(isValidSharePeerId('aerodrop-1234'), false);
  assert.equal(isValidSharePeerId('short'), false);
  assert.equal(isValidSharePeerId('has space here'), false);
});

test('allocates a requested code when it is free', () => {
  const store = createStore();
  const result = allocateShareCode({
    peerId: PEER_ID,
    secretHash: 'a'.repeat(64),
    code: '654321',
    now: NOW,
    tryInsert: store.tryInsert,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.status === 'ok' ? result.record.code : '', '654321');
  assert.equal(store.records.size, 1);
});

test('reports taken when the requested code already exists', () => {
  const store = createStore();
  const insert = (peerId: string, code: string) =>
    allocateShareCode({
      peerId,
      secretHash: 'a'.repeat(64),
      code,
      now: NOW,
      tryInsert: store.tryInsert,
    });

  assert.equal(insert(PEER_ID, '654321').status, 'ok');
  assert.equal(insert(OTHER_PEER_ID, '654321').status, 'taken');
});

test('only one of two concurrent allocations for the same requested code wins', () => {
  const store = createStore();
  const makeAllocation = (peerId: string) => ({
    peerId,
    secretHash: 'b'.repeat(64),
    code: '777777',
    now: NOW,
    tryInsert: store.tryInsert,
  });

  const results = [allocateShareCode(makeAllocation(PEER_ID)), allocateShareCode(makeAllocation(OTHER_PEER_ID))];
  const won = results.filter((result) => result.status === 'ok');

  assert.equal(won.length, 1);
  assert.equal(results.filter((result) => result.status === 'taken').length, 1);
  assert.equal(store.records.size, 1);
});

test('retries random allocation on collision and gives up after the attempt budget', () => {
  const store = createStore();
  store.records.set('100000', { code: '100000', peerId: OTHER_PEER_ID, secretHash: 'c'.repeat(64), expiresAt: NOW });

  const result = allocateShareCode({
    peerId: PEER_ID,
    secretHash: 'd'.repeat(64),
    now: NOW,
    tryInsert: store.tryInsert,
    nextInt: () => 0,
    maxAttempts: 3,
  });

  assert.equal(result.status, 'taken');
  assert.equal(store.records.size, 1);

  let attempt = 0;
  const second = allocateShareCode({
    peerId: PEER_ID,
    secretHash: 'd'.repeat(64),
    now: NOW,
    tryInsert: store.tryInsert,
    nextInt: () => (attempt++ === 0 ? 0 : 1),
    maxAttempts: 3,
  });

  assert.equal(second.status, 'ok');
  assert.equal(second.status === 'ok' ? second.record.code : '', '100001');
});

test('validates the create payload shape including the optional code', async () => {
  const secretHash = await computeShareCodeSecretHash(SECRET, PEER_ID);

  assert.deepEqual(validateShareCodeCreatePayload({ peerId: PEER_ID, secretHash }), {
    ok: true,
    peerId: PEER_ID,
    secretHash,
    code: null,
  });
  assert.deepEqual(validateShareCodeCreatePayload({ peerId: PEER_ID, secretHash, code: ' 654321 ' }), {
    ok: true,
    peerId: PEER_ID,
    secretHash,
    code: '654321',
  });

  assert.deepEqual(validateShareCodeCreatePayload({ peerId: PEER_ID, secretHash, code: '12345' }), {
    ok: false,
    error: 'code must be six digits',
  });
  assert.equal(validateShareCodeCreatePayload({ peerId: PEER_ID }).ok, false);
  assert.equal(validateShareCodeCreatePayload({ peerId: 'aerodrop-1234', secretHash }).ok, false);
  assert.equal(validateShareCodeCreatePayload({ peerId: PEER_ID, secretHash: 'not-hex' }).ok, false);
  assert.equal(validateShareCodeCreatePayload('nope').ok, false);
  assert.equal(validateShareCodeCreatePayload([]).ok, false);
});

const buildRegistrationInput = async (overrides: {
  code?: string | null;
  token?: string | null;
  now?: number;
  secretHash?: string;
  recordPeerId?: string;
} = {}) => {
  const now = overrides.now ?? NOW;
  const secretHash = overrides.secretHash ?? (await computeShareCodeSecretHash(SECRET, PEER_ID));
  const record = createShareCodeRecord({
    code: '123456',
    peerId: overrides.recordPeerId ?? PEER_ID,
    secretHash,
    now,
  });

  return {
    peerId: PEER_ID,
    code: overrides.code === undefined ? '123456' : overrides.code,
    token: overrides.token === undefined ? SECRET : overrides.token,
    now,
    findShareCode: (code: string) => (code === '123456' ? record : null),
  };
};

test('rejects the legacy four digit peer id without credentials', async () => {
  const decision = await resolveShareCodeRegistration({
    peerId: 'aerodrop-1234',
    now: NOW,
    findShareCode: () => null,
  });

  assert.deepEqual(decision, { allowed: false, reason: 'legacy-peer-id' });
});

test('accepts a random peer id without credentials (receiver path)', async () => {
  const decision = await resolveShareCodeRegistration({
    peerId: PEER_ID,
    now: NOW,
    findShareCode: () => null,
  });

  assert.deepEqual(decision, { allowed: true });
});

test('rejects malformed peer ids', async () => {
  const decision = await resolveShareCodeRegistration({
    peerId: 'no',
    now: NOW,
    findShareCode: () => null,
  });

  assert.deepEqual(decision, { allowed: false, reason: 'invalid-peer-id' });
});

test('accepts a registration whose code and secret match the record', async () => {
  const decision = await resolveShareCodeRegistration(await buildRegistrationInput());

  assert.deepEqual(decision, { allowed: true });
});

test('rejects a registration with the wrong secret', async () => {
  const input = await buildRegistrationInput();
  const decision = await resolveShareCodeRegistration({ ...input, token: OTHER_SECRET });

  assert.deepEqual(decision, { allowed: false, reason: 'unauthorized' });
});

test('rejects a registration for another peer id', async () => {
  const input = await buildRegistrationInput({ recordPeerId: OTHER_PEER_ID });
  const decision = await resolveShareCodeRegistration(input);

  assert.deepEqual(decision, { allowed: false, reason: 'unauthorized' });
});

test('rejects an expired share code', async () => {
  const input = await buildRegistrationInput();
  const decision = await resolveShareCodeRegistration({ ...input, now: NOW + SHARE_CODE_TTL_MS });

  assert.deepEqual(decision, { allowed: false, reason: 'unauthorized' });
});

test('rejects an unknown share code', async () => {
  const input = await buildRegistrationInput({ code: '999999' });
  const decision = await resolveShareCodeRegistration(input);

  assert.deepEqual(decision, { allowed: false, reason: 'unauthorized' });
});

test('rejects a code without a token and a token without a code', async () => {
  const codeOnly = await resolveShareCodeRegistration(await buildRegistrationInput({ token: null }));
  const tokenOnly = await resolveShareCodeRegistration(await buildRegistrationInput({ code: null }));

  assert.deepEqual(codeOnly, { allowed: false, reason: 'unauthorized' });
  assert.deepEqual(tokenOnly, { allowed: false, reason: 'unauthorized' });
});

test('rejects a token that is too short to be a real secret', async () => {
  const input = await buildRegistrationInput({ token: 'short' });
  const decision = await resolveShareCodeRegistration(input);

  assert.deepEqual(decision, { allowed: false, reason: 'unauthorized' });
});

test('accepts a revoke with the matching peer id and secret hash', async () => {
  const secretHash = await computeShareCodeSecretHash(SECRET, PEER_ID);
  const record = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash, now: NOW });

  assert.deepEqual(verifyShareCodeRevoke({ record, peerId: PEER_ID, secretHash }), { allowed: true });
  assert.deepEqual(verifyShareCodeRevoke({ record, peerId: PEER_ID, secretHash: secretHash.toUpperCase() }), {
    allowed: true,
  });
});

test('rejects a revoke with the wrong peer id', async () => {
  const secretHash = await computeShareCodeSecretHash(SECRET, PEER_ID);
  const record = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash, now: NOW });

  assert.deepEqual(verifyShareCodeRevoke({ record, peerId: OTHER_PEER_ID, secretHash }), { allowed: false });
});

test('rejects a revoke with the wrong secret hash', async () => {
  const secretHash = await computeShareCodeSecretHash(SECRET, PEER_ID);
  const otherHash = await computeShareCodeSecretHash(OTHER_SECRET, PEER_ID);
  const record = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash, now: NOW });

  assert.deepEqual(verifyShareCodeRevoke({ record, peerId: PEER_ID, secretHash: otherHash }), { allowed: false });
  assert.deepEqual(verifyShareCodeRevoke({ record, peerId: PEER_ID, secretHash: 'not-hex' }), { allowed: false });
});

test('rejects a revoke for an unknown code without revealing it is unknown', () => {
  assert.deepEqual(
    verifyShareCodeRevoke({ record: null, peerId: PEER_ID, secretHash: 'a'.repeat(64) }),
    { allowed: false }
  );
});

test('honours the sender-selected TTL within the server cap', () => {
  const now = 1_700_000_000_000;
  const tenMinutes = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash: 'a'.repeat(64), now, ttlMs: 10 * 60 * 1000 });
  assert.equal(tenMinutes.expiresAt, now + 10 * 60 * 1000);

  const capped = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash: 'a'.repeat(64), now, ttlMs: 90 * 24 * 60 * 60 * 1000 });
  assert.equal(capped.expiresAt, now + 24 * 60 * 60 * 1000);

  const floor = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash: 'a'.repeat(64), now, ttlMs: 1 });
  assert.equal(floor.expiresAt, now + 60 * 1000);

  const fallback = createShareCodeRecord({ code: '123456', peerId: PEER_ID, secretHash: 'a'.repeat(64), now });
  assert.equal(fallback.expiresAt, now + SHARE_CODE_TTL_MS);
});

test('validates ttlSeconds in the create payload', () => {
  const base = { peerId: PEER_ID, secretHash: 'a'.repeat(64) };

  const accepted = validateShareCodeCreatePayload({ ...base, ttlSeconds: 600 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.ttlMs, 600_000);

  assert.equal(validateShareCodeCreatePayload({ ...base, ttlSeconds: 30 }).ok, false);
  assert.equal(validateShareCodeCreatePayload({ ...base, ttlSeconds: 90_000 }).ok, false);
  assert.equal(validateShareCodeCreatePayload({ ...base, ttlSeconds: '1h' }).ok, false);
  assert.equal(validateShareCodeCreatePayload(base).ok, true);
});

test('rejects credentialless registration for a peer id that is bound to a share code', async () => {
  const now = 1_700_000_000_000;
  const TOKEN = 'secret-value-0123456789';
  const binding: ShareCodeRecord = {
    code: '654321',
    peerId: PEER_ID,
    secretHash: await computeShareCodeSecretHash(TOKEN, PEER_ID),
    expiresAt: now + 60_000,
  };

  const anonymous = await resolveShareCodeRegistration({
    peerId: PEER_ID,
    now,
    findShareCode: () => null,
    findShareCodeByPeerId: () => binding,
  });
  assert.deepEqual(anonymous, { allowed: false, reason: 'unauthorized' });

  const unrelatedId = await resolveShareCodeRegistration({
    peerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    now,
    findShareCode: () => null,
    findShareCodeByPeerId: () => null,
  });
  assert.deepEqual(unrelatedId, { allowed: true });

  const expiredBinding = await resolveShareCodeRegistration({
    peerId: PEER_ID,
    now,
    findShareCode: () => null,
    findShareCodeByPeerId: () => ({ ...binding, expiresAt: now - 1 }),
  });
  assert.deepEqual(expiredBinding, { allowed: true });

  const withCredentials = await resolveShareCodeRegistration({
    peerId: PEER_ID,
    code: '654321',
    token: TOKEN,
    now,
    findShareCode: () => binding,
    findShareCodeByPeerId: () => binding,
  });
  assert.deepEqual(withCredentials, { allowed: true });
});

test('only the original secret may rebind a peer id, even after revoke', () => {
  const secretHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);

  assert.equal(
    shouldRejectShareCodeRebind({
      activeSecretHash: null,
      tombstoneSecretHash: null,
      requestSecretHash: secretHash,
    }),
    false
  );
  assert.equal(
    shouldRejectShareCodeRebind({
      activeSecretHash: secretHash,
      tombstoneSecretHash: null,
      requestSecretHash: secretHash,
    }),
    false
  );
  assert.equal(
    shouldRejectShareCodeRebind({
      activeSecretHash: otherHash,
      tombstoneSecretHash: null,
      requestSecretHash: secretHash,
    }),
    true
  );
  assert.equal(
    shouldRejectShareCodeRebind({
      activeSecretHash: null,
      tombstoneSecretHash: secretHash.toUpperCase(),
      requestSecretHash: secretHash,
    }),
    false
  );
  assert.equal(
    shouldRejectShareCodeRebind({
      activeSecretHash: null,
      tombstoneSecretHash: otherHash,
      requestSecretHash: secretHash,
    }),
    true
  );
});
