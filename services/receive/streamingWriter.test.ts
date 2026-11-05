import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiveStreamingWriter, type ReceiveStreamingTarget } from './streamingWriter.ts';

const createMemoryTarget = (events: string[]): ReceiveStreamingTarget => ({
  kind: 'native-fs',
  write: async (chunk) => {
    events.push(`write:${chunk.byteLength}`);
  },
  close: async () => {
    events.push('close');
  },
  truncate: async (size) => {
    events.push(`truncate:${size}`);
  },
});

test('flushes buffered chunks once the threshold is reached', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
  });

  writer.attachTarget(createMemoryTarget(events));

  await writer.enqueueChunk(new Uint8Array([1, 2]));
  assert.equal(writer.getCommittedBytes(), 0);

  await writer.enqueueChunk(new Uint8Array([3, 4]));
  await writer.awaitIdle();

  assert.deepEqual(events, ['write:4']);
  assert.equal(writer.getCommittedBytes(), 4);
});

test('finalize flushes pending data before closing the target', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget(createMemoryTarget(events));

  await writer.enqueueChunk(new Uint8Array([1, 2, 3]));
  await writer.finalize();

  assert.deepEqual(events, ['write:3', 'close']);
  assert.equal(writer.isStreaming(), false);
});

test('reopenForResume preserves committed bytes for the next native writer', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget(createMemoryTarget(events));
  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4]));
  await writer.flushPending();
  await writer.closeCurrentTarget();

  assert.equal(writer.getCommittedBytes(), 4);

  let reopenedOffset = -1;
  const reopened = await writer.reopenForResume(async (byteOffset) => {
    reopenedOffset = byteOffset;
    return createMemoryTarget(events);
  }, 4);

  assert.equal(reopened, true);
  assert.equal(reopenedOffset, 4);
  assert.equal(writer.isStreaming(), true);
});

test('native finalize treats verified bytes as success and releases the stream when close keeps failing', async () => {
  let closeAttempts = 0;
  let aborted = false;

  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      closeAttempts += 1;
      throw new Error('BENIGN_CLOSE_FAILURE');
    },
    abort: async () => {
      aborted = true;
    },
    verifyCommittedBytes: async (expectedBytes) => expectedBytes === 5,
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4, 5]));
  const finalized = await writer.finalize();

  // 已核对过磁盘长度 → 数据在盘上，不能因为 close 收尾失败就把成型文件判为“落盘失败”。
  // 再 close 一次，仍失败则用 abort() 释放文件锁，最终仍返回 true。
  assert.equal(finalized, true);
  assert.equal(closeAttempts, 2);
  assert.equal(aborted, true);
  assert.equal(writer.isStreaming(), false);
});

test('closeCurrentTarget keeps native data intact by default', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      events.push('close');
    },
    truncate: async (size) => {
      events.push(`truncate:${size}`);
    },
  });

  const closed = await writer.closeCurrentTarget({
    preserveCommittedBytes: true,
  });

  assert.equal(closed, true);
  assert.deepEqual(events, ['close']);
});

test('counts an in-flight batch against the pending byte limit', async () => {
  let releaseWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
    maxPendingBytes: 4,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: () => blockedWrite,
    close: async () => {},
  });

  const pendingWrite = writer.enqueueChunk(new Uint8Array(4));
  await Promise.resolve();
  assert.equal(writer.getBufferedBytes(), 4);

  releaseWrite();
  await pendingWrite;
  assert.equal(writer.getBufferedBytes(), 0);
  assert.equal(writer.getCommittedBytes(), 4);
});

test('rejects a single chunk larger than the pending byte limit', async () => {
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
    maxPendingBytes: 4,
  });
  writer.attachTarget(createMemoryTarget([]));

  await assert.rejects(
    writer.enqueueChunk(new Uint8Array(5)),
    /STREAMING_CHUNK_EXCEEDS_PENDING_LIMIT/
  );
});

test('finalize retries close after the committed size is verified', async () => {
  let closeAttempts = 0;

  const writer = createReceiveStreamingWriter({ flushThresholdBytes: 64 });
  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) {
        throw new Error('TRANSIENT_CLOSE_FAILURE');
      }
    },
    verifyCommittedBytes: async (expectedBytes) => expectedBytes === 5,
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4, 5]));

  assert.equal(await writer.finalize(), true);
  assert.equal(closeAttempts, 2);
  assert.equal(writer.isStreaming(), false);
});

test('finalize still succeeds without abort when verified close cannot be retried', async () => {
  let closeAttempts = 0;

  const writer = createReceiveStreamingWriter({ flushThresholdBytes: 64 });
  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      closeAttempts += 1;
      throw new Error('CLOSE_STILL_FAILING');
    },
    verifyCommittedBytes: async (expectedBytes) => expectedBytes === 5,
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4, 5]));

  assert.equal(await writer.finalize(), true);
  assert.equal(closeAttempts, 2);
  assert.equal(writer.isStreaming(), false);
});

test('finalize reports failure when the committed size cannot be verified', async () => {
  let closeAttempts = 0;
  let verifyAttempts = 0;

  const writer = createReceiveStreamingWriter({ flushThresholdBytes: 64 });
  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      closeAttempts += 1;
      throw new Error('CLOSE_FAILED');
    },
    verifyCommittedBytes: async () => {
      verifyAttempts += 1;
      return false;
    },
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3]));

  assert.equal(await writer.finalize(), false);
  assert.equal(verifyAttempts, 1);
  assert.equal(closeAttempts, 1);
  assert.equal(writer.isStreaming(), true);
});

test('finalize reports failure when the target cannot verify committed bytes', async () => {
  const writer = createReceiveStreamingWriter({ flushThresholdBytes: 64 });
  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      throw new Error('CLOSE_FAILED');
    },
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3]));

  assert.equal(await writer.finalize(), false);
  assert.equal(writer.isStreaming(), true);
});
