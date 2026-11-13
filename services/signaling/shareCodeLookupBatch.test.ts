import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShareCodeLookupBatcher,
  type ShareCodeLookupRequest,
} from './shareCodeLookupBatch.ts';
import type { ShareCodeRecord } from '../shareCodeRegistry';

const makeRecord = (code: string): ShareCodeRecord => ({
  code,
  peerId: `peer-${code}`,
  secretHash: 'a'.repeat(64),
  expiresAt: 1_000,
});

const createHarness = (maxBatchSize?: number) => {
  const scheduled: (() => void)[] = [];
  const calls: ShareCodeLookupRequest[][] = [];
  const batcher = createShareCodeLookupBatcher({
    defer: (flush) => scheduled.push(flush),
    maxBatchSize,
    run: async (requests) => {
      calls.push([...requests]);
      return requests.map((request) => makeRecord(`${request.kind}:${request.value}`));
    },
  });
  const flushNext = () => {
    const next = scheduled.shift();
    assert.ok(next, 'expected a scheduled flush');
    next();
  };
  return { batcher, calls, scheduled, flushNext };
};

test('同一窗口内的并发查询合并成一次批量请求，结果按调用顺序返回', async () => {
  const { batcher, calls, flushNext } = createHarness();
  const first = batcher.request({ kind: 'code', value: 'ABC123' });
  const second = batcher.request({ kind: 'peerId', value: 'peer-1' });
  assert.equal(batcher.pendingCount(), 2);
  assert.equal(calls.length, 0, 'flush 之前不应该发出请求');

  flushNext();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { kind: 'code', value: 'ABC123' },
    { kind: 'peerId', value: 'peer-1' },
  ]);
  assert.equal(a?.code, 'code:ABC123');
  assert.equal(b?.code, 'peerId:peer-1');
  assert.equal(batcher.pendingCount(), 0);
});

test('达到批量上限时立即发出，不等 defer 回调', async () => {
  const { batcher, calls, scheduled } = createHarness(2);
  const results = [
    batcher.request({ kind: 'code', value: 'A1' }),
    batcher.request({ kind: 'code', value: 'A2' }),
    batcher.request({ kind: 'code', value: 'A3' }),
  ];
  assert.equal(calls.length, 1, '第二个请求到齐时就应该 flush');
  assert.equal(batcher.pendingCount(), 1, '第三个请求留在下一批');

  const records = await Promise.all(results.slice(0, 2));
  assert.deepEqual(records.map((record) => record?.code), ['code:A1', 'code:A2']);

  // 提前 flush 之后，之前排队的那次 defer 必须失效：醒来只能发第三批，
  // 不能把已经发过的批次再发一次，也不能把第三批提前合并进去。
  const queued = scheduled.splice(0);
  queued.forEach((flush) => flush());
  assert.equal(calls.length, 2);
  const [third] = await Promise.all([results[2]]);
  assert.equal(third?.code, 'code:A3');
  assert.equal(batcher.pendingCount(), 0);
});

test('批量请求失败时每个等待者都拿到错误，不静默返回 null', async () => {
  const scheduled: (() => void)[] = [];
  const batcher = createShareCodeLookupBatcher({
    defer: (flush) => scheduled.push(flush),
    run: async () => {
      throw new Error('boom');
    },
  });
  const first = batcher.request({ kind: 'code', value: 'X' });
  const second = batcher.request({ kind: 'code', value: 'Y' });
  scheduled.shift()?.();
  await assert.rejects(first, /boom/);
  await assert.rejects(second, /boom/);
});

test('返回条数与请求数不符时按协议错误拒绝，避免结果错位', async () => {
  const scheduled: (() => void)[] = [];
  const batcher = createShareCodeLookupBatcher({
    defer: (flush) => scheduled.push(flush),
    run: async () => [] as (ShareCodeRecord | null)[],
  });
  const pendingResult = batcher.request({ kind: 'code', value: 'Z' });
  scheduled.shift()?.();
  await assert.rejects(pendingResult, /returned 0 records for 1 requests/);
});

test('flush 之后的新查询开启新批次', async () => {
  const { batcher, calls, flushNext } = createHarness();
  const first = batcher.request({ kind: 'code', value: 'A' });
  flushNext();
  await first;

  const second = batcher.request({ kind: 'code', value: 'B' });
  flushNext();
  await second;

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [{ kind: 'code', value: 'B' }]);
});
