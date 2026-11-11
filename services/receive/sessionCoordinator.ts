import { type FileCompletePayload, type FileStartPayload } from '../../types';
import { decidePersistenceStrategy, type PersistenceStrategy } from './persistenceStrategy';

export interface PreparedFileStartResult {
  fileIndex: number;
  fileName: string;
  fileSize: number;
}

export interface ReceiveSessionCoordinatorOptions {
  awaitPendingFileFinalize: (reason: string) => Promise<boolean>;
  isIOS: boolean;
  isSafari: boolean;
  isBrowserDownloadPreferred: () => boolean;
  supportsStreamSaver: boolean;
  indexedDbThresholdBytes: number;
  getMetadataFileCount: () => number;
  getFileStartPersistenceCapabilities: (fileIndex: number) => {
    canUseNativeFs: boolean;
    usePreparedNativeWriter: boolean;
    directSaveMode: 'native-fs' | 'directory-direct' | 'none';
  };
  supportsIndexedDb: () => boolean;
  setTransferActive: (active: boolean) => void;
  isTransferActive: () => boolean;
  isStreaming: () => boolean;
  isIndexedDbBuffering: () => boolean;
  setIndexedDbBuffering: (enabled: boolean) => void;
  notifyIndexedDbBufferingEnabled: () => void;
  hasRetainedCurrentFileData: (fileIndex: number) => boolean;
  abortStreams: () => Promise<void>;
  resetIncomingFileBuffers: (fileIndex: number) => void;
  awaitWriteQueue: () => Promise<void>;
  deleteIndexedDbChunksForFile: (fileIndex: number) => Promise<void>;
  prepareFilePersistenceTarget: (args: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
    persistenceStrategy: PersistenceStrategy;
    usePreparedNativeWriter: boolean;
    directSaveMode: 'native-fs' | 'directory-direct' | 'none';
  }) => Promise<void>;
  setCurrentFileState: (args: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
  }) => void;
  resetFileHasher: () => Promise<boolean>;
  getCurrentFileIndex: () => number;
  getCurrentFileName: () => string;
  getCurrentFileSize: () => number;
  getReceivedSize: () => number;
  getHashedBytes: () => number;
  finalizeHasher: () => Promise<string>;
  requestAutoRepair: (fileIndex: number, reason: string) => Promise<boolean>;
  clearPendingAutoRepairFile: (fileIndex: number) => void;
  getPendingAutoRepairFile: () => number | null;
  hasPendingAutoRepair: () => boolean;
  finalizeCurrentFilePersistence: (fileName: string) => Promise<void>;
  shouldStageFilesForArchive: () => boolean;
  stageCurrentFileForArchive: () => Promise<boolean>;
  finalizeArchiveDownload: () => Promise<boolean>;
  saveCurrentFile: () => Promise<boolean>;
  markCurrentFilePersisted: (fileName: string) => void;
  getExpectedFiles: () => number;
  getSavedFiles: () => number;
  sendTransferProgress: (speedBytes: number) => void;
  sendAllFilesReceived: () => void;
  markCompleted: () => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceiveSessionCoordinator {
  handleFileStart: (payload: FileStartPayload) => Promise<void>;
  handleFileComplete: (payload: FileCompletePayload | undefined) => Promise<void>;
  handleAllFilesComplete: () => Promise<void>;
}

export const createReceiveSessionCoordinator = (
  options: ReceiveSessionCoordinatorOptions
): ReceiveSessionCoordinator => {
  const handleFileStart = async (payload: FileStartPayload): Promise<void> => {
    if (!await options.awaitPendingFileFinalize('FILE_START')) return;
    options.setTransferActive(true);

    const fileIndex = payload.fileIndex;
    const fileSize = payload.fileSize;
    const fileName = payload.fileName;
    const { canUseNativeFs, usePreparedNativeWriter, directSaveMode } = options.getFileStartPersistenceCapabilities(fileIndex);
    const persistenceStrategy = decidePersistenceStrategy({
      isIOS: options.isIOS,
      isSafari: options.isSafari,
      preferBrowserDownload: options.isBrowserDownloadPreferred() || options.shouldStageFilesForArchive(),
      supportsNativeFs: canUseNativeFs,
      supportsStreamSaver: options.supportsStreamSaver,
      supportsIndexedDb: options.supportsIndexedDb(),
      fileSize,
      indexedDbThresholdBytes: options.indexedDbThresholdBytes,
    });

    const shouldUseIndexedDbBuffering = persistenceStrategy === 'indexeddb-buffer';
    options.setIndexedDbBuffering(shouldUseIndexedDbBuffering);
    if (shouldUseIndexedDbBuffering) {
      options.notifyIndexedDbBufferingEnabled();
    }

    const resumingSameFile = options.hasRetainedCurrentFileData(fileIndex);
    if (!resumingSameFile) {
      if (!usePreparedNativeWriter) {
        await options.abortStreams();
      }
      options.resetIncomingFileBuffers(fileIndex);

      if (shouldUseIndexedDbBuffering) {
        try {
          await options.awaitWriteQueue();
          await options.deleteIndexedDbChunksForFile(fileIndex);
        } catch {
          options.failTransferPersistence('无法初始化 iOS 大文件缓存，请重试');
          return;
        }
      }

      await options.prepareFilePersistenceTarget({
        fileIndex,
        fileName,
        fileSize,
        persistenceStrategy,
        usePreparedNativeWriter,
        directSaveMode,
      });
    }

    if (options.getPendingAutoRepairFile() === fileIndex) {
      options.clearPendingAutoRepairFile(fileIndex);
    }

    const hasherReady = await options.resetFileHasher();
    if (!hasherReady) {
      options.failTransferPersistence('文件校验初始化失败，请重试');
      return;
    }

    options.setCurrentFileState({
      fileIndex,
      fileName,
      fileSize,
    });
    options.sendTransferProgress(0);
  };

  const handleFileComplete = async (payload: FileCompletePayload | undefined): Promise<void> => {
    if (!options.isTransferActive()) return;

    const currentFileIndex = options.getCurrentFileIndex();
    const receivedSize = options.getReceivedSize();
    const currentFileSize = options.getCurrentFileSize();

    if (receivedSize !== currentFileSize) {
      const repaired = await options.requestAutoRepair(
        currentFileIndex,
        `文件长度不一致（${receivedSize}/${currentFileSize}）`
      );
      if (!repaired) return;
      return;
    }

    if (payload?.hashAlgorithm === 'crc32' && typeof payload.fileHash === 'string') {
      const expectedBytes = typeof payload.hashedBytes === 'number'
        ? Math.max(0, payload.hashedBytes)
        : options.getHashedBytes();
      if (options.getHashedBytes() !== expectedBytes) {
        const repaired = await options.requestAutoRepair(
          currentFileIndex,
          `字节数不一致（${options.getHashedBytes()}/${expectedBytes}）`
        );
        if (!repaired) return;
        return;
      }

      let actualHash = '';
      try {
        actualHash = await options.finalizeHasher();
      } catch {
        options.failTransferPersistence('文件校验计算失败，请重试');
        return;
      }

      if (actualHash !== payload.fileHash.toLowerCase()) {
        const repaired = await options.requestAutoRepair(
          currentFileIndex,
          `哈希不一致（${actualHash} != ${payload.fileHash}）`
        );
        if (!repaired) return;
        return;
      }
    }

    const currentFileName = options.getCurrentFileName();
    if (options.shouldStageFilesForArchive()) {
      const staged = await options.stageCurrentFileForArchive();
      if (!staged) {
        return;
      }
      options.markCurrentFilePersisted(currentFileName);
      return;
    }

    if (options.isStreaming() || options.isIndexedDbBuffering()) {
      await options.finalizeCurrentFilePersistence(currentFileName);
      return;
    }

    const saved = await options.saveCurrentFile();
    if (!saved) {
      return;
    }
    options.markCurrentFilePersisted(currentFileName);
  };

  const handleAllFilesComplete = async (): Promise<void> => {
    if (!options.isTransferActive()) return;
    if (options.hasPendingAutoRepair()) return;
    if (!await options.awaitPendingFileFinalize('ALL_FILES_COMPLETE')) return;

    await options.awaitWriteQueue();
    const expectedFiles = options.getExpectedFiles();
    const savedFiles = options.getSavedFiles();
    if (expectedFiles > 0 && savedFiles < expectedFiles) {
      options.failTransferPersistence(`文件保存不完整（${savedFiles}/${expectedFiles}），请重试`);
      return;
    }

    if (options.shouldStageFilesForArchive()) {
      const exported = await options.finalizeArchiveDownload();
      if (!exported) {
        options.failTransferPersistence('多文件导出失败，请重试');
        return;
      }
    }

    options.sendTransferProgress(0);
    options.sendAllFilesReceived();
    options.markCompleted();
  };

  return {
    handleFileStart,
    handleFileComplete,
    handleAllFilesComplete,
  };
};
