export type PersistenceStrategy =
  | 'native-fs'
  | 'stream-saver'
  | 'indexeddb-buffer'
  | 'memory-blob';

// 桌面浏览器默认走 native-fs（零内存、可流式落盘），但刷新后 FileSystemHandle 会丢。
// 只有调用方明确说“这次要能刷新后续传”（有检查点 / 用户显式选择）时，才用 IDB 缓冲换这份能力。
// 建议值放在模块内而不是 constants：调用方可以通过参数覆盖，也不影响其它模块。
export const DESKTOP_RESUME_BUFFERING_DEFAULTS = {
  MIN_FILE_BYTES: 64 * 1024 * 1024,
  MAX_FILE_BYTES: 2 * 1024 * 1024 * 1024,
} as const;

export interface DesktopResumeBufferingInput {
  isIOS: boolean;
  isSafari: boolean;
  supportsIndexedDb: boolean;
  fileSize: number;
  hasResumeCheckpoint?: boolean;
  preferIndexedDbBuffering?: boolean;
  minFileBytes?: number;
  maxFileBytes?: number;
}

export interface PersistenceStrategyInput {
  isIOS: boolean;
  isSafari: boolean;
  preferBrowserDownload?: boolean;
  supportsNativeFs: boolean;
  supportsStreamSaver: boolean;
  supportsIndexedDb: boolean;
  fileSize: number;
  indexedDbThresholdBytes: number;
  // 本次传输希望支持“刷新后续传”（存在检查点，或用户在设置里显式选择缓冲）。
  hasResumeCheckpoint?: boolean;
  preferIndexedDbBuffering?: boolean;
  desktopIndexedDbMinBytes?: number;
  desktopIndexedDbMaxBytes?: number;
}

const resolveByteBound = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/**
 * 桌面端是否改用 IndexedDB 缓冲：满足全部条件才启用——
 * 非 iOS/Safari（这两者本来就有 IDB 分支）、支持 IDB、调用方声明需要续传能力、
 * 文件大小落在 [min, max] 区间（太小不值得，太大怕撑爆 IDB/内存）。
 * 未声明 hasResumeCheckpoint / preferIndexedDbBuffering 时保持现状（native-fs）。
 */
export const shouldBufferDesktopFileForResume = (
  input: DesktopResumeBufferingInput
): boolean => {
  if (input.isIOS || input.isSafari || !input.supportsIndexedDb) {
    return false;
  }

  if (input.hasResumeCheckpoint !== true && input.preferIndexedDbBuffering !== true) {
    return false;
  }

  const minFileBytes = resolveByteBound(
    input.minFileBytes,
    DESKTOP_RESUME_BUFFERING_DEFAULTS.MIN_FILE_BYTES
  );
  const maxFileBytes = resolveByteBound(
    input.maxFileBytes,
    DESKTOP_RESUME_BUFFERING_DEFAULTS.MAX_FILE_BYTES
  );

  if (!Number.isFinite(input.fileSize) || input.fileSize < minFileBytes) {
    return false;
  }

  return input.fileSize <= maxFileBytes;
};

export const decidePersistenceStrategy = ({
  isIOS,
  isSafari,
  preferBrowserDownload,
  supportsNativeFs,
  supportsStreamSaver,
  supportsIndexedDb,
  fileSize,
  indexedDbThresholdBytes,
  hasResumeCheckpoint,
  preferIndexedDbBuffering,
  desktopIndexedDbMinBytes,
  desktopIndexedDbMaxBytes,
}: PersistenceStrategyInput): PersistenceStrategy => {
  if (preferBrowserDownload) {
    if ((isIOS || isSafari) && supportsIndexedDb && fileSize >= indexedDbThresholdBytes) {
      return 'indexeddb-buffer';
    }

    return 'memory-blob';
  }

  if (
    shouldBufferDesktopFileForResume({
      isIOS,
      isSafari,
      supportsIndexedDb,
      fileSize,
      hasResumeCheckpoint,
      preferIndexedDbBuffering,
      minFileBytes: desktopIndexedDbMinBytes,
      maxFileBytes: desktopIndexedDbMaxBytes,
    })
  ) {
    return 'indexeddb-buffer';
  }

  if (!isIOS && !isSafari && supportsNativeFs) {
    return 'native-fs';
  }

  if ((isIOS || isSafari) && supportsIndexedDb && fileSize >= indexedDbThresholdBytes) {
    return 'indexeddb-buffer';
  }

  if (!isIOS && !isSafari && supportsStreamSaver) {
    return 'stream-saver';
  }

  return 'memory-blob';
};
