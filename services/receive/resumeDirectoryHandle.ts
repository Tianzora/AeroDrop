export type DirectoryHandleResumeSource = 'cache' | 'persisted' | 'picker';

export interface ResolvedDirectoryHandle {
  handle: FileSystemDirectoryHandle;
  source: DirectoryHandleResumeSource;
}

export interface DirectoryHandleResumeDeps {
  /** 本会话内已经授权过的目录（内存缓存）。 */
  getCachedHandle: () => Promise<FileSystemDirectoryHandle | null>;
  /** 上次会话持久化下来的目录句柄（可能已失效）。 */
  loadPersistedHandle: () => Promise<FileSystemDirectoryHandle | null>;
  /** 申请/确认读写权限；旧浏览器没有 requestPermission 时按已授权处理。 */
  ensureWritePermission: (handle: FileSystemDirectoryHandle) => Promise<boolean>;
  /** 兜底：让用户重新选目录。 */
  pickDirectory: () => Promise<FileSystemDirectoryHandle | null>;
}

/**
 * 刷新后续传要重新拿到保存目录。优先用上一次会话持久化的句柄（Chrome 允许把
 * FileSystemDirectoryHandle 存进 IndexedDB，并在用户手势里 requestPermission 恢复），
 * 这样用户只点一次「继续下载」就能续写；只有句柄失效时才弹目录选择框。
 */
export const resolveDirectoryHandleForResume = async (
  deps: DirectoryHandleResumeDeps
): Promise<ResolvedDirectoryHandle | null> => {
  const cached = await deps.getCachedHandle().catch(() => null);
  if (cached) {
    return { handle: cached, source: 'cache' };
  }

  const persisted = await deps.loadPersistedHandle().catch(() => null);
  if (persisted) {
    const granted = await deps.ensureWritePermission(persisted).catch(() => false);
    if (granted) {
      return { handle: persisted, source: 'persisted' };
    }
  }

  const picked = await deps.pickDirectory().catch(() => null);
  if (picked) {
    return { handle: picked, source: 'picker' };
  }

  return null;
};
