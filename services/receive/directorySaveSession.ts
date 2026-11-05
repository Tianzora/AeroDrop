import { type ReceiveStreamingTarget } from './streamingWriter.ts';
import { normalizeRelativePath } from './relativePath.ts';

export interface DirectorySaveSessionWritableFileStream {
  write: (data: BufferSource | Blob | string | Uint8Array) => Promise<void>;
  seek?: (position: number) => Promise<void>;
  truncate: (size: number) => Promise<void>;
  close: () => Promise<void>;
  // FileSystemWritableFileStream 继承自 WritableStream，正常实现都有 abort。
  abort?: (reason?: unknown) => Promise<void>;
}

export interface DirectorySaveSessionFileHandle {
  readonly kind: 'file';
  readonly name: string;
  createWritable?: (options?: unknown) => Promise<DirectorySaveSessionWritableFileStream>;
  getFile?: () => Promise<Pick<File, 'size'>>;
}

export interface DirectorySaveSessionDirectoryHandle {
  readonly kind?: 'directory';
  readonly name: string;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<DirectorySaveSessionDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<DirectorySaveSessionFileHandle>;
}

export interface DirectorySaveSessionResolvedFile {
  relativePath: string;
  pathSegments: string[];
  parentDirectoryPath: string;
  directoryHandle: DirectorySaveSessionDirectoryHandle;
  fileHandle: DirectorySaveSessionFileHandle;
}

export interface LegacyResolvedFileHandle {
  normalizedRelativePath: string;
  fileName: string;
  directoryHandle: DirectorySaveSessionDirectoryHandle;
  fileHandle: DirectorySaveSessionFileHandle;
}

export interface DirectorySaveSession {
  attachRootDirectory: (rootDirectoryHandle: DirectorySaveSessionDirectoryHandle) => void;
  getRootDirectoryName: () => string;
  resolveFile: (relativePath: string) => Promise<DirectorySaveSessionResolvedFile>;
  resolveFileHandle: (relativePath: string) => Promise<LegacyResolvedFileHandle>;
  createStreamingTarget: (
    relativePath: string,
    options?: {
      keepExistingData?: boolean;
      startOffset?: number;
    }
  ) => Promise<ReceiveStreamingTarget>;
}

const sanitizeLegacyRelativePath = (relativePath: string): string => {
  // 兼容旧入口：先按段 trim 并去掉空段，再统一走严格消毒（.. / . / 绝对路径一律拒绝）。
  // 以前这里会静默丢弃 `..` 段，导致同一路径在“首写”和“续传重开”两个入口解析到不同文件。
  const preCleanedPath = relativePath
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');

  return normalizeRelativePath(preCleanedPath);
};

const createDirectoryResolver = (getRootDirectoryHandle: () => DirectorySaveSessionDirectoryHandle) => {
  const directoryCache = new Map<string, DirectorySaveSessionDirectoryHandle>();
  const fileCache = new Map<string, DirectorySaveSessionFileHandle>();

  const resetCaches = () => {
    directoryCache.clear();
    fileCache.clear();
  };

  const resolveNormalizedPath = async (
    normalizedPath: string
  ): Promise<DirectorySaveSessionResolvedFile> => {
    const rootDirectoryHandle = getRootDirectoryHandle();
    if (!directoryCache.has('')) {
      directoryCache.set('', rootDirectoryHandle);
    }

    const pathSegments = normalizedPath.split('/');
    const fileName = pathSegments[pathSegments.length - 1];
    const directorySegments = pathSegments.slice(0, -1);
    const parentDirectoryPath = directorySegments.join('/');

    let currentDirectory = rootDirectoryHandle;
    let currentDirectoryPath = '';

    for (const segment of directorySegments) {
      currentDirectoryPath = currentDirectoryPath
        ? `${currentDirectoryPath}/${segment}`
        : segment;

      const cachedDirectory = directoryCache.get(currentDirectoryPath);
      if (cachedDirectory) {
        currentDirectory = cachedDirectory;
        continue;
      }

      const nextDirectory = await currentDirectory.getDirectoryHandle(segment, {
        create: true,
      });
      directoryCache.set(currentDirectoryPath, nextDirectory);
      currentDirectory = nextDirectory;
    }

    const cachedFileHandle = fileCache.get(normalizedPath);
    const fileHandle =
      cachedFileHandle ??
      (await currentDirectory.getFileHandle(fileName, {
        create: true,
      }));

    if (!cachedFileHandle) {
      fileCache.set(normalizedPath, fileHandle);
    }

    return {
      relativePath: normalizedPath,
      pathSegments,
      parentDirectoryPath,
      directoryHandle: currentDirectory,
      fileHandle,
    };
  };

  return {
    resetCaches,
    resolveNormalizedPath,
  };
};

export const createDirectorySaveSession = (options?: {
  rootDirectoryHandle?: DirectorySaveSessionDirectoryHandle;
}): DirectorySaveSession => {
  let rootDirectoryHandle = options?.rootDirectoryHandle ?? null;

  const ensureRootDirectoryHandle = (): DirectorySaveSessionDirectoryHandle => {
    if (!rootDirectoryHandle) {
      throw new Error('DIRECTORY_SAVE_SESSION_ROOT_UNSET');
    }
    return rootDirectoryHandle;
  };

  const resolver = createDirectoryResolver(ensureRootDirectoryHandle);

  return {
    attachRootDirectory: (nextRootDirectoryHandle) => {
      rootDirectoryHandle = nextRootDirectoryHandle;
      resolver.resetCaches();
    },

    getRootDirectoryName: () => ensureRootDirectoryHandle().name,

    resolveFile: async (relativePath) => {
      const normalizedPath = normalizeRelativePath(relativePath);
      return resolver.resolveNormalizedPath(normalizedPath);
    },

    resolveFileHandle: async (relativePath) => {
      const normalizedRelativePath = sanitizeLegacyRelativePath(relativePath);
      const resolved = await resolver.resolveNormalizedPath(normalizedRelativePath);

      return {
        normalizedRelativePath,
        fileName: resolved.pathSegments[resolved.pathSegments.length - 1],
        directoryHandle: resolved.directoryHandle,
        fileHandle: resolved.fileHandle,
      };
    },

    createStreamingTarget: async (relativePath, options) => {
      const resolved = await resolver.resolveNormalizedPath(
        normalizeRelativePath(relativePath)
      );

      if (!resolved.fileHandle.createWritable) {
        throw new Error('DIRECTORY_SAVE_TARGET_UNWRITABLE');
      }

      const writable = await resolved.fileHandle.createWritable({
        keepExistingData: options?.keepExistingData === true,
      });
      const resumeOffset = Math.max(0, options?.startOffset ?? 0);

      if (resumeOffset > 0) {
        if (typeof writable.seek !== 'function') {
          throw new Error('DIRECTORY_SAVE_TARGET_UNSEEKABLE');
        }
        await writable.seek(resumeOffset);
      }

      return {
        kind: 'native-fs',
        write: async (chunk) => {
          await writable.write(chunk);
        },
        close: async () => {
          await writable.close();
        },
        abort: async () => {
          if (typeof writable.abort !== 'function') {
            return;
          }
          await writable.abort();
        },
        truncate: async (size) => {
          await writable.truncate(size);
        },
        verifyCommittedBytes: async (expectedBytes) => {
          if (!resolved.fileHandle.getFile) {
            return false;
          }

          const file = await resolved.fileHandle.getFile();
          return file.size === expectedBytes;
        },
      } satisfies ReceiveStreamingTarget;
    },
  };
};
