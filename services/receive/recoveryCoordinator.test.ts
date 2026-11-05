import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferState } from '../../types/index.ts';
import type { ResumeCheckpoint } from './resumeCheckpoint.ts';
import { createReceiveRecoveryCoordinator } from './recoveryCoordinator.ts';

test('resumeTransfer reopens the writer from the durably committed byte offset', async () => {
  const sentMessages: unknown[] = [];
  const reopenCalls: Array<{ fileIndex: number; byteOffset: number }> = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 12,
    getCommittedStreamBytes: () => 8,
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async (fileIndex: number, byteOffset: number) => {
      reopenCalls.push({ fileIndex, byteOffset });
      return true;
    },
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  assert.deepEqual(reopenCalls, [{ fileIndex: 0, byteOffset: 8 }]);
  assert.equal((sentMessages[0] as any)?.type, 'RESUME_REQUEST');
  assert.deepEqual((sentMessages[0] as any)?.payload, {
    fileIndex: 0,
    byteOffset: 8,
    silent: false,
    receiveWindowBytes: 2 * 1024 * 1024,
  });
});

test('resumeTransfer falls back to the received byte count when no durable offset is available', async () => {
  const sentMessages: unknown[] = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 12,
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async () => true,
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  });

  await coordinator.resumeTransfer();

  assert.equal((sentMessages[0] as any)?.payload?.byteOffset, 12);
});

test('resumeTransfer reports a persistence failure instead of silently returning when the flush fails', async () => {
  const sentMessages: unknown[] = [];
  const states: string[] = [];
  const failures: string[] = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 12,
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => true,
    flushPendingStreamWrites: async () => false,
    reopenNativeWriterForResume: async () => true,
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: (state: string) => {
      states.push(state);
    },
    setError: () => {},
    failTransferPersistence: (message: string) => {
      failures.push(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  assert.equal(sentMessages.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? '', /落盘失败/);
  assert.equal(states[states.length - 1], TransferState.ERROR);
});

const createCheckpoint = (overrides: Partial<ResumeCheckpoint> = {}): ResumeCheckpoint => ({
  sessionId: 'session-1',
  metadataFingerprint: 'fingerprint',
  fileIndex: 0,
  committedBytes: 4096,
  totalSize: 8192,
  updatedAt: 1_000,
  ...overrides,
});

test('resumeTransfer resumes a refreshed session from the checkpoint offset', async () => {
  const sentMessages: unknown[] = [];
  const reopenCalls: Array<{ fileIndex: number; byteOffset: number }> = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 8192,
    getResumeCheckpoint: () => createCheckpoint(),
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async (fileIndex: number, byteOffset: number) => {
      reopenCalls.push({ fileIndex, byteOffset });
      return true;
    },
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  assert.deepEqual(reopenCalls, [{ fileIndex: 0, byteOffset: 4096 }]);
  assert.deepEqual((sentMessages[0] as any)?.payload, {
    fileIndex: 0,
    byteOffset: 4096,
    silent: false,
    receiveWindowBytes: 2 * 1024 * 1024,
  });
});

test('resumeTransfer waits for a reselect instead of restarting from zero when a checkpoint exists', async () => {
  const sentMessages: unknown[] = [];
  const notifications: string[] = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 8192,
    getResumeCheckpoint: () => createCheckpoint(),
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async () => false,
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    notify: (message: string) => {
      notifications.push(message);
    },
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  // 不能发 byteOffset 0，否则会用 0 覆盖已落盘的数据。
  assert.equal(sentMessages.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? '', /重新选择保存位置/);
});

test('resumeTransfer resumes at the checkpoint offset once the user reselects the target', async () => {
  const sentMessages: unknown[] = [];
  const reselectCalls: Array<{ fileIndex: number; byteOffset: number }> = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 8192,
    getResumeCheckpoint: () => createCheckpoint(),
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async () => false,
    requestReselectReceiveTarget: async (request: {
      fileIndex: number;
      byteOffset: number;
      fileSize?: number;
    }) => {
      reselectCalls.push({ fileIndex: request.fileIndex, byteOffset: request.byteOffset });
      return true;
    },
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  assert.deepEqual(reselectCalls, [{ fileIndex: 0, byteOffset: 4096 }]);
  assert.deepEqual((sentMessages[0] as any)?.payload, {
    fileIndex: 0,
    byteOffset: 4096,
    silent: false,
    receiveWindowBytes: 2 * 1024 * 1024,
  });
});
