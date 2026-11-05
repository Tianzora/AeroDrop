import { getRelativePathFileName, normalizeRelativePath, normalizeRelativePathSegments } from './relativePath.ts';

export type ReceivedFileCompletionState =
  | 'pending'
  | 'receiving'
  | 'completed'
  | 'failed';

export type ReceivedFileSaveState =
  | 'pending'
  | 'writing'
  | 'staged'
  | 'direct-saved'
  | 'save-queued'
  | 'failed';

export type ReceivedFileStorageKind =
  | 'none'
  | 'directory-direct'
  | 'memory-blob'
  | 'memory'
  | 'indexeddb-buffer'
  | 'indexeddb'
  | 'save-queue';

export type ReceivedFileStorage =
  | { kind: 'none' }
  | {
      kind: 'directory-direct';
      rootDirectoryName?: string;
      resolvedPath: string;
      committedBytes: number;
    }
  | {
      kind: 'memory-blob' | 'memory';
      chunkCount?: number;
    }
  | {
      kind: 'indexeddb-buffer' | 'indexeddb';
      sessionId: string;
      fileIndex: number;
      chunkCount: number;
    }
  | {
      kind: 'save-queue';
      queuedAt: number;
    };

export interface ReceivedFileHashState {
  algorithm: 'crc32';
  expected?: string;
  actual?: string;
  hashedBytes: number;
  verified: boolean;
}

export interface ReceivedFileResumeState {
  committedBytes: number;
  canResume: boolean;
}

export type ReceivedFileManifestStatus =
  | 'pending'
  | 'receiving'
  | 'staged'
  | 'saved-direct'
  | 'failed';

export interface ReceivedFileManifestEntry {
  fileIndex: number;
  fileName: string;
  relativePath: string;
  pathSegments: string[];
  fileSize: number;
  fileType: string;
  bytesReceived: number;
  bytesPersisted: number;
  completionState: ReceivedFileCompletionState;
  saveState: ReceivedFileSaveState;
  status: ReceivedFileManifestStatus;
  transferComplete: boolean;
  storageKind: ReceivedFileStorageKind;
  storage: ReceivedFileStorage;
  stagedBlob?: Blob;
  hash?: ReceivedFileHashState;
  resume?: ReceivedFileResumeState;
}

export interface ReceivedFileManifestSnapshot {
  readonly entries: ReadonlyArray<ReceivedFileManifestEntry>;
}

export interface RegisterReceivedFileInput {
  fileIndex: number;
  fileName: string;
  relativePath?: string;
  fileSize: number;
  fileType: string;
}

export interface UpdateReceivedFileProgressInput {
  fileIndex: number;
  bytesReceived?: number;
  bytesPersisted?: number;
  completionState?: ReceivedFileCompletionState;
  saveState?: ReceivedFileSaveState;
  status?: ReceivedFileManifestStatus;
  storage?: ReceivedFileStorage;
  hash?: ReceivedFileHashState;
  resume?: ReceivedFileResumeState;
}

export interface MarkReceivedFileCompletedInput {
  fileIndex: number;
  bytesReceived?: number;
  bytesPersisted?: number;
  saveState?: ReceivedFileSaveState;
  storage?: ReceivedFileStorage;
  hash?: Omit<ReceivedFileHashState, 'verified'>;
  resume?: ReceivedFileResumeState;
}

export interface ReceivedFileManifest {
  reset: () => void;
  seedFromMetadata: (
    files: Array<{
      name: string;
      size: number;
      type: string;
      lastModified: number;
    }>
  ) => void;
  registerFile: (input: RegisterReceivedFileInput) => ReceivedFileManifestEntry;
  markReceiving: (
    fileIndex: number,
    fileName: string,
    fileSize: number,
    fileType: string,
    relativePath?: string
  ) => ReceivedFileManifestEntry;
  updateProgress: (input: UpdateReceivedFileProgressInput) => ReceivedFileManifestEntry;
  markCompleted: (input: MarkReceivedFileCompletedInput) => ReceivedFileManifestEntry;
  markStaged: (
    fileIndex: number,
    options: {
      storageKind: Extract<ReceivedFileStorageKind, 'memory-blob' | 'memory' | 'indexeddb-buffer' | 'indexeddb'>;
      blob: Blob;
      storage?: ReceivedFileStorage;
    }
  ) => ReceivedFileManifestEntry;
  markSavedDirect: (
    fileIndex: number,
    options?: {
      rootDirectoryName?: string;
      resolvedPath?: string;
      committedBytes?: number;
    }
  ) => ReceivedFileManifestEntry;
  getEntry: (fileIndex: number) => ReceivedFileManifestEntry | null;
  getEntries: () => ReceivedFileManifestEntry[];
  getStagedEntries: () => ReceivedFileManifestEntry[];
  getSavedCount: () => number;
  getSnapshot: () => ReceivedFileManifestSnapshot;
}

export const normalizeReceivedFileRelativePath = normalizeRelativePath;

const MAX_PATH_DEDUPE_SUFFIX = 1000;

const splitExtension = (fileName: string): { stem: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { stem: fileName, extension: '' };
  }

  return { stem: fileName.slice(0, dotIndex), extension: fileName.slice(dotIndex) };
};

/**
 * peer 可以给两个不同的 fileIndex 送同一个相对路径（例如把两个不同目录下的同名文件一起拖进来，
 * 发送端只能用 basename 当相对路径）。落盘时两者会命中同一个文件句柄、后一个覆盖前一个，
 * 而按 fileIndex 记账的 savedCount 仍然显示“全部成功”，属于静默数据丢失。
 * 这里在扩展名前追加 ` (2)` / ` (3)`，让每个 fileIndex 独占一个路径。
 * 冲突判定不区分大小写，因为 Windows/macOS 的目标文件系统也不区分。
 */
const resolveUniqueRelativePath = (
  snapshot: ReceivedFileManifestSnapshot,
  fileIndex: number,
  normalizedPath: string
): string => {
  const takenPaths = new Set(
    snapshot.entries
      .filter((entry) => entry.fileIndex !== fileIndex)
      .map((entry) => entry.relativePath.toLowerCase())
  );

  if (!takenPaths.has(normalizedPath.toLowerCase())) {
    return normalizedPath;
  }

  const segments = normalizedPath.split('/');
  const parentSegments = segments.slice(0, -1);
  const { stem, extension } = splitExtension(getRelativePathFileName(normalizedPath));

  for (let suffix = 2; suffix <= MAX_PATH_DEDUPE_SUFFIX; suffix += 1) {
    const candidate = [...parentSegments, `${stem} (${suffix})${extension}`].join('/');
    if (!takenPaths.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  throw new Error(`RECEIVED_FILE_NAME_CONFLICT:${normalizedPath}`);
};

const getStatusForEntry = (
  completionState: ReceivedFileCompletionState,
  saveState: ReceivedFileSaveState
): ReceivedFileManifestStatus => {
  if (saveState === 'direct-saved') {
    return 'saved-direct';
  }
  if (saveState === 'staged') {
    return 'staged';
  }
  if (completionState === 'failed' || saveState === 'failed') {
    return 'failed';
  }
  if (completionState === 'receiving' || saveState === 'writing') {
    return 'receiving';
  }
  return 'pending';
};

const normalizeHash = (
  hash?: Omit<ReceivedFileHashState, 'verified'> | ReceivedFileHashState
): ReceivedFileHashState | undefined => {
  if (!hash) {
    return undefined;
  }

  const expected = hash.expected?.toLowerCase();
  const actual = hash.actual?.toLowerCase();

  return {
    algorithm: hash.algorithm,
    expected,
    actual,
    hashedBytes: Math.max(0, hash.hashedBytes),
    verified:
      typeof expected === 'string' &&
      typeof actual === 'string' &&
      expected === actual,
  };
};

const emptySnapshot = (): ReceivedFileManifestSnapshot => ({
  entries: [],
});

const getEntryFromSnapshot = (
  snapshot: ReceivedFileManifestSnapshot,
  fileIndex: number
): ReceivedFileManifestEntry | undefined =>
  snapshot.entries.find((entry) => entry.fileIndex === fileIndex);

const replaceEntryInSnapshot = (
  snapshot: ReceivedFileManifestSnapshot,
  nextEntry: ReceivedFileManifestEntry
): ReceivedFileManifestSnapshot => {
  const currentEntries = snapshot.entries.filter(
    (entry) => entry.fileIndex !== nextEntry.fileIndex
  );

  return {
    entries: [...currentEntries, nextEntry].sort(
      (left, right) => left.fileIndex - right.fileIndex
    ),
  };
};

const requireEntry = (
  snapshot: ReceivedFileManifestSnapshot,
  fileIndex: number
): ReceivedFileManifestEntry => {
  const entry = getEntryFromSnapshot(snapshot, fileIndex);
  if (!entry) {
    throw new Error(`RECEIVED_FILE_NOT_FOUND:${fileIndex}`);
  }
  return entry;
};

const registerEntry = (
  snapshot: ReceivedFileManifestSnapshot,
  input: RegisterReceivedFileInput
): ReceivedFileManifestSnapshot => {
  const relativePath = resolveUniqueRelativePath(
    snapshot,
    input.fileIndex,
    normalizeReceivedFileRelativePath(input.relativePath ?? input.fileName)
  );
  const pathSegments = normalizeRelativePathSegments(relativePath);
  const existing = getEntryFromSnapshot(snapshot, input.fileIndex);
  const completionState = existing?.completionState ?? 'pending';
  const saveState = existing?.saveState ?? 'pending';

  return replaceEntryInSnapshot(snapshot, {
    fileIndex: input.fileIndex,
    fileName: getRelativePathFileName(relativePath),
    relativePath,
    pathSegments,
    fileSize: Math.max(0, input.fileSize),
    fileType: input.fileType,
    bytesReceived: existing?.bytesReceived ?? 0,
    bytesPersisted: existing?.bytesPersisted ?? 0,
    completionState,
    saveState,
    status: existing?.status ?? getStatusForEntry(completionState, saveState),
    transferComplete: existing?.transferComplete ?? false,
    storageKind: existing?.storageKind ?? 'none',
    storage: existing?.storage ?? { kind: 'none' },
    stagedBlob: existing?.stagedBlob,
    hash: existing?.hash,
    resume: existing?.resume,
  });
};

const updateEntryProgress = (
  snapshot: ReceivedFileManifestSnapshot,
  input: UpdateReceivedFileProgressInput
): ReceivedFileManifestSnapshot => {
  const existing = requireEntry(snapshot, input.fileIndex);
  const completionState = input.completionState ?? existing.completionState;
  const saveState = input.saveState ?? existing.saveState;
  const storage = input.storage ?? existing.storage;

  return replaceEntryInSnapshot(snapshot, {
    ...existing,
    bytesReceived:
      typeof input.bytesReceived === 'number'
        ? Math.max(0, input.bytesReceived)
        : existing.bytesReceived,
    bytesPersisted:
      typeof input.bytesPersisted === 'number'
        ? Math.max(0, input.bytesPersisted)
        : existing.bytesPersisted,
    completionState,
    saveState,
    status: input.status ?? getStatusForEntry(completionState, saveState),
    storageKind: storage.kind,
    storage,
    hash: input.hash ?? existing.hash,
    resume: input.resume ?? existing.resume,
  });
};

const completeEntry = (
  snapshot: ReceivedFileManifestSnapshot,
  input: MarkReceivedFileCompletedInput
): ReceivedFileManifestSnapshot => {
  const existing = requireEntry(snapshot, input.fileIndex);
  const saveState = input.saveState ?? existing.saveState;
  const storage = input.storage ?? existing.storage;

  return replaceEntryInSnapshot(snapshot, {
    ...existing,
    bytesReceived:
      typeof input.bytesReceived === 'number'
        ? Math.max(0, input.bytesReceived)
        : Math.max(existing.bytesReceived, existing.fileSize),
    bytesPersisted:
      typeof input.bytesPersisted === 'number'
        ? Math.max(0, input.bytesPersisted)
        : Math.max(existing.bytesPersisted, existing.fileSize),
    completionState: 'completed',
    saveState,
    status: getStatusForEntry('completed', saveState),
    transferComplete: true,
    storageKind: storage.kind,
    storage,
    hash: normalizeHash(input.hash) ?? existing.hash,
    resume: input.resume ?? existing.resume,
  });
};

export const createReceivedFileManifest = (): ReceivedFileManifest => {
  let snapshot = emptySnapshot();

  const updateSnapshot = (nextSnapshot: ReceivedFileManifestSnapshot) => {
    snapshot = nextSnapshot;
  };

  return {
    reset: () => {
      snapshot = emptySnapshot();
    },

    seedFromMetadata: (files) => {
      let nextSnapshot = emptySnapshot();
      files.forEach((file, fileIndex) => {
        nextSnapshot = registerEntry(nextSnapshot, {
          fileIndex,
          // registerEntry 会按归一化（含去重后的）相对路径重算展示名。
          fileName: file.name,
          relativePath: file.name,
          fileSize: file.size,
          fileType: file.type || 'application/octet-stream',
        });
      });
      updateSnapshot(nextSnapshot);
    },

    registerFile: (input) => {
      updateSnapshot(registerEntry(snapshot, input));
      return requireEntry(snapshot, input.fileIndex);
    },

    markReceiving: (fileIndex, fileName, fileSize, fileType, relativePath) => {
      const nextSnapshot = updateEntryProgress(
        registerEntry(snapshot, {
          fileIndex,
          fileName,
          relativePath: relativePath ?? fileName,
          fileSize,
          fileType,
        }),
        {
          fileIndex,
          completionState: 'receiving',
          saveState: 'writing',
        }
      );
      updateSnapshot(nextSnapshot);
      return requireEntry(snapshot, fileIndex);
    },

    updateProgress: (input) => {
      updateSnapshot(updateEntryProgress(snapshot, input));
      return requireEntry(snapshot, input.fileIndex);
    },

    markCompleted: (input) => {
      updateSnapshot(completeEntry(snapshot, input));
      return requireEntry(snapshot, input.fileIndex);
    },

    markStaged: (fileIndex, options) => {
      const existing = requireEntry(snapshot, fileIndex);
      const storage =
        options.storage ??
        (options.storageKind === 'indexeddb' || options.storageKind === 'indexeddb-buffer'
          ? {
              kind: options.storageKind,
              sessionId: 'pending-session',
              fileIndex,
              chunkCount: 0,
            }
          : {
              kind: options.storageKind,
              chunkCount: 0,
            });

      updateSnapshot(
        replaceEntryInSnapshot(snapshot, {
          ...existing,
          saveState: 'staged',
          status: 'staged',
          storageKind: options.storageKind,
          storage,
          stagedBlob: options.blob,
        })
      );

      return requireEntry(snapshot, fileIndex);
    },

    markSavedDirect: (fileIndex, options) => {
      const existing = requireEntry(snapshot, fileIndex);
      const resolvedPath = existing.relativePath;
      updateSnapshot(
        replaceEntryInSnapshot(snapshot, {
          ...existing,
          completionState: 'completed',
          saveState: 'direct-saved',
          status: 'saved-direct',
          transferComplete: true,
          storageKind: 'directory-direct',
          storage: {
            kind: 'directory-direct',
            rootDirectoryName: options?.rootDirectoryName,
            resolvedPath: options?.resolvedPath ?? resolvedPath,
            committedBytes:
              typeof options?.committedBytes === 'number'
                ? Math.max(0, options.committedBytes)
                : Math.max(existing.bytesPersisted, existing.fileSize),
          },
          stagedBlob: undefined,
        })
      );

      return requireEntry(snapshot, fileIndex);
    },

    getEntry: (fileIndex) => getEntryFromSnapshot(snapshot, fileIndex) ?? null,

    getEntries: () => [...snapshot.entries],

    getStagedEntries: () =>
      snapshot.entries.filter(
        (entry) => entry.saveState === 'staged' && entry.stagedBlob instanceof Blob
      ),

    getSavedCount: () =>
      snapshot.entries.filter(
        (entry) => entry.saveState === 'staged' || entry.saveState === 'direct-saved'
      ).length,

    getSnapshot: () => ({
      entries: [...snapshot.entries],
    }),
  };
};
