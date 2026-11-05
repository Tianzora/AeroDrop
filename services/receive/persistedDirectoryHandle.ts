export interface PersistedDirectoryHandleStore {
  save: (handle: FileSystemDirectoryHandle) => Promise<void>;
  load: () => Promise<FileSystemDirectoryHandle | null>;
  clear: () => Promise<void>;
}

export interface PersistedDirectoryHandleStoreOptions {
  indexedDb?: IDBFactory | null;
  dbName?: string;
  storeName?: string;
  key?: string;
}

const DB_VERSION = 1;

const openDatabase = (factory: IDBFactory, dbName: string, storeName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });

const withStore = async <T>(
  factory: IDBFactory,
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<any>
): Promise<T | null> => {
  const db = await openDatabase(factory, dbName, storeName);
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      transaction.onerror = () => reject(transaction.error ?? new Error('indexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
};

/**
 * 把保存目录的 FileSystemDirectoryHandle 持久化到 IndexedDB：句柄可结构化克隆，
 * 刷新后仍能拿回来，配合用户手势里的 requestPermission 就能直接续写。
 * 任何一步失败都静默降级为「没有持久化句柄」，不影响正常流程。
 */
export const createPersistedDirectoryHandleStore = (
  options: PersistedDirectoryHandleStoreOptions = {}
): PersistedDirectoryHandleStore => {
  const dbName = options.dbName ?? 'aerodrop-handles';
  const storeName = options.storeName ?? 'directory';
  const key = options.key ?? 'last-save-directory';
  const factory = options.indexedDb ?? (typeof indexedDB === 'undefined' ? null : indexedDB);

  return {
    save: async (handle) => {
      if (!factory) return;
      try {
        await withStore<FileSystemDirectoryHandle>(factory, dbName, storeName, 'readwrite', (store) =>
          store.put(handle, key)
        );
      } catch {
        // 句柄不能克隆（旧浏览器）或 IDB 被禁用时忽略。
      }
    },
    load: async () => {
      if (!factory) return null;
      try {
        return await withStore<FileSystemDirectoryHandle>(factory, dbName, storeName, 'readonly', (store) =>
          store.get(key)
        );
      } catch {
        return null;
      }
    },
    clear: async () => {
      if (!factory) return;
      try {
        await withStore<undefined>(factory, dbName, storeName, 'readwrite', (store) =>
          store.delete(key)
        );
      } catch {
        // 忽略。
      }
    },
  };
};
