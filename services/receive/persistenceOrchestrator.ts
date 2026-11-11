import { logDebug } from '../diagnostics.ts';

interface FinalizeBatch<T> {
  batch: T[];
  size: number;
}

type TransferStateLike = string;

export interface ReceivePersistenceOrchestratorOptions {
  getState: () => TransferStateLike;
  isTransferActive: () => boolean;
  getCurrentFileIndex: () => number;
  isIndexedDbBuffering: () => boolean;
  isStreaming: () => boolean;
  flushStreamingWriter?: () => Promise<void>;
  finalizeStreamingWriter?: () => Promise<boolean>;
  takeIndexedDbBatch: () => FinalizeBatch<ArrayBuffer>;
  flushIndexedDbBatch: (fileIndex: number, batch: ArrayBuffer[], totalLen: number) => Promise<void>;
  takeStreamBatch: () => FinalizeBatch<Uint8Array>;
  flushSpecificBatch: (batch: Uint8Array[], totalLen: number) => Promise<void>;
  enqueueWrite: (task: () => Promise<void>) => Promise<void>;
  closeStreams: () => Promise<boolean>;
  saveCurrentFile: () => Promise<boolean>;
  markCurrentFilePersisted: (fileName: string) => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceivePersistenceOrchestrator {
  awaitPendingFileFinalize: (reason: string) => Promise<boolean>;
  finalizeCurrentFile: (fileName: string) => Promise<void>;
  reset: () => void;
}

export const createReceivePersistenceOrchestrator = (
  options: ReceivePersistenceOrchestratorOptions
): ReceivePersistenceOrchestrator => {
  let pendingFinalizePromise: Promise<void> | null = null;

  const awaitPendingFileFinalize = async (reason: string): Promise<boolean> => {
    if (!pendingFinalizePromise) {
      return true;
    }

    try {
      await pendingFinalizePromise;
    } catch (error) {
      logDebug('warn', `Pending file finalize failed before ${reason}:`, error);
    }

    return options.getState() !== 'ERROR';
  };

  const finalizeCurrentFile = (fileName: string): Promise<void> => {
    const finalizePromise = (async () => {
      if (options.isIndexedDbBuffering()) {
        const indexedDbBatch = options.takeIndexedDbBatch();
        await options.enqueueWrite(async () => {
          if (indexedDbBatch.size > 0) {
            await options.flushIndexedDbBatch(
              options.getCurrentFileIndex(),
              indexedDbBatch.batch,
              indexedDbBatch.size
            );
          }
        });
      }

      if (options.isStreaming() && options.finalizeStreamingWriter) {
        const finalized = await options.finalizeStreamingWriter();
        if (!finalized) {
          options.failTransferPersistence('文件落盘失败，请重试');
          return;
        }
      } else {
        const streamBatch = options.takeStreamBatch();
        await options.enqueueWrite(async () => {
          if (streamBatch.size > 0) {
            await options.flushSpecificBatch(streamBatch.batch, streamBatch.size);
          }

          if (options.isStreaming()) {
            const closeOk = await options.closeStreams();
            if (!closeOk) {
              options.failTransferPersistence('文件落盘失败，请重试');
              return;
            }
          }
        });
      }

      await options.enqueueWrite(async () => {
        if (!options.isTransferActive() || options.getState() === 'ERROR') {
          return;
        }

        if (options.isIndexedDbBuffering()) {
          const saved = await options.saveCurrentFile();
          if (!saved) {
            return;
          }
        }

        options.markCurrentFilePersisted(fileName);
      });
    })();

    pendingFinalizePromise = finalizePromise.finally(() => {
      if (pendingFinalizePromise === finalizePromise) {
        pendingFinalizePromise = null;
      }
    });

    return pendingFinalizePromise;
  };

  const reset = () => {
    pendingFinalizePromise = null;
  };

  return {
    awaitPendingFileFinalize,
    finalizeCurrentFile,
    reset,
  };
};
