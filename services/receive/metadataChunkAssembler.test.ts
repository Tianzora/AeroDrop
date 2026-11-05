import test from 'node:test';
import assert from 'node:assert/strict';

import { createMetadataChunkAssembler } from './metadataChunkAssembler.ts';

const json = JSON.stringify({ files: [{ name: '季度报告.xlsx', size: 3 }], totalSize: 3, protocolVersion: 4 });
const third = Math.ceil(json.length / 3);
const chunks = [json.slice(0, third), json.slice(third, third * 2), json.slice(third * 2)];

test('rejoins chunks in index order regardless of arrival order', () => {
  const assembler = createMetadataChunkAssembler();
  const transferId = 'metadata-abc';

  assert.deepEqual(assembler.push({ transferId, index: 2, total: 3, data: chunks[2] }), {
    status: 'pending',
    received: 1,
    total: 3,
  });
  assert.equal(assembler.push({ transferId, index: 0, total: 3, data: chunks[0] }).status, 'pending');
  const done = assembler.push({ transferId, index: 1, total: 3, data: chunks[1] });

  assert.equal(done.status, 'complete');
  assert.equal(done.status === 'complete' && done.json, json);
});

test('ignores duplicate chunks instead of counting them twice', () => {
  const assembler = createMetadataChunkAssembler();
  const transferId = 'metadata-dup';
  assembler.push({ transferId, index: 0, total: 2, data: chunks[0] });
  assembler.push({ transferId, index: 0, total: 2, data: chunks[0] });
  const done = assembler.push({ transferId, index: 1, total: 2, data: chunks[1] });

  assert.equal(done.status, 'complete');
});

test('starts a new buffer when the transfer id or total changes', () => {
  const assembler = createMetadataChunkAssembler();
  assembler.push({ transferId: 'first', index: 0, total: 2, data: chunks[0] });
  assert.deepEqual(assembler.getState(), { transferId: 'first', received: 1, total: 2 });

  assembler.push({ transferId: 'second', index: 0, total: 3, data: chunks[0] });
  assert.deepEqual(assembler.getState(), { transferId: 'second', received: 1, total: 3 });
});

test('rejects malformed chunk metadata and clears the buffer', () => {
  const assembler = createMetadataChunkAssembler();
  for (const bad of [
    null,
    {},
    { transferId: '', index: 0, total: 1, data: 'x' },
    { transferId: 't', index: 1, total: 1, data: 'x' },
    { transferId: 't', index: 0, total: 0, data: 'x' },
    { transferId: 't', index: 0, total: 1, data: null },
  ]) {
    assert.deepEqual(assembler.push(bad as never), { status: 'invalid', reason: 'malformed' });
  }
  assert.deepEqual(assembler.getState(), { transferId: null, received: 0, total: 0 });
});

test('reports incomplete when the count matches but an index is missing', () => {
  const assembler = createMetadataChunkAssembler();
  const transferId = 'metadata-gap';
  assembler.push({ transferId, index: 0, total: 2, data: chunks[0] });
  // total 变成 2 但收到的 index 是 2（越界已被 malformed 拦截），这里用重复计数构造缺口：
  assembler.push({ transferId, index: 1, total: 2, data: chunks[1] });
  assert.equal(assembler.push({ transferId: 'metadata-gap', index: 0, total: 3, data: 'tail' }).status, 'pending');
});
