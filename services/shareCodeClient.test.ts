import test from 'node:test';
import assert from 'node:assert/strict';

import { computeShareCodeSecretHash } from './shareCodeRegistry.ts';
import {
  computeShareSecretHash,
  createShareSecret,
  lookupShareCode,
  registerShareCode,
  revokeShareCode,
} from './shareCodeClient.ts';

const PEER_ID = '6f1f0f4c-7b1a-4c5e-9f6a-2b3c4d5e6f70';
const SECRET_HASH = 'a'.repeat(64);

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const captureFetch = (factory: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return factory();
  }) as typeof fetch;
  return { impl, calls };
};

const readBody = (call: { init?: RequestInit }): Record<string, unknown> =>
  JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

test('posts a registration without a code and returns the issued one', async () => {
  const { impl, calls } = captureFetch(() => jsonResponse({ code: '654321', expiresAt: 1234 }));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'ok', code: '654321', expiresAt: 1234 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/share-code');
  assert.equal(calls[0].init?.method, 'POST');
  const body = readBody(calls[0]);
  assert.deepEqual(body, { peerId: PEER_ID, secretHash: SECRET_HASH });
});

test('forwards a requested custom code', async () => {
  const { impl, calls } = captureFetch(() => jsonResponse({ code: '123456', expiresAt: 99 }));

  const result = await registerShareCode(
    { peerId: PEER_ID, secretHash: SECRET_HASH, code: '123456' },
    { fetchImpl: impl, baseUrl: 'https://example.test/' }
  );

  assert.deepEqual(result, { status: 'ok', code: '123456', expiresAt: 99 });
  assert.equal(calls[0].url, 'https://example.test/api/share-code');
  assert.equal(readBody(calls[0]).code, '123456');
});

test('rejects a malformed local code without calling the API', async () => {
  const { impl, calls } = captureFetch(() => jsonResponse({}));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH, code: '12' }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'failed', error: 'code must be six digits' });
  assert.equal(calls.length, 0);
});

test('maps 409 to taken', async () => {
  const { impl } = captureFetch(() => jsonResponse({ error: 'code already in use' }, 409));

  const result = await registerShareCode(
    { peerId: PEER_ID, secretHash: SECRET_HASH, code: '123456' },
    { fetchImpl: impl }
  );

  assert.deepEqual(result, { status: 'taken' });
});

test('maps 429 to rate-limited and reads Retry-After', async () => {
  const { impl } = captureFetch(() => jsonResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '7' }));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'rate-limited', retryAfterMs: 7_000 });
});

test('falls back to a default retry delay when Retry-After is missing', async () => {
  const { impl } = captureFetch(() => jsonResponse({ error: 'Too Many Requests' }, 429));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'rate-limited', retryAfterMs: 10_000 });
});

test('surfaces validation errors from the API', async () => {
  const { impl } = captureFetch(() => jsonResponse({ error: 'code must be six digits' }, 400));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'failed', error: 'code must be six digits' });
});

test('treats a malformed success payload as failed', async () => {
  const { impl } = captureFetch(() => jsonResponse({ code: 'nope' }));

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'failed', error: 'Share code response is malformed' });
});

test('maps a network throw to failed', async () => {
  const { impl } = captureFetch(() => {
    throw new Error('network down');
  });

  const result = await registerShareCode({ peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'failed', error: 'network down' });
});

test('looks up and revokes share codes', async () => {
  const lookup = captureFetch(() => jsonResponse({ peerId: PEER_ID, expiresAt: 4321 }));
  assert.deepEqual(await lookupShareCode('123456', { fetchImpl: lookup.impl }), {
    status: 'ok',
    peerId: PEER_ID,
    expiresAt: 4321,
  });
  assert.equal(lookup.calls[0].url, '/api/share-code?code=123456');

  const missing = captureFetch(() => jsonResponse({ error: 'Share code not found or expired' }, 404));
  assert.deepEqual(await lookupShareCode('123456', { fetchImpl: missing.impl }), { status: 'not-found' });

  const limited = captureFetch(() => jsonResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '3' }));
  assert.deepEqual(await lookupShareCode('123456', { fetchImpl: limited.impl }), {
    status: 'rate-limited',
    retryAfterMs: 3_000,
  });

  const revoked = captureFetch(() => jsonResponse({ revoked: true, code: '123456' }));
  assert.deepEqual(
    await revokeShareCode({ code: '123456', peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: revoked.impl }),
    { status: 'ok', code: '123456' }
  );
  assert.equal(revoked.calls[0].url, '/api/share-code/123456/revoke');
  assert.equal(readBody(revoked.calls[0]).peerId, PEER_ID);
  assert.equal(readBody(revoked.calls[0]).secretHash, SECRET_HASH);

  const forbidden = captureFetch(() => jsonResponse({ error: 'forbidden' }, 403));
  assert.deepEqual(
    await revokeShareCode({ code: '123456', peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: forbidden.impl }),
    { status: 'forbidden' }
  );

  const notFound = captureFetch(() => jsonResponse({ error: 'Share code not found' }, 404));
  assert.deepEqual(
    await revokeShareCode({ code: '123456', peerId: PEER_ID, secretHash: SECRET_HASH }, { fetchImpl: notFound.impl }),
    { status: 'not-found' }
  );
});

test('generates a 32 byte hex secret bound to the peer id', async () => {
  const first = createShareSecret();
  const second = createShareSecret();

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);

  assert.equal(await computeShareSecretHash(first, PEER_ID), await computeShareCodeSecretHash(first, PEER_ID));
});

test('rejects a revoke without credentials before calling the API', async () => {
  const { impl, calls } = captureFetch(() => jsonResponse({}));

  const result = await revokeShareCode({ code: '123456', peerId: '', secretHash: '' }, { fetchImpl: impl });

  assert.deepEqual(result, { status: 'failed', error: 'peerId and secretHash are required' });
  assert.equal(calls.length, 0);
});
