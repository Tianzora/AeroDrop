import { resolveCheckpointOffset, type ResumeCheckpoint } from './resumeCheckpoint.ts';

export type ResumeWriterStatus = 'resumed' | 'needs-permission' | 'unavailable';

export type ResumeWriterReason =
  | 'flush-failed'
  | 'no-durable-progress'
  | 'writer-reopen-failed'
  | 'reselect-declined';

export interface ResumeWriterRecoveryRequest {
  fileIndex: number;
  fileSize?: number;
  // 刷新后从 IndexedDB/检查点带回的偏移；调用方负责先按 metadataFingerprint 校验。
  checkpoint?: ResumeCheckpoint | null;
}

export interface ResumeWriterRecoveryResult {
  status: ResumeWriterStatus;
  fileIndex: number;
  // status === 'resumed' 时可直接作为 RESUME_REQUEST/ACCEPT_TRANSFER 的偏移；
  // 'needs-permission' 时用于提示“将从 X 继续，请重新选择保存位置”。
  byteOffset: number;
  reason: ResumeWriterReason | null;
}

export interface ReselectReceiveTargetRequest {
  fileIndex: number;
  byteOffset: number;
  fileSize?: number;
}

export interface ResumeWriterRecoveryDeps {
  getReceivedSize: () => number;
  getCommittedStreamBytes?: () => number;
  hasRetainedCurrentFileData: (fileIndex: number) => boolean;
  flushPendingStreamWrites: () => Promise<boolean>;
  reopenNativeWriterForResume: (fileIndex: number, byteOffset: number) => Promise<boolean>;
  // 可注入的用户交互：重新选择保存目录/文件并把写入器重开到 byteOffset。返回 true 表示已重开。
  requestReselectReceiveTarget?: (request: ReselectReceiveTargetRequest) => Promise<boolean>;
}

const toSafeOffset = (value: number, fileSize?: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const offset = Math.floor(value);
  if (typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize >= 0) {
    return Math.max(0, Math.min(offset, Math.floor(fileSize)));
  }

  return Math.max(0, offset);
};

/**
 * 刷新/重连后决定“能不能接着写、从哪个字节继续”。
 *
 * 两个偏移来源：
 * - 内存里的 durable 计数（同一页面内重连时有效）；
 * - 检查点（刷新后唯一可用来源）。
 * 两者都存在时取较小值：宁可多收一段（覆盖写入是幂等的），也不能 seek 到真实文件长度之后留空洞。
 *
 * 状态：resumed 可直接续传；needs-permission 表示有可恢复进度但写入器打不开，
 * UI 应提示用户重新选择保存位置；unavailable 表示没有可用进度，只能从文件开头重下。
 */
export const recoverWriterForResume = async (
  request: ResumeWriterRecoveryRequest,
  deps: ResumeWriterRecoveryDeps
): Promise<ResumeWriterRecoveryResult> => {
  const fileIndex = request.fileIndex;
  const fileSize = request.fileSize;

  const resumed = (byteOffset: number): ResumeWriterRecoveryResult => ({
    status: 'resumed',
    fileIndex,
    byteOffset,
    reason: null,
  });

  const unavailable = (reason: ResumeWriterReason): ResumeWriterRecoveryResult => ({
    status: 'unavailable',
    fileIndex,
    byteOffset: 0,
    reason,
  });

  const needsPermission = (byteOffset: number, reason: ResumeWriterReason): ResumeWriterRecoveryResult => ({
    status: 'needs-permission',
    fileIndex,
    byteOffset,
    reason,
  });

  if (deps.hasRetainedCurrentFileData(fileIndex)) {
    const flushed = await deps.flushPendingStreamWrites();
    if (!flushed) {
      return unavailable('flush-failed');
    }

    const receivedOffset = toSafeOffset(deps.getReceivedSize(), fileSize);
    return receivedOffset > 0 ? resumed(receivedOffset) : unavailable('no-durable-progress');
  }

  const receivedSize = toSafeOffset(deps.getReceivedSize(), fileSize);
  const committedStreamBytes = deps.getCommittedStreamBytes?.();
  const durableOffset = toSafeOffset(
    typeof committedStreamBytes === 'number' && Number.isFinite(committedStreamBytes)
      ? Math.min(receivedSize, Math.max(0, committedStreamBytes))
      : receivedSize,
    fileSize
  );
  const checkpointOffset = resolveCheckpointOffset(request.checkpoint, fileIndex, fileSize);

  const candidates = [durableOffset, checkpointOffset].filter((offset) => offset > 0);
  const targetOffset = candidates.length > 0 ? Math.min(...candidates) : 0;

  if (targetOffset <= 0) {
    return unavailable('no-durable-progress');
  }

  if (await deps.reopenNativeWriterForResume(fileIndex, targetOffset)) {
    return resumed(targetOffset);
  }

  if (deps.requestReselectReceiveTarget) {
    const reselected = await deps.requestReselectReceiveTarget({
      fileIndex,
      byteOffset: targetOffset,
      fileSize,
    });

    if (reselected) {
      return resumed(targetOffset);
    }

    return needsPermission(targetOffset, 'reselect-declined');
  }

  return needsPermission(targetOffset, 'writer-reopen-failed');
};
