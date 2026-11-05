import { logDebug } from '../diagnostics.ts';

export interface ResumeCheckpoint {
  sessionId: string;
  metadataFingerprint: string;
  fileIndex: number;
  committedBytes: number;
  totalSize: number;
  updatedAt: number;
}

export interface ResumeCheckpointStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ResumeCheckpointOptions {
  storage?: ResumeCheckpointStorage | null;
  now?: () => number;
  ttlMs?: number;
  keyPrefix?: string;
}

export interface SaveResumeCheckpointInput {
  sessionId: string;
  metadataFingerprint: string;
  fileIndex: number;
  committedBytes: number;
  totalSize: number;
  updatedAt?: number;
}

export interface LoadResumeCheckpointRequest {
  sessionId: string;
  metadataFingerprint: string;
}

// 检查点只用来“记住上次停在哪”，丢失最多让用户重下一段，因此默认值取保守的 24h。
export const RESUME_CHECKPOINT_DEFAULTS = {
  KEY_PREFIX: 'aerodrop.resume-checkpoint.',
  TTL_MS: 24 * 60 * 60 * 1000,
  VERSION: 1,
} as const;

const STORED_RECORD_VERSION = RESUME_CHECKPOINT_DEFAULTS.VERSION;

type StoredResumeCheckpointRecord = {
  version: number;
  checkpoint: ResumeCheckpoint;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isValidCheckpointShape = (value: unknown): value is ResumeCheckpoint => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const checkpoint = value as Partial<ResumeCheckpoint>;

  return (
    isNonEmptyString(checkpoint.sessionId) &&
    isNonEmptyString(checkpoint.metadataFingerprint) &&
    isSafeNonNegativeInteger(checkpoint.fileIndex) &&
    isSafeNonNegativeInteger(checkpoint.committedBytes) &&
    isSafeNonNegativeInteger(checkpoint.totalSize) &&
    checkpoint.totalSize > 0 &&
    checkpoint.committedBytes <= checkpoint.totalSize &&
    isFiniteNumber(checkpoint.updatedAt)
  );
};

export interface ResumeMetadataFingerprintFile {
  name: string;
  size: number;
  type?: string;
  lastModified?: number;
}

/**
 * 同一接收会话可能被用于不同的文件批次；刷新后拿到的检查点必须先确认“还是这批文件”，
 * 否则会拿旧批次的偏移去续传新批次。指纹只看顺序敏感的文件清单，与网络/时间无关。
 */
export const createResumeMetadataFingerprint = (
  files: readonly ResumeMetadataFingerprintFile[]
): string => {
  const payload = files
    .map((file) => [file.name, file.size, file.type ?? '', file.lastModified ?? 0].join('|'))
    .join('\n');

  // FNV-1a 32 位：纯同步、无依赖，足够区分同一 sessionId 下的不同批次。
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `md-${files.length}-${hash.toString(36)}`;
};

export const createMemoryResumeCheckpointStorage = (
  initialEntries?: Iterable<readonly [string, string]>
): ResumeCheckpointStorage => {  const entries = new Map<string, string>(initialEntries ?? []);

  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const resolveDefaultStorage = (): ResumeCheckpointStorage | null => {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) {
      return null;
    }

    // Safari 私密窗口/被策略禁用时，访问 localStorage 本身就会抛，先探一次再交给调用方。
    localStorage.getItem(`${RESUME_CHECKPOINT_DEFAULTS.KEY_PREFIX}probe`);
    return localStorage;
  } catch {
    return null;
  }
};

const resolveStorage = (options?: ResumeCheckpointOptions): ResumeCheckpointStorage | null =>
  options?.storage === undefined ? resolveDefaultStorage() : options.storage;

const resolveTtlMs = (options?: ResumeCheckpointOptions): number => {
  const ttlMs = options?.ttlMs;
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
    return ttlMs;
  }

  return RESUME_CHECKPOINT_DEFAULTS.TTL_MS;
};

const resolveNow = (options?: ResumeCheckpointOptions): number => {
  const now = options?.now?.();
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
};

export const getResumeCheckpointKey = (
  sessionId: string,
  keyPrefix: string = RESUME_CHECKPOINT_DEFAULTS.KEY_PREFIX
): string => `${keyPrefix}${sessionId}`;

export const isResumeCheckpointExpired = (
  checkpoint: Pick<ResumeCheckpoint, 'updatedAt'>,
  nowMs: number,
  ttlMs: number = RESUME_CHECKPOINT_DEFAULTS.TTL_MS
): boolean => {
  if (!isFiniteNumber(nowMs) || !isFiniteNumber(checkpoint.updatedAt)) {
    return true;
  }

  const ageMs = nowMs - checkpoint.updatedAt;
  // 时钟回拨导致的负 age 不算过期（否则会误删刚写入的检查点）。
  return ageMs > ttlMs;
};

/**
 * 检查点里记录的“已落盘字节”只有在文件下标对得上时才有意义，且必须夹到文件长度内，
 * 否则续传会 seek 到文件末尾之后留下空洞。
 */
export const resolveCheckpointOffset = (
  checkpoint: ResumeCheckpoint | null | undefined,
  fileIndex: number,
  fileSize?: number
): number => {
  if (!checkpoint || checkpoint.fileIndex !== fileIndex) {
    return 0;
  }

  const committedBytes = isSafeNonNegativeInteger(checkpoint.committedBytes)
    ? checkpoint.committedBytes
    : 0;
  const upperBound =
    typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0
      ? Math.min(committedBytes, Math.floor(fileSize))
      : committedBytes;

  return Math.max(0, upperBound);
};

export const saveResumeCheckpoint = (
  input: SaveResumeCheckpointInput,
  options?: ResumeCheckpointOptions
): ResumeCheckpoint | null => {
  const checkpoint: ResumeCheckpoint = {
    sessionId: typeof input.sessionId === 'string' ? input.sessionId.trim() : '',
    metadataFingerprint:
      typeof input.metadataFingerprint === 'string' ? input.metadataFingerprint.trim() : '',
    fileIndex: input.fileIndex,
    committedBytes: input.committedBytes,
    totalSize: input.totalSize,
    updatedAt: isFiniteNumber(input.updatedAt) ? input.updatedAt : resolveNow(options),
  };

  if (!isValidCheckpointShape(checkpoint)) {
    logDebug('warn', '[resume-checkpoint] refused to persist an invalid checkpoint', {
      sessionId: input.sessionId,
      fileIndex: input.fileIndex,
      committedBytes: input.committedBytes,
      totalSize: input.totalSize,
    });
    return null;
  }

  const storage = resolveStorage(options);
  if (!storage) {
    return null;
  }

  const record: StoredResumeCheckpointRecord = {
    version: STORED_RECORD_VERSION,
    checkpoint,
  };

  try {
    storage.setItem(
      getResumeCheckpointKey(checkpoint.sessionId, options?.keyPrefix),
      JSON.stringify(record)
    );
    return checkpoint;
  } catch (error) {
    // 配额用尽/存储被禁用：检查点只是加速手段，不能影响传输本身。
    logDebug('warn', '[resume-checkpoint] failed to persist checkpoint', error);
    return null;
  }
};

export const loadResumeCheckpoint = (
  request: LoadResumeCheckpointRequest,
  options?: ResumeCheckpointOptions
): ResumeCheckpoint | null => {
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
  const metadataFingerprint =
    typeof request.metadataFingerprint === 'string' ? request.metadataFingerprint.trim() : '';

  if (!sessionId || !metadataFingerprint) {
    return null;
  }

  const storage = resolveStorage(options);
  if (!storage) {
    return null;
  }

  const key = getResumeCheckpointKey(sessionId, options?.keyPrefix);
  let raw: string | null = null;

  try {
    raw = storage.getItem(key);
  } catch (error) {
    logDebug('warn', '[resume-checkpoint] failed to read checkpoint', error);
    return null;
  }

  if (!raw) {
    return null;
  }

  const discard = (reason: string) => {
    logDebug('warn', `[resume-checkpoint] discarding checkpoint: ${reason}`);
    try {
      storage.removeItem(key);
    } catch (error) {
      logDebug('warn', '[resume-checkpoint] failed to discard checkpoint', error);
    }
    return null;
  };

  let record: StoredResumeCheckpointRecord;
  try {
    record = JSON.parse(raw) as StoredResumeCheckpointRecord;
  } catch {
    return discard('invalid json');
  }

  if (!record || typeof record !== 'object' || record.version !== STORED_RECORD_VERSION) {
    return discard('unsupported version');
  }

  const checkpoint = record.checkpoint;
  if (!isValidCheckpointShape(checkpoint)) {
    return discard('invalid shape');
  }

  if (checkpoint.sessionId !== sessionId) {
    return discard('session mismatch');
  }

  // 元数据指纹不匹配说明不是同一批文件，检查点不能用；保留记录交给 TTL 清理。
  if (checkpoint.metadataFingerprint !== metadataFingerprint) {
    return null;
  }

  if (isResumeCheckpointExpired(checkpoint, resolveNow(options), resolveTtlMs(options))) {
    return discard('expired');
  }

  return checkpoint;
};

export const clearResumeCheckpoint = (
  sessionId: string,
  options?: ResumeCheckpointOptions
): boolean => {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return false;
  }

  const storage = resolveStorage(options);
  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(getResumeCheckpointKey(normalizedSessionId, options?.keyPrefix));
    return true;
  } catch (error) {
    logDebug('warn', '[resume-checkpoint] failed to clear checkpoint', error);
    return false;
  }
};
