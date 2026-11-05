import test from 'node:test';
import assert from 'node:assert/strict';

import { countVerifiedCompletedFiles } from './verifyCompletedFiles.ts';

const files = [
  { name: 'part-1.bin', size: 100 },
  { name: 'part-2.bin', size: 200 },
  { name: 'folder/part-3.bin', size: 300 },
];

test('counts the contiguous prefix that really exists in the destination', async () => {
  const present = new Set(['part-1.bin', 'part-2.bin', 'folder/part-3.bin']);
  const verified = await countVerifiedCompletedFiles({
    checkpointFileIndex: 3,
    files,
    fileExists: async (path) => present.has(path),
  });

  assert.equal(verified, 3);
});

test('stops at the first missing or truncated file', async () => {
  const exists = async (path: string, size: number) => path === 'part-2.bin' && size >= 200;
  assert.equal(await countVerifiedCompletedFiles({ checkpointFileIndex: 3, files, fileExists: exists }), 0);

  const existsPartial = async (path: string) => path !== 'part-2.bin';
  assert.equal(
    await countVerifiedCompletedFiles({ checkpointFileIndex: 3, files, fileExists: existsPartial }),
    1,
  );

  const truncated = async (path: string, size: number) => path !== 'part-2.bin' || size >= 200;
  assert.equal(
    await countVerifiedCompletedFiles({ checkpointFileIndex: 2, files, fileExists: truncated }),
    2,
  );
});

test('treats throwing lookups as missing and ignores out-of-range indexes', async () => {
  const throwing = async (path: string) => {
    if (path === 'part-2.bin') throw new Error('not found');
    return true;
  };
  assert.equal(await countVerifiedCompletedFiles({ checkpointFileIndex: 3, files, fileExists: throwing }), 1);

  let calls = 0;
  const counting = async () => {
    calls += 1;
    return true;
  };
  assert.equal(await countVerifiedCompletedFiles({ checkpointFileIndex: 0, files, fileExists: counting }), 0);
  assert.equal(await countVerifiedCompletedFiles({ checkpointFileIndex: -5, files, fileExists: counting }), 0);
  assert.equal(await countVerifiedCompletedFiles({ checkpointFileIndex: 99, files, fileExists: counting }), 3);
  // 只有 checkpointFileIndex=99 那次会逐个探查（被 files.length 截断成 3 次）。
  assert.equal(calls, 3);
});
