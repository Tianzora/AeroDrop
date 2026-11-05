import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32FinalHex, crc32Init, crc32Update } from '../hashUtils.ts';
import { verifyPersistedPrefix } from './prefixIntegrity.ts';

const bytesOf = (length: number) => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 13 + 5) % 251;
  }
  return bytes;
};

const crcOf = (bytes: Uint8Array) => crc32FinalHex(crc32Update(crc32Init(), bytes));

const readerFor = (bytes: Uint8Array) => async (offset: number, end: number) =>
  bytes.slice(offset, end);

test('matches when the on-disk prefix has the expected CRC', async () => {
  const bytes = bytesOf(4096);
  const verdict = await verifyPersistedPrefix({
    prefixLength: 4096,
    expectedCrc32: crcOf(bytes),
    readRange: readerFor(bytes),
    chunkSize: 1000,
  });

  assert.equal(verdict, 'match');
});

test('reports mismatch for corrupted or truncated data and unreadable when the reader fails', async () => {
  const bytes = bytesOf(2048);
  const corrupted = bytes.slice();
  corrupted[100] ^= 0xff;

  assert.equal(
    await verifyPersistedPrefix({ prefixLength: 2048, expectedCrc32: crcOf(bytes), readRange: readerFor(corrupted) }),
    'mismatch'
  );
  assert.equal(
    await verifyPersistedPrefix({ prefixLength: 2048, expectedCrc32: crcOf(bytes), readRange: readerFor(bytes.slice(0, 1024)) }),
    'mismatch'
  );
  assert.equal(
    await verifyPersistedPrefix({ prefixLength: 2048, expectedCrc32: crcOf(bytes), readRange: async () => null }),
    'unreadable'
  );
});

test('skips when there is nothing to verify or the prefix is too large', async () => {
  const bytes = bytesOf(64);

  assert.equal(
    await verifyPersistedPrefix({ prefixLength: 0, expectedCrc32: crcOf(bytes), readRange: readerFor(bytes) }),
    'skipped'
  );
  assert.equal(
    await verifyPersistedPrefix({
      prefixLength: 2048,
      expectedCrc32: crcOf(bytes),
      readRange: readerFor(bytes),
      maxVerifyBytes: 1024,
    }),
    'skipped'
  );
  assert.equal(
    await verifyPersistedPrefix({ prefixLength: 64, expectedCrc32: 'not-a-crc', readRange: readerFor(bytes) }),
    'skipped'
  );
});
