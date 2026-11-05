import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReceivePersistenceAdapter,
  type ReceiveBatchPersistenceRequest,
} from './persistenceAdapter.ts';
import { RECEIVE_STORAGE } from '../../constants/transfer.ts';

class MockElement {
  id = '';
  className = '';
  tagName: string;
  style = { cssText: '' };
  textContent = '';
  href = '';
  download = '';
  onclick: null | (() => void) = null;
  parentElement: MockElement | null = null;
  children: MockElement[] = [];
  clickCount = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
    return child;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  get childElementCount() {
    return this.children.length;
  }

  click() {
    this.clickCount += 1;
    this.onclick?.();
  }
}

class MockDocument {
  body = new MockElement('body');

  createElement(tagName: string) {
    return new MockElement(tagName);
  }

  getElementById(id: string) {
    const search = (element: MockElement): MockElement | null => {
      if (element.id === id) {
        return element;
      }

      for (const child of element.children) {
        const found = search(child);
        if (found) {
          return found;
        }
      }

      return null;
    };

    return search(this.body);
  }
}

const createWindowStub = () => ({
  addEventListener: () => {},
  removeEventListener: () => {},
}) as unknown as Window & typeof globalThis;

const createBatchRequest = (): ReceiveBatchPersistenceRequest => ({
  archiveName: 'received-files',
  files: [
    {
      relativePath: 'photos/cover.jpg',
      open: async () => new Blob(['cover'], { type: 'image/jpeg' }),
    },
    {
      relativePath: 'notes/summary.txt',
      open: async () => new Blob(['summary'], { type: 'text/plain' }),
    },
  ],
});

test('queues multiple iOS prepared downloads inside a single modal', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let currentFile = { name: 'first.bin', type: 'application/octet-stream' };

  const adapter = createReceivePersistenceAdapter({
    isIOS: true,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 4,
    getCurrentFileSize: () => 4,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => currentFile,
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [new Uint8Array([1, 2, 3, 4]).buffer],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: (url) => {
        revokedUrls.push(url);
      },
    },
  });

  assert.equal(await adapter.saveCurrentFile(), true);
  currentFile = { name: 'second.bin', type: 'application/octet-stream' };
  assert.equal(await adapter.saveCurrentFile(), true);

  const modal = (documentRef as unknown as MockDocument).getElementById('ios-download-modal');
  const list = (documentRef as unknown as MockDocument).getElementById('ios-download-list');

  assert.ok(modal);
  assert.ok(list);
  assert.equal(list?.childElementCount, 2);
  assert.deepEqual(createdUrls, ['blob:1', 'blob:2']);
  assert.deepEqual(revokedUrls, []);
});

test('desktop fallback auto-clicks a download anchor once', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 4,
    getCurrentFileSize: () => 4,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => ({ name: 'desktop.bin', type: 'application/octet-stream' }),
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [new Uint8Array([1, 2, 3, 4]).buffer],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  assert.equal(await adapter.saveCurrentFile(), true);
  assert.deepEqual(createdUrls, ['blob:1']);
  assert.equal((documentRef as unknown as MockDocument).body.childElementCount, 0);
});

test('stages current file for archive export and clears runtime buffers', async () => {
  const staged: Array<{ fileName: string; relativePath: string; storageKind: string }> = [];
  let resetMemoryCalls = 0;

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 4,
    getCurrentFileSize: () => 4,
    getCurrentFileIndex: () => 3,
    getCurrentFileInfo: () => ({ name: 'folder/item.bin', type: 'application/octet-stream' }),
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [new Uint8Array([1, 2, 3, 4]).buffer],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {
      resetMemoryCalls += 1;
    },
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    stageCurrentFileForArchive: (entry) => {
      staged.push({
        fileName: entry.fileName,
        relativePath: entry.relativePath,
        storageKind: entry.storageKind,
      });
    },
    documentRef: new MockDocument() as unknown as Document,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => 'blob:1',
      revokeObjectURL: () => {},
    },
  });

  assert.equal(await adapter.stageCurrentFileForArchive(), true);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.fileName, 'folder/item.bin');
  assert.equal(staged[0]?.relativePath, 'folder/item.bin');
  assert.equal(staged[0]?.storageKind, 'memory-blob');
  assert.equal(resetMemoryCalls, 1);
});

test('falls back to individual saves when archive export fails', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];
  let cleared = 0;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const adapter = createReceivePersistenceAdapter({
      isIOS: true,
      isSafari: false,
      isTransferActive: () => true,
      getReceivedSize: () => 0,
      getCurrentFileSize: () => 0,
      getCurrentFileIndex: () => 0,
      getCurrentFileInfo: () => null,
      isIndexedDbBuffering: () => false,
      getMemoryChunks: () => [],
      readIndexedDbBlobsForFile: async () => [],
      deleteIndexedDbChunksForFile: async () => {},
      resetIndexedDbFileState: () => {},
      resetMemoryFileState: () => {},
      failTransferPersistence: (message) => {
        throw new Error(message);
      },
      getArchiveEntries: () => [
        {
          relativePath: 'folder/a.txt',
          fileName: 'a.txt',
          blob: new Blob(['a']),
        },
        {
          relativePath: 'folder/b.txt',
          fileName: 'b.txt',
          blob: new Blob(['b']),
        },
      ],
      exportArchiveBlob: async () => {
        throw new Error('ZIP_FAILED');
      },
      clearArchiveEntries: () => {
        cleared += 1;
      },
      documentRef,
      windowRef: createWindowStub(),
      urlRef: {
        createObjectURL: () => {
          const next = `blob:${createdUrls.length + 1}`;
          createdUrls.push(next);
          return next;
        },
        revokeObjectURL: () => {},
      },
    });

    assert.equal(await adapter.exportArchiveEntries('bundle.zip'), false);
    assert.equal(await adapter.saveArchiveEntriesIndividually(), true);
    assert.deepEqual(createdUrls, ['blob:1', 'blob:2']);
    assert.equal(cleared, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('saveReceivedFiles skips the in-memory archive once staged bytes exceed the limit', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];
  let archiveCalls = 0;
  let cleared = 0;
  const fakeBlob = (size: number) => ({ size } as unknown as Blob);

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 0,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => null,
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    getArchiveEntries: () => [
      {
        relativePath: 'folder/a.bin',
        fileName: 'a.bin',
        blob: fakeBlob(600 * 1024 * 1024),
      },
      {
        relativePath: 'folder/b.bin',
        fileName: 'b.bin',
        blob: fakeBlob(600 * 1024 * 1024),
      },
    ],
    exportArchiveBlob: async () => {
      archiveCalls += 1;
      throw new Error('SHOULD_NOT_ARCHIVE');
    },
    clearArchiveEntries: () => {
      cleared += 1;
    },
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  const result = await adapter.saveReceivedFiles({
    archiveName: 'bundle.zip',
    files: [
      { relativePath: 'folder/a.bin', downloadName: 'a.bin', open: async () => fakeBlob(600 * 1024 * 1024) },
      { relativePath: 'folder/b.bin', downloadName: 'b.bin', open: async () => fakeBlob(600 * 1024 * 1024) },
    ],
  });

  assert.equal(result.mode, 'per-file-save-queue');
  assert.equal(result.fileCount, 2);
  assert.equal(archiveCalls, 0);
  assert.equal(cleared, 1);
  assert.deepEqual(createdUrls, ['blob:1', 'blob:2']);
});

test('saveReceivedFiles downloads one archive when archive export succeeds', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];
  const archiveCalls: ReceiveBatchPersistenceRequest[] = [];

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 4,
    getCurrentFileSize: () => 4,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => ({ name: 'desktop.bin', type: 'application/octet-stream' }),
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [new Uint8Array([1, 2, 3, 4]).buffer],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    createArchiveExportSession: () => ({
      exportArchive: async (request) => {
        archiveCalls.push(request as ReceiveBatchPersistenceRequest);
        return {
          archiveName: 'received-files.zip',
          archive: new Blob(['zip'], { type: 'application/zip' }),
          fileCount: request.files.length,
        };
      },
      exportZip: async () => new Blob(['zip'], { type: 'application/zip' }),
    }),
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  const result = await adapter.saveReceivedFiles(createBatchRequest());

  assert.deepEqual(archiveCalls.map((request) => request.archiveName), ['received-files']);
  assert.equal(result.mode, 'archive-export');
  assert.equal(result.fileCount, 2);
  assert.equal(result.archiveName, 'received-files.zip');
  assert.deepEqual(createdUrls, ['blob:1']);
  assert.equal((documentRef as unknown as MockDocument).body.childElementCount, 0);
});

test('saveReceivedFiles falls back to per-file queue when archive export fails', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];

  const adapter = createReceivePersistenceAdapter({
    isIOS: true,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 4,
    getCurrentFileSize: () => 4,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => ({ name: 'ios.bin', type: 'application/octet-stream' }),
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [new Uint8Array([1, 2, 3, 4]).buffer],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    createArchiveExportSession: () => ({
      exportArchive: async () => {
        throw new Error('zip export failed');
      },
      exportZip: async () => {
        throw new Error('zip export failed');
      },
    }),
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  const result = await adapter.saveReceivedFiles(createBatchRequest());
  const list = (documentRef as unknown as MockDocument).getElementById('ios-download-list');

  assert.equal(result.mode, 'per-file-save-queue');
  assert.equal(result.fileCount, 2);
  assert.equal(result.archiveErrorMessage, 'zip export failed');
  assert.equal(list?.childElementCount, 2);
  assert.deepEqual(createdUrls, ['blob:1', 'blob:2']);
});

test('saveArchiveEntriesIndividually queues every file for manual save on desktop', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];
  let cleared = 0;

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 0,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => null,
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    getArchiveEntries: () => [
      { relativePath: 'folder/a.txt', fileName: 'a.txt', blob: new Blob(['a']) },
      { relativePath: 'folder/b.txt', fileName: 'b.txt', blob: new Blob(['b']) },
    ],
    clearArchiveEntries: () => {
      cleared += 1;
    },
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  assert.equal(await adapter.saveArchiveEntriesIndividually(), true);
  assert.equal(cleared, 1);
  assert.deepEqual(createdUrls, ['blob:1', 'blob:2']);

  const list = (documentRef as unknown as MockDocument).getElementById('ios-download-list');
  assert.ok(list);
  assert.equal(list?.childElementCount, 2);
});

test('saveArchiveEntriesIndividually still auto-downloads a single entry', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const createdUrls: string[] = [];

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 0,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => null,
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    getArchiveEntries: () => [
      { relativePath: 'folder/a.txt', fileName: 'a.txt', blob: new Blob(['a']) },
    ],
    clearArchiveEntries: () => {},
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => {
        const next = `blob:${createdUrls.length + 1}`;
        createdUrls.push(next);
        return next;
      },
      revokeObjectURL: () => {},
    },
  });

  assert.equal(await adapter.saveArchiveEntriesIndividually(), true);
  assert.deepEqual(createdUrls, ['blob:1']);
  assert.equal((documentRef as unknown as MockDocument).body.childElementCount, 0);
});

test('exportArchiveEntries skips the in-memory zip once staged bytes exceed the limit', async () => {
  const documentRef = new MockDocument() as unknown as Document;
  const oversizedBlob = { size: RECEIVE_STORAGE.ARCHIVE_MAX_IN_MEMORY_BYTES } as unknown as Blob;
  let archiveExportCalls = 0;
  let cleared = 0;

  const adapter = createReceivePersistenceAdapter({
    isIOS: false,
    isSafari: false,
    isTransferActive: () => true,
    getReceivedSize: () => 0,
    getCurrentFileSize: () => 0,
    getCurrentFileIndex: () => 0,
    getCurrentFileInfo: () => null,
    isIndexedDbBuffering: () => false,
    getMemoryChunks: () => [],
    readIndexedDbBlobsForFile: async () => [],
    deleteIndexedDbChunksForFile: async () => {},
    resetIndexedDbFileState: () => {},
    resetMemoryFileState: () => {},
    failTransferPersistence: (message) => {
      throw new Error(message);
    },
    getArchiveEntries: () => [
      { relativePath: 'big/a.bin', fileName: 'a.bin', blob: oversizedBlob },
      { relativePath: 'big/b.bin', fileName: 'b.bin', blob: oversizedBlob },
    ],
    exportArchiveBlob: async () => {
      archiveExportCalls += 1;
      throw new Error('SHOULD_NOT_EXPORT');
    },
    clearArchiveEntries: () => {
      cleared += 1;
    },
    documentRef,
    windowRef: createWindowStub(),
    urlRef: {
      createObjectURL: () => 'blob:1',
      revokeObjectURL: () => {},
    },
  });

  assert.equal(await adapter.exportArchiveEntries('bundle.zip'), true);
  assert.equal(archiveExportCalls, 0);
  assert.equal(cleared, 1);

  const list = (documentRef as unknown as MockDocument).getElementById('ios-download-list');
  assert.ok(list);
  assert.equal(list?.childElementCount, 2);
});
