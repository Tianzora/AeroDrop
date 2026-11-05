import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32FinalHex, crc32Init, crc32Update } from '../hashUtils.ts';
import { computePrefixCrc32 } from './prefixCrc.ts';

const bytesOf = (length: number, seed = 7) => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * seed + 11) % 251;
  }
  return bytes;
};

const fakeFile = (bytes: Uint8Array) => ({
  size: bytes.byteLength,
  slice: (start: number, end: number) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }),
});

const expectedCrc = (bytes: Uint8Array) => crc32FinalHex(crc32Update(crc32Init(), bytes));

test('computes the CRC of the persisted prefix only', async () => {
  const bytes = bytesOf(4096);
  const file = fakeFile(bytes);

  assert.equal(await computePrefixCrc32(file, 1024, 256), expectedCrc(bytes.slice(0, 1024)));
  assert.equal(await computePrefixCrc32(file, 4096, 1024), expectedCrc(bytes));
});

test('clamps the prefix length to the file size and handles empty prefixes', async () => {
  const bytes = bytesOf(512);
  const file = fakeFile(bytes);

  assert.equal(await computePrefixCrc32(file, 10_000), expectedCrc(bytes));
  assert.equal(await computePrefixCrc32(file, 0), expectedCrc(new Uint8Array(0)));
});
