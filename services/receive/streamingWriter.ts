import { logDebug } from '../diagnostics.ts';

export type ReceiveStreamingTargetKind = 'native-fs' | 'stream-saver';

export interface ReceiveStreamingTarget {
  kind: ReceiveStreamingTargetKind;
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
  truncate?: (size: number) => Promise<void>;
  verifyCommittedBytes?: (expectedBytes: number) => Promise<boolean>;
}

export interface ReceiveStreamingWriterOptions {
  flushThresholdBytes: number;
  maxPendingBytes?: number;
}

export interface ReceiveStreamingWriter {
  attachTarget: (
    target: ReceiveStreamingTarget,
    options?: { committedBytes?: number; resetCommittedBytes?: boolean }
  ) => void;
  enqueueChunk: (chunk: Uint8Array) => Promise<void>;
  flushPending: () => Promise<void>;
  awaitIdle: () => Promise<void>;
  finalize: () => Promise<boolean>;
  closeCurrentTarget: (options?: {
    truncateNativeBeforeClose?: boolean;
    abortStreamSaver?: boolean;
    preserveCommittedBytes?: boolean;
  }) => Promise<boolean>;
  reopenForResume: (
    factory: (byteOffset: number) => Promise<ReceiveStreamingTarget>,
    byteOffset?: number
  ) => Promise<boolean>;
  isStreaming: () => boolean;
  hasRetainedData: () => boolean;
  getCommittedBytes: () => number;
  getBufferedBytes: () => number;
  reset: () => void;
}

export const createReceiveStreamingWriter = (
  options: ReceiveStreamingWriterOptions
): ReceiveStreamingWriter => {
  let activeTarget: ReceiveStreamingTarget | null = null;
  let pendingChunks: Uint8Array[] = [];
  let pendingBytes = 0;
  let queuedBytes = 0;
  let committedBytes = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let failedError: unknown = null;

  const clearPending = () => {
    pendingChunks = [];
    pendingBytes = 0;
  };

  const clearFailure = () => {
    failedError = null;
  };

  const ensureHealthy = () => {
    if (failedError) {
      throw failedError;
    }
    if (!activeTarget) {
      throw new Error('STREAMING_TARGET_UNAVAILABLE');
    }
  };

  const snapshotPending = (): { chunks: Uint8Array[]; totalLen: number } => {
    const chunks = pendingChunks;
    const totalLen = pendingBytes;
    clearPending();
    return { chunks, totalLen };
  };

  const scheduleWrite = (task: () => Promise<void>, byteLength: number): Promise<void> => {
    queuedBytes += byteLength;
    writeQueue = writeQueue.then(async () => {
      if (failedError) {
        throw failedError;
      }
      await task();
    }).finally(() => {
      queuedBytes = Math.max(0, queuedBytes - byteLength);
    });

    return writeQueue.catch((error) => {
      failedError = error;
      throw error;
    });
  };

  const flushBatch = async (chunks: Uint8Array[], totalLen: number) => {
    ensureHealthy();
    if (totalLen <= 0) {
      return;
    }

    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    await activeTarget!.write(combined);
    committedBytes += totalLen;
  };

  const flushPending = async (): Promise<void> => {
    if (pendingBytes <= 0) {
      await writeQueue;
      if (failedError) {
        throw failedError;
      }
      return;
    }

    const { chunks, totalLen } = snapshotPending();
    await scheduleWrite(async () => {
      await flushBatch(chunks, totalLen);
    }, totalLen);
  };

  const clearTarget = (preserveCommittedBytes: boolean) => {
    activeTarget = null;
    clearPending();
    writeQueue = Promise.resolve();
    clearFailure();
    if (!preserveCommittedBytes) {
      committedBytes = 0;
    }
  };

  /**
   * close() 抛错时不能直接判定落盘失败：verifyCommittedBytes 已经核对过磁盘长度，
   * 数据确实在盘上，只是写入流没正常收尾。语义改定为：
   * verify 通过 → 再 close 一次 → 仍失败就用 abort() 尽力释放文件锁 → 最终仍返回 true，
   * 失败细节只记 warn，不再把已成型文件判为“落盘失败”让用户重传。
   */
  const recoverCommittedTarget = async (): Promise<boolean> => {
    const target = activeTarget;
    if (!target) {
      return false;
    }

    const expectedBytes = committedBytes;
    let verified = false;
    if (target.verifyCommittedBytes) {
      try {
        verified = await target.verifyCommittedBytes(expectedBytes);
      } catch (verifyError) {
        logDebug('warn', '[streaming-writer] committed byte verification threw', verifyError);
        verified = false;
      }
    }

    if (!verified) {
      return false;
    }

    try {
      await target.close();
      clearTarget(false);
      return true;
    } catch (closeError) {
      logDebug('warn', '[streaming-writer] close failed after verified bytes; releasing the stream', {
        expectedBytes,
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }

    if (target.abort) {
      try {
        await target.abort();
      } catch (abortError) {
        logDebug('warn', '[streaming-writer] abort after failed close was not clean', abortError);
      }
    }

    clearTarget(false);
    return true;
  };

  return {
    attachTarget: (target, attachOptions) => {
      activeTarget = target;
      clearPending();
      writeQueue = Promise.resolve();
      clearFailure();

      if (attachOptions?.resetCommittedBytes !== false) {
        committedBytes = attachOptions?.committedBytes ?? 0;
      } else if (typeof attachOptions?.committedBytes === 'number') {
        committedBytes = attachOptions.committedBytes;
      }
    },

    enqueueChunk: async (chunk) => {
      if (failedError) {
        throw failedError;
      }
      ensureHealthy();
      const maxPendingBytes = options.maxPendingBytes ?? Number.POSITIVE_INFINITY;
      if (chunk.byteLength > maxPendingBytes) {
        throw new Error('STREAMING_CHUNK_EXCEEDS_PENDING_LIMIT');
      }
      if (pendingBytes + queuedBytes + chunk.byteLength > maxPendingBytes) {
        await flushPending();
        await writeQueue;
      }
      pendingChunks.push(chunk);
      pendingBytes += chunk.byteLength;

      if (pendingBytes >= options.flushThresholdBytes) {
        await flushPending();
      }
    },

    flushPending,

    awaitIdle: async () => {
      await writeQueue;
      if (failedError) {
        throw failedError;
      }
    },

    finalize: async () => {
      try {
        await flushPending();
        await writeQueue;
        ensureHealthy();
        await activeTarget!.close();
        clearTarget(false);
        return true;
      } catch {
        return recoverCommittedTarget();
      }
    },

    closeCurrentTarget: async (closeOptions) => {
      if (!activeTarget) {
        clearPending();
        if (closeOptions?.preserveCommittedBytes === false) {
          committedBytes = 0;
        }
        clearFailure();
        return true;
      }

      const preserveCommittedBytes = closeOptions?.preserveCommittedBytes !== false;
      try {
        await writeQueue;

        if (
          closeOptions?.truncateNativeBeforeClose === true &&
          activeTarget.kind === 'native-fs' &&
          activeTarget.truncate
        ) {
          await activeTarget.truncate(0);
        }

        if (
          closeOptions?.abortStreamSaver === true &&
          activeTarget.kind === 'stream-saver' &&
          activeTarget.abort
        ) {
          await activeTarget.abort();
        } else {
          await activeTarget.close();
        }

        clearTarget(preserveCommittedBytes);
        return true;
      } catch {
        clearTarget(preserveCommittedBytes);
        return false;
      }
    },

    reopenForResume: async (factory, byteOffset) => {
      try {
        await writeQueue;
        const resumeOffset = typeof byteOffset === 'number' ? Math.max(0, byteOffset) : committedBytes;
        committedBytes = resumeOffset;
        const target = await factory(resumeOffset);
        activeTarget = target;
        clearPending();
        writeQueue = Promise.resolve();
        clearFailure();
        return true;
      } catch {
        activeTarget = null;
        return false;
      }
    },

    isStreaming: () => activeTarget !== null,
    hasRetainedData: () => pendingBytes > 0 || activeTarget !== null,
    getCommittedBytes: () => committedBytes,
    getBufferedBytes: () => pendingBytes + queuedBytes,
    reset: () => {
      activeTarget = null;
      committedBytes = 0;
      clearPending();
      writeQueue = Promise.resolve();
      clearFailure();
    },
  };
};
