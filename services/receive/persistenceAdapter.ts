import {
  createArchiveExportSession,
  type ArchiveExportRequest,
  type ArchiveExportSession,
  type ArchiveExportSource,
} from './archiveExportSession.ts';
import { RECEIVE_STORAGE } from '../../constants/transfer.ts';
import { logDebug } from '../diagnostics.ts';

type StagedArchiveEntry = {
  relativePath: string;
  fileName: string;
  blob: Blob;
};

type CurrentFileBlob = {
  blob: Blob;
  finalName: string;
  finalType: string;
  storageKind: 'memory-blob' | 'indexeddb-buffer';
};

export interface ReceivePersistenceAdapterOptions {
  isIOS: boolean;
  isSafari: boolean;
  isTransferActive: () => boolean;
  getReceivedSize: () => number;
  getCurrentFileSize: () => number;
  getCurrentFileIndex: () => number;
  getCurrentFileInfo: () => { name: string; type: string } | null;
  isIndexedDbBuffering: () => boolean;
  getMemoryChunks: () => ArrayBuffer[];
  readIndexedDbBlobsForFile: (fileIndex: number) => Promise<Blob[]>;
  deleteIndexedDbChunksForFile: (fileIndex: number) => Promise<void>;
  resetIndexedDbFileState: () => void;
  resetMemoryFileState: () => void;
  failTransferPersistence: (message: string) => void;
  getArchiveEntries?: () => StagedArchiveEntry[];
  stageCurrentFileForArchive?: (entry: {
    fileIndex: number;
    relativePath: string;
    fileName: string;
    type: string;
    blob: Blob;
    storageKind: 'memory-blob' | 'indexeddb-buffer';
  }) => void;
  exportArchiveBlob?: (entries: Array<{ relativePath: string; blob: Blob }>) => Promise<Blob>;
  clearArchiveEntries?: () => void;
  createArchiveExportSession?: () => ArchiveExportSession;
  documentRef?: Document;
  windowRef?: Window & typeof globalThis;
  urlRef?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

export interface ReceiveBatchPersistenceFile extends ArchiveExportSource {
  downloadName?: string;
}

export interface ReceiveBatchPersistenceRequest extends ArchiveExportRequest {
  files: readonly ReceiveBatchPersistenceFile[];
}

export interface ReceiveBatchPersistenceResult {
  mode: 'archive-export' | 'per-file-save-queue';
  fileCount: number;
  archiveName?: string;
  archiveErrorMessage?: string;
}

export interface ReceivePersistenceAdapter {
  saveCurrentFile: () => Promise<boolean>;
  stageCurrentFileForArchive: () => Promise<boolean>;
  exportArchiveEntries: (archiveName?: string) => Promise<boolean>;
  saveArchiveEntriesIndividually: () => Promise<boolean>;
  saveReceivedFiles: (
    request: ReceiveBatchPersistenceRequest
  ) => Promise<ReceiveBatchPersistenceResult>;
  reset: () => void;
}

const scheduleBlobUrlRevokeAfterFocus = (
  win: Window & typeof globalThis,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
  url: string,
  opts?: { fallbackMs?: number; focusDelayMs?: number }
) => {
  const fallbackMs = opts?.fallbackMs ?? 5 * 60 * 1000;
  const focusDelayMs = opts?.focusDelayMs ?? 4000;
  let revoked = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let focusDelayTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanupListener = () => {
    win.removeEventListener('focus', onFocus);
  };

  const revokeNow = () => {
    if (revoked) return;
    revoked = true;
    cleanupListener();
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (focusDelayTimer) {
      clearTimeout(focusDelayTimer);
      focusDelayTimer = null;
    }
    urlApi.revokeObjectURL(url);
  };

  const onFocus = () => {
    if (revoked) return;
    if (focusDelayTimer) clearTimeout(focusDelayTimer);
    focusDelayTimer = setTimeout(() => {
      revokeNow();
    }, focusDelayMs);
    focusDelayTimer.unref?.();
  };

  win.addEventListener('focus', onFocus);
  fallbackTimer = setTimeout(() => {
    revokeNow();
  }, fallbackMs);
  fallbackTimer.unref?.();
};

type PreparedDownloadUi = {
  container: HTMLDivElement;
  list: HTMLDivElement;
};

const ensurePreparedDownloadUi = (doc: Document): PreparedDownloadUi => {
  const existing = doc.getElementById('ios-download-modal') as HTMLDivElement | null;
  const existingList = doc.getElementById('ios-download-list') as HTMLDivElement | null;
  if (existing && existingList) {
    return {
      container: existing,
      list: existingList,
    };
  }

  const downloadModal = doc.createElement('div');
  downloadModal.id = 'ios-download-modal';
  downloadModal.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8); z-index: 99999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 20px;
  `;

  const contentDiv = doc.createElement('div');
  contentDiv.style.cssText = 'background: white; padding: 24px; border-radius: 16px; max-width: 360px; width: 100%; text-align: center; box-sizing: border-box;';

  const title = doc.createElement('h3');
  title.style.cssText = 'margin: 0 0 12px; font-size: 18px; color: #1e293b;';
  title.textContent = '文件已准备就绪';

  const desc = doc.createElement('p');
  desc.style.cssText = 'margin: 0 0 16px; font-size: 13px; color: #64748b;';
  desc.textContent = '请逐个点击保存，下载完成后，此面板会自动清空';

  const list = doc.createElement('div');
  list.id = 'ios-download-list';
  list.style.cssText = 'display: flex; flex-direction: column; gap: 12px; max-height: 50vh; overflow-y: auto;';

  const closeBtn = doc.createElement('button');
  closeBtn.style.cssText = 'margin-top: 16px; background: none; border: none; color: #64748b; font-size: 14px; cursor: pointer;';
  closeBtn.textContent = '关闭';
  closeBtn.onclick = () => {
    if (list.childElementCount === 0) {
      downloadModal.remove();
    }
  };

  contentDiv.appendChild(title);
  contentDiv.appendChild(desc);
  contentDiv.appendChild(list);
  contentDiv.appendChild(closeBtn);
  downloadModal.appendChild(contentDiv);
  doc.body.appendChild(downloadModal);

  return {
    container: downloadModal,
    list,
  };
};

const queuePreparedFileForManualSave = (
  doc: Document,
  win: Window & typeof globalThis,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
  blob: Blob,
  fileName: string
) => {
  const url = urlApi.createObjectURL(blob);
  const { container, list } = ensurePreparedDownloadUi(doc);

  const item = doc.createElement('div');
  item.className = 'ios-download-item';
  item.style.cssText = 'border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; text-align: left;';

  const fileNameP = doc.createElement('p');
  fileNameP.style.cssText = 'margin: 0 0 12px; font-size: 14px; color: #334155; word-break: break-all;';
  fileNameP.textContent = fileName;

  const actions = doc.createElement('div');
  actions.style.cssText = 'display: flex; gap: 8px; align-items: center;';

  const downloadLink = doc.createElement('a');
  downloadLink.href = url;
  downloadLink.download = fileName;
  downloadLink.style.cssText = 'display: inline-block; flex: 1; background: #3b82f6; color: white; padding: 10px 14px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; text-align: center;';
  downloadLink.textContent = '保存文件';
  downloadLink.onclick = () => {
    setTimeout(() => {
      item.remove();
      if (list.childElementCount === 0) {
        container.remove();
      }
    }, 500);
    scheduleBlobUrlRevokeAfterFocus(win, urlApi, url, {
      fallbackMs: 10 * 60 * 1000,
      focusDelayMs: 5000,
    });
  };

  const cancelBtn = doc.createElement('button');
  cancelBtn.style.cssText = 'background: none; border: none; color: #64748b; font-size: 13px; cursor: pointer;';
  cancelBtn.textContent = '取消';
  cancelBtn.onclick = () => {
    item.remove();
    if (list.childElementCount === 0) {
      container.remove();
    }
    urlApi.revokeObjectURL(url);
  };

  actions.appendChild(downloadLink);
  actions.appendChild(cancelBtn);
  item.appendChild(fileNameP);
  item.appendChild(actions);
  list.appendChild(item);
};

const triggerBrowserDownload = (
  doc: Document,
  win: Window & typeof globalThis,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
  blob: Blob,
  fileName: string,
  isIOS: boolean,
  isSafari: boolean
) => {
  if (isIOS || isSafari) {
    queuePreparedFileForManualSave(doc, win, urlApi, blob, fileName);
    return;
  }

  const url = urlApi.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  scheduleBlobUrlRevokeAfterFocus(win, urlApi, url);
};

const getFallbackDownloadName = (relativePath: string, downloadName?: string): string => {
  if (downloadName?.trim()) {
    return downloadName.trim();
  }

  const normalized = relativePath.replace(/\\/g, '/').trim();
  const lastSegment = normalized.split('/').filter(Boolean).at(-1);
  return lastSegment || 'received-file.bin';
};

const ensureArchiveDownloadName = (archiveName?: string): string => {
  const trimmed = archiveName?.trim();
  if (!trimmed) {
    return `aerodrop-${Date.now().toString(36)}.zip`;
  }

  return trimmed.toLowerCase().endsWith('.zip') ? trimmed : `${trimmed}.zip`;
};

const readSourceAsBlob = async (source: Awaited<ReturnType<ArchiveExportSource['open']>>): Promise<Blob> => {
  if (source instanceof Blob) {
    return source;
  }

  return new Response(source).blob();
};

export const createReceivePersistenceAdapter = (
  options: ReceivePersistenceAdapterOptions
): ReceivePersistenceAdapter => {
  const doc = options.documentRef ?? document;
  const win = options.windowRef ?? window;
  const urlApi = options.urlRef ?? URL;
  let archiveExportSession: ArchiveExportSession | null = null;

  const getArchiveExportSession = () => {
    if (!archiveExportSession) {
      archiveExportSession = options.createArchiveExportSession
        ? options.createArchiveExportSession()
        : createArchiveExportSession();
    }

    return archiveExportSession;
  };

  const buildCurrentFileBlob = async (): Promise<CurrentFileBlob | null> => {
    if (!options.isTransferActive()) return null;
    if (options.getReceivedSize() === 0 && options.getCurrentFileSize() > 0) return null;

    const currentFileInfo = options.getCurrentFileInfo();
    const finalName = currentFileInfo?.name || `file_${Date.now()}.bin`;
    const finalType = currentFileInfo?.type || 'application/octet-stream';

    if (options.isIndexedDbBuffering()) {
      const fileIndex = options.getCurrentFileIndex();
      const blobs = await options.readIndexedDbBlobsForFile(fileIndex);
      if (blobs.length === 0 && options.getCurrentFileSize() > 0) {
        options.failTransferPersistence('iOS 缓冲文件为空，请重试传输');
        return null;
      }

      return {
        blob: new Blob(blobs, { type: finalType }),
        finalName,
        finalType,
        storageKind: 'indexeddb-buffer',
      };
    }

    return {
      blob: new Blob(options.getMemoryChunks(), { type: finalType }),
      finalName,
      finalType,
      storageKind: 'memory-blob',
    };
  };

  const exportArchive = async (
    request: ReceiveBatchPersistenceRequest
  ): Promise<{
    archive: Blob;
    archiveName: string;
    fileCount: number;
  }> => {
    if (options.exportArchiveBlob) {
      const blobs = await Promise.all(
        request.files.map(async (file) => ({
          relativePath: file.relativePath,
          blob: await readSourceAsBlob(await file.open()),
        }))
      );

      return {
        archive: await options.exportArchiveBlob(blobs),
        archiveName: ensureArchiveDownloadName(request.archiveName),
        fileCount: request.files.length,
      };
    }

    return getArchiveExportSession().exportArchive(request);
  };

  const saveCurrentFile = async (): Promise<boolean> => {
    try {
      const current = await buildCurrentFileBlob();
      if (!current) return false;

      triggerBrowserDownload(doc, win, urlApi, current.blob, current.finalName, options.isIOS, options.isSafari);
    } catch (error) {
      console.error('Save failed:', error);
      options.failTransferPersistence('浏览器保存失败，请检查下载权限后重试');
      return false;
    }

    if (options.isIndexedDbBuffering()) {
      try {
        await options.deleteIndexedDbChunksForFile(options.getCurrentFileIndex());
      } catch (error) {
        logDebug('warn', 'IndexedDB cleanup after save failed:', error);
      }
      options.resetIndexedDbFileState();
    }

    options.resetMemoryFileState();
    return true;
  };

  const stageCurrentFileForArchive = async (): Promise<boolean> => {
    if (!options.stageCurrentFileForArchive) {
      return false;
    }

    try {
      const current = await buildCurrentFileBlob();
      if (!current) return false;

      options.stageCurrentFileForArchive({
        fileIndex: options.getCurrentFileIndex(),
        relativePath: current.finalName,
        fileName: current.finalName,
        type: current.finalType,
        blob: current.blob,
        storageKind: current.storageKind,
      });
    } catch (error) {
      console.error('Stage for archive failed:', error);
      options.failTransferPersistence('文件暂存失败，请重试传输');
      return false;
    }

    if (options.isIndexedDbBuffering()) {
      try {
        await options.deleteIndexedDbChunksForFile(options.getCurrentFileIndex());
      } catch (error) {
        logDebug('warn', 'IndexedDB cleanup after staging failed:', error);
      }
      options.resetIndexedDbFileState();
    }

    options.resetMemoryFileState();
    return true;
  };

  const exportArchiveEntries = async (archiveName?: string): Promise<boolean> => {
    if (!options.getArchiveEntries) {
      return false;
    }

    const entries = options.getArchiveEntries();
    if (entries.length === 0) {
      return false;
    }

    const stagedBytes = entries.reduce((total, entry) => total + (entry.blob.size || 0), 0);
    if (stagedBytes > RECEIVE_STORAGE.ARCHIVE_MAX_IN_MEMORY_BYTES) {
      // 内存 zip 会把整份归档再复制一遍；暂存总量超限时直接降级为逐个保存，避免收完之后 OOM。
      logDebug('warn', 'Archive export skipped: staged bytes exceed the in-memory limit', {
        stagedBytes,
        limitBytes: RECEIVE_STORAGE.ARCHIVE_MAX_IN_MEMORY_BYTES,
      });
      return saveArchiveEntriesIndividually();
    }

    try {
      const archive = await exportArchive({
        archiveName: archiveName ?? ensureArchiveDownloadName(undefined),
        files: entries.map((entry) => ({
          relativePath: entry.relativePath,
          open: async () => entry.blob,
        })),
      });

      triggerBrowserDownload(
        doc,
        win,
        urlApi,
        archive.archive,
        archive.archiveName,
        options.isIOS,
        options.isSafari
      );
      options.clearArchiveEntries?.();
      return true;
    } catch (error) {
      logDebug('warn', 'Archive export failed:', error);
      return false;
    }
  };

  const saveArchiveEntriesIndividually = async (): Promise<boolean> => {
    if (!options.getArchiveEntries) {
      return false;
    }

    const entries = options.getArchiveEntries();
    if (entries.length === 0) {
      return false;
    }

    const [onlyEntry] = entries;
    if (onlyEntry && entries.length === 1) {
      triggerBrowserDownload(doc, win, urlApi, onlyEntry.blob, onlyEntry.fileName, options.isIOS, options.isSafari);
      options.clearArchiveEntries?.();
      return true;
    }

    // 多文件时在同一次用户手势里连点多个 <a download> 只会放行第一个，
    // 其余被浏览器静默拦截、而暂存 blob 又被清空 = 文件丢失。统一进手动保存列表让用户逐个点。
    for (const entry of entries) {
      queuePreparedFileForManualSave(doc, win, urlApi, entry.blob, entry.fileName);
    }

    options.clearArchiveEntries?.();
    return true;
  };

  const saveReceivedFiles = async (
    request: ReceiveBatchPersistenceRequest
  ): Promise<ReceiveBatchPersistenceResult> => {
    if (request.files.length === 0) {
      return {
        mode: 'per-file-save-queue',
        fileCount: 0,
      };
    }

    // 内存 zip 会同时驻留「全部暂存 Blob + 完整压缩包」，大目录到最后一刻会 OOM。
    // 超过上限时直接降级为逐个保存（手动保存列表），不再尝试打包。
    const stagedEntries = options.getArchiveEntries?.() ?? [];
    const stagedBytes = stagedEntries.reduce((total, entry) => total + (entry.blob?.size || 0), 0);
    if (stagedEntries.length > 1 && stagedBytes > RECEIVE_STORAGE.ARCHIVE_MAX_IN_MEMORY_BYTES) {
      const queued = await saveArchiveEntriesIndividually();
      if (queued) {
        return {
          mode: 'per-file-save-queue',
          fileCount: stagedEntries.length,
        };
      }
    }

    try {
      const archive = await exportArchive(request);
      triggerBrowserDownload(
        doc,
        win,
        urlApi,
        archive.archive,
        archive.archiveName,
        options.isIOS,
        options.isSafari
      );

      return {
        mode: 'archive-export',
        fileCount: archive.fileCount,
        archiveName: archive.archiveName,
      };
    } catch (error) {
      const archiveErrorMessage = error instanceof Error ? error.message : 'Archive export failed';

      for (const file of request.files) {
        const blob = await readSourceAsBlob(await file.open());
        triggerBrowserDownload(
          doc,
          win,
          urlApi,
          blob,
          getFallbackDownloadName(file.relativePath, file.downloadName),
          options.isIOS,
          options.isSafari
        );
      }

      return {
        mode: 'per-file-save-queue',
        fileCount: request.files.length,
        archiveErrorMessage,
      };
    }
  };

  return {
    saveCurrentFile,
    stageCurrentFileForArchive,
    exportArchiveEntries,
    saveArchiveEntriesIndividually,
    saveReceivedFiles,
    reset: () => {
      archiveExportSession = null;
      options.clearArchiveEntries?.();
    },
  };
};
