import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceivedFileManifest } from './receivedFileManifest.ts';

test('seeds entries from metadata and normalizes relative paths', () => {
  const manifest = createReceivedFileManifest();

  manifest.seedFromMetadata([
    {
      name: 'folder\\nested/file.txt',
      size: 10,
      type: 'text/plain',
      lastModified: 0,
    },
  ]);

  const entry = manifest.getEntry(0);
  assert.ok(entry);
  assert.equal(entry?.relativePath, 'folder/nested/file.txt');
  assert.equal(entry?.fileName, 'file.txt');
});

test('marks staged blobs and saved-direct files independently', () => {
  const manifest = createReceivedFileManifest();
  manifest.seedFromMetadata([
    {
      name: 'one.txt',
      size: 3,
      type: 'text/plain',
      lastModified: 0,
    },
    {
      name: 'two.txt',
      size: 4,
      type: 'text/plain',
      lastModified: 0,
    },
  ]);

  manifest.markReceiving(0, 'one.txt', 3, 'text/plain');
  manifest.markStaged(0, {
    storageKind: 'memory-blob',
    blob: new Blob(['one']),
  });
  manifest.markReceiving(1, 'two.txt', 4, 'text/plain');
  manifest.markSavedDirect(1);

  assert.equal(manifest.getStagedEntries().length, 1);
  assert.equal(manifest.getSavedCount(), 2);
  assert.equal(manifest.getEntry(1)?.status, 'saved-direct');
});

test('tracks progress, resume state, and verified hash metadata for direct saves', () => {
  const manifest = createReceivedFileManifest();

  manifest.registerFile({
    fileIndex: 4,
    fileName: 'video.mp4',
    relativePath: 'captures\\2026/video.mp4',
    fileSize: 1024,
    fileType: 'video/mp4',
  });

  manifest.updateProgress({
    fileIndex: 4,
    bytesReceived: 768,
    bytesPersisted: 512,
    completionState: 'receiving',
    saveState: 'writing',
    storage: {
      kind: 'directory-direct',
      rootDirectoryName: 'AeroDrop',
      resolvedPath: 'captures/2026/video.mp4',
      committedBytes: 512,
    },
    resume: {
      committedBytes: 512,
      canResume: true,
    },
  });

  manifest.markCompleted({
    fileIndex: 4,
    bytesReceived: 1024,
    bytesPersisted: 1024,
    saveState: 'direct-saved',
    storage: {
      kind: 'directory-direct',
      rootDirectoryName: 'AeroDrop',
      resolvedPath: 'captures/2026/video.mp4',
      committedBytes: 1024,
    },
    hash: {
      algorithm: 'crc32',
      expected: 'deadbeef',
      actual: 'DEADBEEF',
      hashedBytes: 1024,
    },
  });

  const entry = manifest.getEntry(4);
  assert.ok(entry);
  assert.equal(entry?.relativePath, 'captures/2026/video.mp4');
  assert.equal(entry?.bytesReceived, 1024);
  assert.equal(entry?.bytesPersisted, 1024);
  assert.equal(entry?.saveState, 'direct-saved');
  assert.equal(entry?.transferComplete, true);
  assert.deepEqual(entry?.resume, {
    committedBytes: 512,
    canResume: true,
  });
  assert.deepEqual(entry?.hash, {
    algorithm: 'crc32',
    expected: 'deadbeef',
    actual: 'deadbeef',
    hashedBytes: 1024,
    verified: true,
  });
});

test('rejects unsafe relative paths when registering metadata', () => {
  const manifest = createReceivedFileManifest();

  assert.throws(
    () =>
      manifest.registerFile({
        fileIndex: 8,
        fileName: 'secret.txt',
        relativePath: '../secret.txt',
        fileSize: 1,
        fileType: 'text/plain',
      }),
    /RELATIVE_PATH_TRAVERSAL/
  );
});

test('de-duplicates identical relative paths across file indexes', () => {
  const manifest = createReceivedFileManifest();

  manifest.seedFromMetadata([
    { name: 'report.pdf', size: 10, type: 'application/pdf', lastModified: 0 },
    { name: 'report.pdf', size: 20, type: 'application/pdf', lastModified: 0 },
    { name: 'report.pdf', size: 30, type: 'application/pdf', lastModified: 0 },
  ]);

  assert.equal(manifest.getEntry(0)?.relativePath, 'report.pdf');
  assert.equal(manifest.getEntry(1)?.relativePath, 'report (2).pdf');
  assert.equal(manifest.getEntry(2)?.relativePath, 'report (3).pdf');
  assert.equal(manifest.getEntry(1)?.fileName, 'report (2).pdf');
  assert.equal(manifest.getEntry(2)?.fileName, 'report (3).pdf');
  assert.equal(manifest.getEntries().length, 3);
});

test('de-duplicates nested paths without dropping the parent directory or the extension', () => {
  const manifest = createReceivedFileManifest();

  manifest.registerFile({
    fileIndex: 0,
    fileName: 'photos/cover.tar.gz',
    relativePath: 'photos/cover.tar.gz',
    fileSize: 1,
    fileType: 'application/gzip',
  });
  manifest.registerFile({
    fileIndex: 1,
    fileName: 'photos/cover.tar.gz',
    relativePath: 'photos/cover.tar.gz',
    fileSize: 1,
    fileType: 'application/gzip',
  });
  manifest.registerFile({
    fileIndex: 2,
    fileName: 'README',
    relativePath: 'README',
    fileSize: 1,
    fileType: 'text/plain',
  });
  manifest.registerFile({
    fileIndex: 3,
    fileName: 'README',
    relativePath: 'README',
    fileSize: 1,
    fileType: 'text/plain',
  });

  assert.equal(manifest.getEntry(1)?.relativePath, 'photos/cover.tar (2).gz');
  assert.equal(manifest.getEntry(3)?.relativePath, 'README (2)');
  assert.deepEqual(manifest.getEntry(1)?.pathSegments, ['photos', 'cover.tar (2).gz']);
});

test('keeps the de-duplicated path stable when the same file index registers again', () => {
  const manifest = createReceivedFileManifest();

  manifest.seedFromMetadata([
    { name: 'same.txt', size: 10, type: 'text/plain', lastModified: 0 },
    { name: 'same.txt', size: 20, type: 'text/plain', lastModified: 0 },
  ]);

  const firstPath = manifest.getEntry(1)?.relativePath;
  manifest.markReceiving(1, 'same.txt', 20, 'text/plain');
  assert.equal(manifest.getEntry(1)?.relativePath, firstPath);
  assert.equal(manifest.getEntry(1)?.relativePath, 'same (2).txt');

  manifest.markReceiving(0, 'same.txt', 10, 'text/plain');
  assert.equal(manifest.getEntry(0)?.relativePath, 'same.txt');
  assert.equal(manifest.getEntry(1)?.relativePath, 'same (2).txt');
});

test('treats case-only differences as conflicts because target filesystems are case-insensitive', () => {
  const manifest = createReceivedFileManifest();

  manifest.seedFromMetadata([
    { name: 'Photo.PNG', size: 10, type: 'image/png', lastModified: 0 },
    { name: 'photo.png', size: 20, type: 'image/png', lastModified: 0 },
  ]);

  assert.equal(manifest.getEntry(0)?.relativePath, 'Photo.PNG');
  assert.equal(manifest.getEntry(1)?.relativePath, 'photo (2).png');
});
