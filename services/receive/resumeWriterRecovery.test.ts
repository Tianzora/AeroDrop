import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverWriterForResume, type ResumeWriterRecoveryDeps } from './resumeWriterRecovery.ts';
import type { ResumeCheckpoint } from './resumeCheckpoint.ts';

const createCheckpoint = (overrides: Partial<ResumeCheckpoint> = {}): ResumeCheckpoint => ({
  sessionId: 'session-1',
  metadataFingerprint: 'fingerprint',
  fileIndex: 0,
  committedBytes: 0,
  totalSize: 8192,
  updatedAt: 1_000,
  ...overrides,
});

interface Harness {
  deps: ResumeWriterRecoveryDeps;
  reopenCalls: Array<{ fileIndex: number; byteOffset: number }>;
  reselectCalls: Array<{ fileIndex: number; byteOffset: number; fileSize?: number }>;
  flushCalls: number;
}

const createHarness = (
  overrides: Partial<ResumeWriterRecoveryDeps> = {},
  behavior: { reopen?: boolean; reselect?: boolean } = {}
): Harness => {
  const reopenCalls: Array<{ fileIndex: number; byteOffset: number }> = [];
  const reselectCalls: Array<{ fileIndex: number; byteOffset: number; fileSize?: number }> = [];
  const harness: Harness = {
    reopenCalls,
    reselectCalls,
    flushCalls: 0,
    deps: {
      getReceivedSize: () => 0,
      hasRetainedCurrentFileData: () => false,
      flushPendingStreamWrites: async () => {
        harness.flushCalls += 1;
        return true;
      },
      reopenNativeWriterForResume: async (fileIndex, byteOffset) => {
        reopenCalls.push({ fileIndex, byteOffset });
        return behavior.reopen ?? true;
      },
      requestReselectReceiveTarget: async (request) => {
        reselectCalls.push(request);
        return behavior.reselect ?? false;
      },
      ...overrides,
    },
  };

  return harness;
};

test('resumes from retained data after flushing the pending writes', async () => {
  const harness = createHarness({
    hasRetainedCurrentFileData: () => true,
    getReceivedSize: () => 12,
  });

  const result = await recoverWriterForResume({ fileIndex: 0, fileSize: 100 }, harness.deps);

  assert.deepEqual(result, { status: 'resumed', fileIndex: 0, byteOffset: 12, reason: null });
  assert.equal(harness.flushCalls, 1);
  assert.deepEqual(harness.reopenCalls, []);
});

test('reports a flush failure without offering a resume offset', async () => {
  const harness = createHarness({
    hasRetainedCurrentFileData: () => true,
    getReceivedSize: () => 12,
    flushPendingStreamWrites: async () => false,
  });

  const result = await recoverWriterForResume({ fileIndex: 0, fileSize: 100 }, harness.deps);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'flush-failed');
  assert.equal(result.byteOffset, 0);
});

test('resumes from the durable offset on a reconnect without a checkpoint', async () => {
  const harness = createHarness({
    getReceivedSize: () => 100,
    getCommittedStreamBytes: () => 40,
  });

  const result = await recoverWriterForResume({ fileIndex: 0, fileSize: 200 }, harness.deps);

  assert.equal(result.status, 'resumed');
  assert.equal(result.byteOffset, 40);
  assert.deepEqual(harness.reopenCalls, [{ fileIndex: 0, byteOffset: 40 }]);
});

test('resumes a refreshed session from the checkpoint when in-memory counters are empty', async () => {
  const harness = createHarness();
  const checkpoint = createCheckpoint({ committedBytes: 4096 });

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 8192, checkpoint },
    harness.deps
  );

  assert.equal(result.status, 'resumed');
  assert.equal(result.byteOffset, 4096);
  assert.deepEqual(harness.reopenCalls, [{ fileIndex: 0, byteOffset: 4096 }]);
});

test('prefers the smaller of the live durable offset and the checkpoint', async () => {
  const harness = createHarness({
    getReceivedSize: () => 100,
    getCommittedStreamBytes: () => 100,
  });

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 8192, checkpoint: createCheckpoint({ committedBytes: 40 }) },
    harness.deps
  );

  assert.equal(result.byteOffset, 40);
});

test('clamps the checkpoint offset to the known file size', async () => {
  const harness = createHarness();

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 1000, checkpoint: createCheckpoint({ committedBytes: 4096 }) },
    harness.deps
  );

  assert.equal(result.status, 'resumed');
  assert.equal(result.byteOffset, 1000);
});

test('ignores a checkpoint that belongs to another file index', async () => {
  const harness = createHarness();

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 8192, checkpoint: createCheckpoint({ fileIndex: 3, committedBytes: 4096 }) },
    harness.deps
  );

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-durable-progress');
  assert.deepEqual(harness.reopenCalls, []);
});

test('asks the user to reselect the target and resumes when that succeeds', async () => {
  const harness = createHarness({}, { reopen: false, reselect: true });

  const result = await recoverWriterForResume(
    { fileIndex: 2, fileSize: 8192, checkpoint: createCheckpoint({ fileIndex: 2, committedBytes: 2048 }) },
    harness.deps
  );

  assert.equal(result.status, 'resumed');
  assert.equal(result.byteOffset, 2048);
  assert.deepEqual(harness.reselectCalls, [{ fileIndex: 2, byteOffset: 2048, fileSize: 8192 }]);
});

test('reports needs-permission when the user declines to reselect', async () => {
  const harness = createHarness({}, { reopen: false, reselect: false });

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 8192, checkpoint: createCheckpoint({ committedBytes: 2048 }) },
    harness.deps
  );

  assert.equal(result.status, 'needs-permission');
  assert.equal(result.reason, 'reselect-declined');
  assert.equal(result.byteOffset, 2048);
});

test('reports needs-permission without a reselect hook when the writer cannot be reopened', async () => {
  const harness = createHarness(
    { requestReselectReceiveTarget: undefined },
    { reopen: false }
  );

  const result = await recoverWriterForResume(
    { fileIndex: 0, fileSize: 8192, checkpoint: createCheckpoint({ committedBytes: 2048 }) },
    harness.deps
  );

  assert.equal(result.status, 'needs-permission');
  assert.equal(result.reason, 'writer-reopen-failed');
  assert.deepEqual(harness.reselectCalls, []);
});

test('reports unavailable when there is no durable progress at all', async () => {
  const harness = createHarness();

  const result = await recoverWriterForResume({ fileIndex: 0, fileSize: 8192 }, harness.deps);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-durable-progress');
  assert.deepEqual(harness.reopenCalls, []);
});
