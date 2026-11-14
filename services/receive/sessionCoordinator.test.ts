import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReceiveSessionCoordinator,
  type ReceiveSessionCoordinatorOptions,
} from './sessionCoordinator';

/**
 * 这个模块的价值全在「出问题之后怎么收尾」：文件长度/字节数/哈希三种不一致各自
 * 走自动修复，收尾要么把多文件导出成压缩包、要么逐文件落盘之后才 markCompleted。
 * 以前它整块被登记进覆盖率白名单，理由是「需要真实 IndexedDB/OPFS」——但真正
 * 需要 IO 的部分都是注入回调，所以这里用一个记录调用的假 options 把分支钉住。
 */

type Call = { name: string; args: unknown[] };

const createOptions = (
  overrides: Partial<ReceiveSessionCoordinatorOptions> = {}
): { options: ReceiveSessionCoordinatorOptions; calls: Call[] } => {
  const calls: Call[] = [];
  const tracker =
    (name: string, value: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return value;
    };

  const options: ReceiveSessionCoordinatorOptions = {
    awaitPendingFileFinalize: async (reason: string) => {
      calls.push({ name: 'awaitPendingFileFinalize', args: [reason] });
      return true;
    },
    isIOS: false,
    isSafari: false,
    isBrowserDownloadPreferred: () => false,
    supportsStreamSaver: false,
    indexedDbThresholdBytes: 1024,
    getMetadataFileCount: () => 1,
    getFileStartPersistenceCapabilities: () => {
      calls.push({ name: 'getFileStartPersistenceCapabilities', args: [] });
      return { canUseNativeFs: false, usePreparedNativeWriter: false, directSaveMode: 'none' };
    },
    supportsIndexedDb: () => false,
    setTransferActive: tracker('setTransferActive'),
    isTransferActive: () => true,
    isStreaming: () => false,
    isIndexedDbBuffering: () => false,
    setIndexedDbBuffering: tracker('setIndexedDbBuffering'),
    notifyIndexedDbBufferingEnabled: tracker('notifyIndexedDbBufferingEnabled'),
    hasRetainedCurrentFileData: () => false,
    abortStreams: async () => {
      calls.push({ name: 'abortStreams', args: [] });
    },
    resetIncomingFileBuffers: tracker('resetIncomingFileBuffers'),
    awaitWriteQueue: async () => {
      calls.push({ name: 'awaitWriteQueue', args: [] });
    },
    deleteIndexedDbChunksForFile: async (fileIndex: number) => {
      calls.push({ name: 'deleteIndexedDbChunksForFile', args: [fileIndex] });
    },
    prepareFilePersistenceTarget: async (args) => {
      calls.push({ name: 'prepareFilePersistenceTarget', args: [args.fileIndex] });
    },
    setCurrentFileState: tracker('setCurrentFileState'),
    resetFileHasher: async () => {
      calls.push({ name: 'resetFileHasher', args: [] });
      return true;
    },
    getCurrentFileIndex: () => 0,
    getCurrentFileName: () => 'report.pdf',
    getCurrentFileSize: () => 100,
    getReceivedSize: () => 100,
    getHashedBytes: () => 100,
    finalizeHasher: async () => {
      calls.push({ name: 'finalizeHasher', args: [] });
      return 'deadbeef';
    },
    requestAutoRepair: async (fileIndex: number, reason: string) => {
      calls.push({ name: 'requestAutoRepair', args: [fileIndex, reason] });
      return false;
    },
    clearPendingAutoRepairFile: tracker('clearPendingAutoRepairFile'),
    getPendingAutoRepairFile: () => null,
    hasPendingAutoRepair: () => false,
    finalizeCurrentFilePersistence: async (fileName: string) => {
      calls.push({ name: 'finalizeCurrentFilePersistence', args: [fileName] });
    },
    shouldStageFilesForArchive: () => false,
    stageCurrentFileForArchive: async () => {
      calls.push({ name: 'stageCurrentFileForArchive', args: [] });
      return true;
    },
    finalizeArchiveDownload: async () => {
      calls.push({ name: 'finalizeArchiveDownload', args: [] });
      return true;
    },
    saveCurrentFile: async () => {
      calls.push({ name: 'saveCurrentFile', args: [] });
      return true;
    },
    markCurrentFilePersisted: tracker('markCurrentFilePersisted'),
    getExpectedFiles: () => 1,
    getSavedFiles: () => 1,
    sendTransferProgress: tracker('sendTransferProgress'),
    sendAllFilesReceived: tracker('sendAllFilesReceived'),
    markCompleted: tracker('markCompleted'),
    failTransferPersistence: tracker('failTransferPersistence'),
  };

  return { options: { ...options, ...overrides }, calls };
};

const names = (calls: Call[]): string[] => calls.map((call) => call.name);
const find = (calls: Call[], name: string): Call | undefined =>
  calls.find((call) => call.name === name);
const fileStart = { fileIndex: 0, fileName: 'report.pdf', fileSize: 100, fileType: 'application/pdf' };

test('handleFileStart：先把上一个文件收尾，再重置缓冲、准备落盘目标并回报 0 进度', async () => {
  const { options, calls } = createOptions();
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileStart(fileStart);

  assert.deepEqual(find(calls, 'awaitPendingFileFinalize')?.args, ['FILE_START']);
  assert.ok(names(calls).includes('abortStreams'));
  assert.ok(names(calls).includes('resetIncomingFileBuffers'));
  assert.deepEqual(find(calls, 'prepareFilePersistenceTarget')?.args, [0]);
  assert.equal(names(calls).includes('setTransferActive'), true);
  assert.deepEqual(find(calls, 'sendTransferProgress')?.args, [0]);
  assert.equal(find(calls, 'failTransferPersistence'), undefined);
});

test('handleFileStart：同一文件的续传不重置缓冲，并清掉等待中的自动修复标记', async () => {
  const { options, calls } = createOptions({
    hasRetainedCurrentFileData: () => true,
    getPendingAutoRepairFile: () => 0,
  });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileStart(fileStart);

  assert.equal(names(calls).includes('abortStreams'), false);
  assert.equal(names(calls).includes('resetIncomingFileBuffers'), false);
  assert.equal(names(calls).includes('prepareFilePersistenceTarget'), false);
  assert.deepEqual(find(calls, 'clearPendingAutoRepairFile')?.args, [0]);
});

test('handleFileStart：等待收尾失败时直接放弃，不进入传输态', async () => {
  const { options, calls } = createOptions({ awaitPendingFileFinalize: async () => false });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileStart(fileStart);

  assert.equal(names(calls).includes('setTransferActive'), false);
});

test('handleFileStart：iOS 大文件初始化 IDB 缓冲失败时报错并停住', async () => {
  const { options, calls } = createOptions({
    isIOS: true,
    supportsIndexedDb: () => true,
    indexedDbThresholdBytes: 1,
    awaitWriteQueue: async () => {
      throw new Error('quota exceeded');
    },
  });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileStart(fileStart);

  assert.deepEqual(find(calls, 'failTransferPersistence')?.args, ['无法初始化 iOS 大文件缓存，请重试']);
  assert.equal(names(calls).includes('prepareFilePersistenceTarget'), false);
});

test('handleFileStart：哈希器初始化失败时报错', async () => {
  const { options, calls } = createOptions({ resetFileHasher: async () => false });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileStart(fileStart);

  assert.deepEqual(find(calls, 'failTransferPersistence')?.args, ['文件校验初始化失败，请重试']);
  assert.equal(names(calls).includes('setCurrentFileState'), false);
});

test('handleFileComplete：文件长度不一致会请求自动修复，且不再继续落盘', async () => {
  const { options, calls } = createOptions({ getReceivedSize: () => 99 });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({ fileIndex: 0 });

  const repair = find(calls, 'requestAutoRepair');
  assert.deepEqual(repair?.args, [0, '文件长度不一致（99/100）']);
  assert.equal(names(calls).includes('finalizeHasher'), false);
  assert.equal(names(calls).includes('markCurrentFilePersisted'), false);
});

test('handleFileComplete：字节数不一致会请求自动修复（payload 的 hashedBytes 优先）', async () => {
  const { options, calls } = createOptions();
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({
    fileIndex: 0,
    hashAlgorithm: 'crc32',
    fileHash: 'deadbeef',
    hashedBytes: 120,
  });

  assert.deepEqual(find(calls, 'requestAutoRepair')?.args, [0, '字节数不一致（100/120）']);
  assert.equal(names(calls).includes('finalizeHasher'), false);
});

test('handleFileComplete：哈希不一致会请求自动修复（大小写不敏感地比较）', async () => {
  const { options, calls } = createOptions({ finalizeHasher: async () => 'cafebabe' });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({
    fileIndex: 0,
    hashAlgorithm: 'crc32',
    fileHash: 'DEADBEEF',
    hashedBytes: 100,
  });

  assert.deepEqual(find(calls, 'requestAutoRepair')?.args, [0, '哈希不一致（cafebabe != DEADBEEF）']);
  assert.equal(names(calls).includes('markCurrentFilePersisted'), false);
});

test('handleFileComplete：哈希计算抛错时报错而不是当成不一致', async () => {
  const { options, calls } = createOptions({
    finalizeHasher: async () => {
      throw new Error('worker terminated');
    },
  });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({
    fileIndex: 0,
    hashAlgorithm: 'crc32',
    fileHash: 'deadbeef',
    hashedBytes: 100,
  });

  assert.deepEqual(find(calls, 'failTransferPersistence')?.args, ['文件校验计算失败，请重试']);
  assert.equal(names(calls).includes('requestAutoRepair'), false);
});

test('handleFileComplete：校验通过 + 流式落盘时收尾当前文件', async () => {
  const { options, calls } = createOptions({
    isStreaming: () => true,
    finalizeHasher: async () => 'deadbeef',
  });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({
    fileIndex: 0,
    hashAlgorithm: 'crc32',
    fileHash: 'deadbeef',
    hashedBytes: 100,
  });

  assert.deepEqual(find(calls, 'finalizeCurrentFilePersistence')?.args, ['report.pdf']);
  assert.equal(names(calls).includes('markCurrentFilePersisted'), false);
});

test('handleFileComplete：多文件归档模式暂存成功才算落盘', async () => {
  const { options, calls } = createOptions({ shouldStageFilesForArchive: () => true });
  const coordinator = createReceiveSessionCoordinator(options);
  await coordinator.handleFileComplete({ fileIndex: 0 });
  assert.ok(names(calls).includes('stageCurrentFileForArchive'));
  assert.deepEqual(find(calls, 'markCurrentFilePersisted')?.args, ['report.pdf']);

  const failed = createOptions({
    shouldStageFilesForArchive: () => true,
    stageCurrentFileForArchive: async () => false,
  });
  await createReceiveSessionCoordinator(failed.options).handleFileComplete({ fileIndex: 0 });
  assert.equal(names(failed.calls).includes('markCurrentFilePersisted'), false);
});

test('handleFileComplete：直接保存失败时不标记为已落盘', async () => {
  let saveCalls = 0;
  const { options, calls } = createOptions({
    saveCurrentFile: async () => {
      saveCalls += 1;
      return false;
    },
  });
  const coordinator = createReceiveSessionCoordinator(options);

  await coordinator.handleFileComplete({ fileIndex: 0 });

  assert.equal(saveCalls, 1);
  assert.equal(names(calls).includes('markCurrentFilePersisted'), false);
});

test('handleFileComplete：传输态已结束时什么都不做', async () => {
  const { options, calls } = createOptions({ isTransferActive: () => false });
  await createReceiveSessionCoordinator(options).handleFileComplete({ fileIndex: 0 });
  assert.deepEqual(names(calls), []);
});

test('handleAllFilesComplete：等待自动修复时不宣布完成', async () => {
  const { options, calls } = createOptions({ hasPendingAutoRepair: () => true });
  await createReceiveSessionCoordinator(options).handleAllFilesComplete();
  assert.equal(names(calls).includes('markCompleted'), false);
});

test('handleAllFilesComplete：仍有待收尾文件时不宣布完成', async () => {
  const { options, calls } = createOptions({ awaitPendingFileFinalize: async () => false });
  await createReceiveSessionCoordinator(options).handleAllFilesComplete();
  assert.equal(names(calls).includes('awaitWriteQueue'), false);
  assert.equal(names(calls).includes('markCompleted'), false);
});

test('handleAllFilesComplete：保存数量不足时报错并停在原地', async () => {
  const { options, calls } = createOptions({ getExpectedFiles: () => 3, getSavedFiles: () => 2 });
  await createReceiveSessionCoordinator(options).handleAllFilesComplete();
  assert.deepEqual(find(calls, 'failTransferPersistence')?.args, ['文件保存不完整（2/3），请重试']);
  assert.equal(names(calls).includes('markCompleted'), false);
});

test('handleAllFilesComplete：多文件导出失败时报错', async () => {
  const { options, calls } = createOptions({
    shouldStageFilesForArchive: () => true,
    getExpectedFiles: () => 2,
    getSavedFiles: () => 2,
    finalizeArchiveDownload: async () => false,
  });
  await createReceiveSessionCoordinator(options).handleAllFilesComplete();
  assert.deepEqual(find(calls, 'failTransferPersistence')?.args, ['多文件导出失败，请重试']);
  assert.equal(names(calls).includes('markCompleted'), false);
});

test('handleAllFilesComplete：齐全且导出成功后宣布完成', async () => {
  const { options, calls } = createOptions({
    shouldStageFilesForArchive: () => true,
    getExpectedFiles: () => 2,
    getSavedFiles: () => 2,
  });
  await createReceiveSessionCoordinator(options).handleAllFilesComplete();

  assert.deepEqual(find(calls, 'awaitPendingFileFinalize')?.args, ['ALL_FILES_COMPLETE']);
  assert.ok(names(calls).includes('finalizeArchiveDownload'));
  assert.ok(names(calls).includes('sendAllFilesReceived'));
  assert.ok(names(calls).includes('markCompleted'));
  assert.equal(find(calls, 'failTransferPersistence'), undefined);
});
