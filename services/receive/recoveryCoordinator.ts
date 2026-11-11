import { TransferState, type NormalizedFileRequest } from '../../types/index.ts';
import { TRANSFER_CONFIG } from '../../constants/transfer.ts';
import { createResumeRequestMessage, normalizeFileRequest } from '../protocol.ts';
import { logDebug } from '../diagnostics.ts';
import { resolveCheckpointOffset, type ResumeCheckpoint } from './resumeCheckpoint.ts';
import { recoverWriterForResume, type ReselectReceiveTargetRequest } from './resumeWriterRecovery.ts';

interface SendableConnection {
  open: boolean;
  send: (message: unknown) => void;
}

export interface ReceiveRecoveryCoordinatorOptions {
  maxAutoRepairRetries: number;
  getConnection: () => SendableConnection | null;
  setTransferActive: (active: boolean) => void;
  getCurrentFileIndex: () => number;
  getReceivedSize: () => number;
  getCurrentFileSize?: () => number;
  getCommittedStreamBytes?: () => number;
  // 刷新后从 IndexedDB/localStorage 读回的检查点（调用方负责按 metadataFingerprint 校验）。
  getResumeCheckpoint?: () => ResumeCheckpoint | null;
  // 用户交互：重新选择保存目录/文件并把写入器重开到检查点偏移。返回 true 表示已重开。
  requestReselectReceiveTarget?: (request: ReselectReceiveTargetRequest) => Promise<boolean>;
  isFileCompleted: (fileIndex: number) => boolean;
  hasRetainedCurrentFileData: (fileIndex: number) => boolean;
  flushPendingStreamWrites: () => Promise<boolean>;
  reopenNativeWriterForResume: (fileIndex: number, byteOffset: number) => Promise<boolean>;
  resetFileBuffersForRepair: (fileIndex: number) => void;
  resetHasherForRepair: () => Promise<boolean>;
  abortStreams: () => Promise<void>;
  awaitWriteQueue: () => Promise<void>;
  deleteIndexedDbChunksForFile: (fileIndex: number) => Promise<void>;
  setProgress: (value: number) => void;
  setDownloadSpeed: (value: string) => void;
  setDownloadSpeedBytes: (value: number) => void;
  setEta: (value: string) => void;
  setTransferState: (state: TransferState) => void;
  setError: (message: string) => void;
  notify?: (message: string, type: 'success' | 'info' | 'error') => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceiveRecoveryCoordinator {
  requestAutoRepair: (fileIndex: number, reason: string) => Promise<boolean>;
  resumeTransfer: () => Promise<void>;
  getPendingAutoRepairFile: () => number | null;
  hasPendingAutoRepair: () => boolean;
  clearPendingAutoRepairFile: (fileIndex?: number) => void;
  clearRepairStateForFile: (fileIndex: number) => void;
  reset: () => void;
}

const buildResumeRequest = (request: NormalizedFileRequest) =>
  createResumeRequestMessage(normalizeFileRequest(request));

export const createReceiveRecoveryCoordinator = (
  options: ReceiveRecoveryCoordinatorOptions
): ReceiveRecoveryCoordinator => {
  const repairAttempts = new Map<number, number>();
  let pendingAutoRepairFile: number | null = null;

  const getPendingAutoRepairFile = () => pendingAutoRepairFile;

  const clearPendingAutoRepairFile = (fileIndex?: number) => {
    if (typeof fileIndex === 'number' && pendingAutoRepairFile !== fileIndex) {
      return;
    }
    pendingAutoRepairFile = null;
  };

  const clearRepairStateForFile = (fileIndex: number) => {
    repairAttempts.delete(fileIndex);
    clearPendingAutoRepairFile(fileIndex);
  };

  const sendResumeRequest = (request: NormalizedFileRequest): boolean => {
    const conn = options.getConnection();
    if (!conn || !conn.open) {
      return false;
    }

    conn.send(buildResumeRequest(request));
    return true;
  };

  const requestAutoRepair = async (fileIndex: number, reason: string): Promise<boolean> => {
    const attempt = (repairAttempts.get(fileIndex) || 0) + 1;
    repairAttempts.set(fileIndex, attempt);

    if (attempt > options.maxAutoRepairRetries) {
      options.failTransferPersistence(`文件自动修复失败（已重试 ${options.maxAutoRepairRetries} 次）：${reason}`);
      return false;
    }

    pendingAutoRepairFile = fileIndex;
    options.setProgress(0);
    options.setDownloadSpeed('0 KB/s');
    options.setDownloadSpeedBytes(0);
    options.setEta('自动修复中...');

    options.resetFileBuffersForRepair(fileIndex);
    const hasherReady = await options.resetHasherForRepair();
    if (!hasherReady) {
      options.failTransferPersistence('文件校验初始化失败，请重试传输');
      return false;
    }

    await options.abortStreams();
    try {
      await options.awaitWriteQueue();
      await options.deleteIndexedDbChunksForFile(fileIndex);
    } catch (error) {
      logDebug('warn', 'IndexedDB cleanup before repair failed:', error);
    }

    try {
      const sent = sendResumeRequest({
        fileIndex,
        byteOffset: 0,
        silent: true,
        receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
      });
      if (!sent) {
        options.failTransferPersistence('连接已断开，无法自动修复，请重试');
        return false;
      }
    } catch {
      options.failTransferPersistence('自动修复请求发送失败，请重试');
      return false;
    }

    return true;
  };

  const resumeTransfer = async (): Promise<void> => {
    const conn = options.getConnection();
    if (!conn || !conn.open) {
      options.setError('连接已断开，请重新连接发送方');
      options.setTransferState(TransferState.ERROR);
      if (options.notify) {
        options.notify('连接已断开，请重试', 'error');
      }
      return;
    }

    options.setTransferActive(true);
    const currentIdx = options.getCurrentFileIndex();

    if (options.isFileCompleted(currentIdx)) {
      conn.send(buildResumeRequest({
        fileIndex: currentIdx + 1,
        byteOffset: 0,
        receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
      }));
      options.setTransferState(TransferState.TRANSFERRING);
      return;
    }

    let byteOffset = 0;
    let canResumeCurrentFile = false;
    const receivedSize = Math.max(0, options.getReceivedSize());
    const fileSize = options.getCurrentFileSize?.();
    const checkpoint = options.getResumeCheckpoint?.() ?? null;

    const recovery = await recoverWriterForResume(
      { fileIndex: currentIdx, fileSize, checkpoint },
      {
        getReceivedSize: options.getReceivedSize,
        getCommittedStreamBytes: options.getCommittedStreamBytes,
        hasRetainedCurrentFileData: options.hasRetainedCurrentFileData,
        flushPendingStreamWrites: options.flushPendingStreamWrites,
        reopenNativeWriterForResume: options.reopenNativeWriterForResume,
        requestReselectReceiveTarget: options.requestReselectReceiveTarget,
      }
    );

    if (recovery.status === 'unavailable' && recovery.reason === 'flush-failed') {
      // 落盘失败时不能静默 return：此时 transferActive 已置 true，界面会一直停在“传输中”。
      options.setTransferState(TransferState.ERROR);
      options.failTransferPersistence('文件落盘失败，无法续传，请重试传输');
      return;
    }

    const checkpointOffset = resolveCheckpointOffset(checkpoint, currentIdx, fileSize);
    if (recovery.status === 'needs-permission' && checkpointOffset > 0) {
      // 刷新后拿到检查点进度，但原 FileSystemHandle 打不开：等 UI 让用户重新选择保存位置后
      // 再次调用 resumeTransfer。此处不能发 byteOffset 0，否则会用 0 覆盖已落盘的数据。
      if (options.notify) {
        options.notify('需要重新选择保存位置才能继续接收该文件', 'info');
      }
      return;
    }

    byteOffset = recovery.status === 'resumed' ? recovery.byteOffset : 0;
    canResumeCurrentFile = recovery.status === 'resumed' && byteOffset > 0;

    if (!canResumeCurrentFile && receivedSize > 0 && options.notify) {
      options.notify('当前文件的流式落盘状态无法直接续写，本次将从该文件开头重新下载', 'info');
    }

    conn.send(buildResumeRequest({
      fileIndex: currentIdx,
      byteOffset: canResumeCurrentFile ? byteOffset : 0,
      receiveWindowBytes: TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES,
    }));
    options.setTransferState(TransferState.TRANSFERRING);
  };

  return {
    requestAutoRepair,
    resumeTransfer,
    getPendingAutoRepairFile,
    hasPendingAutoRepair: () => pendingAutoRepairFile !== null,
    clearPendingAutoRepairFile,
    clearRepairStateForFile,
    reset: () => {
      repairAttempts.clear();
      pendingAutoRepairFile = null;
    },
  };
};
