import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirectorySaveSession } from './directorySaveSession.ts';

class MockWritableFileStream {
  readonly writes: Uint8Array[] = [];
  readonly truncates: number[] = [];
  readonly seeks: number[] = [];
  closed = false;
  aborted = false;

  async write(data: BufferSource | Blob | string | Uint8Array) {
    if (typeof data === 'string') {
      this.writes.push(new TextEncoder().encode(data));
      return;
    }

    if (data instanceof Blob) {
      this.writes.push(new Uint8Array(await data.arrayBuffer()));
      return;
    }

    if (ArrayBuffer.isView(data)) {
      this.writes.push(
        new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      );
      return;
    }

    this.writes.push(new Uint8Array(data.slice(0)));
  }

  async truncate(size: number) {
    this.truncates.push(size);
  }

  async seek(position: number) {
    this.seeks.push(position);
  }

  async close() {
    this.closed = true;
  }

  async abort() {
    this.aborted = true;
  }
}

class MockFileHandle {
  lastWritable: MockWritableFileStream | null = null;
  currentSize = 0;
  lastCreateWritableOptions: unknown = null;

  constructor(public readonly name: string) {}

  async createWritable(options?: unknown) {
    const writable = new MockWritableFileStream();
    this.lastWritable = writable;
    this.lastCreateWritableOptions = options ?? null;
    return writable;
  }

  async getFile() {
    return {
      size: this.currentSize,
    } as File;
  }
}

class MockDirectoryHandle {
  readonly directories = new Map<string, MockDirectoryHandle>();
  readonly files = new Map<string, MockFileHandle>();

  constructor(public readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) {
      return existing as unknown as FileSystemDirectoryHandle;
    }
    if (!options?.create) {
      throw new Error('DIR_NOT_FOUND');
    }
    const created = new MockDirectoryHandle(name);
    this.directories.set(name, created);
    return created as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) {
      return existing as unknown as FileSystemFileHandle;
    }
    if (!options?.create) {
      throw new Error('FILE_NOT_FOUND');
    }
    const created = new MockFileHandle(name);
    this.files.set(name, created);
    return created as unknown as FileSystemFileHandle;
  }
}

test('creates nested directories and resolves a file handle', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession();
  session.attachRootDirectory(root as unknown as FileSystemDirectoryHandle);

  const result = await session.resolveFileHandle('photos/2026/cover.png');

  assert.equal(result.normalizedRelativePath, 'photos/2026/cover.png');
  assert.equal(result.fileName, 'cover.png');
  assert.equal((root.directories.get('photos')?.directories.get('2026')?.files.get('cover.png')?.name), 'cover.png');
});

test('rejects path traversal segments in the legacy entry point', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession();
  session.attachRootDirectory(root as unknown as FileSystemDirectoryHandle);

  // 以前这里会静默丢弃 `..` 段并解析成 'unsafe/file.txt'，导致续传重开和首写写到不同文件。
  await assert.rejects(
    () => session.resolveFileHandle('../unsafe/../../file.txt'),
    /RELATIVE_PATH_TRAVERSAL/
  );
});

test('strict resolution rejects traversal and absolute paths', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession({
    rootDirectoryHandle: root as unknown as FileSystemDirectoryHandle,
  });

  await assert.rejects(() => session.resolveFile('../unsafe.txt'), /RELATIVE_PATH_TRAVERSAL/);
  await assert.rejects(() => session.resolveFile('/unsafe.txt'), /RELATIVE_PATH_ABSOLUTE/);
});

test('creates a native-fs streaming target for a resolved file', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession({
    rootDirectoryHandle: root as unknown as FileSystemDirectoryHandle,
  });

  const target = await session.createStreamingTarget('docs/report.txt');
  await target.write(new Uint8Array([1, 2, 3]));

  const reportHandle = root.directories.get('docs')?.files.get('report.txt') as MockFileHandle;
  reportHandle.currentSize = 3;

  assert.equal(await target.verifyCommittedBytes?.(3), true);
  await target.truncate?.(0);
  await target.close();

  assert.deepEqual(
    reportHandle.lastWritable?.writes.map((chunk) => Array.from(chunk)),
    [[1, 2, 3]]
  );
  assert.deepEqual(reportHandle.lastWritable?.truncates, [0]);
  assert.equal(reportHandle.lastWritable?.closed, true);
});

test('reopens a streaming target with existing data preserved and seeks to the resume offset', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession({
    rootDirectoryHandle: root as unknown as FileSystemDirectoryHandle,
  });

  const target = await (session as any).createStreamingTarget('docs/report.txt', {
    keepExistingData: true,
    startOffset: 5,
  });
  await target.write(new Uint8Array([6, 7]));

  const reportHandle = root.directories.get('docs')?.files.get('report.txt') as MockFileHandle;

  assert.deepEqual(reportHandle.lastCreateWritableOptions, { keepExistingData: true });
  assert.deepEqual(reportHandle.lastWritable?.seeks, [5]);
  assert.deepEqual(
    reportHandle.lastWritable?.writes.map((chunk) => Array.from(chunk)),
    [[6, 7]]
  );
});

test('legacy resolution trims segments and empty separators before validating', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession();
  session.attachRootDirectory(root as unknown as FileSystemDirectoryHandle);

  const result = await session.resolveFileHandle('  photos / /2026// cover.png  ');

  assert.equal(result.normalizedRelativePath, 'photos/2026/cover.png');
  assert.equal(result.fileName, 'cover.png');
});

test('legacy resolution rejects dot segments instead of silently dropping them', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession();
  session.attachRootDirectory(root as unknown as FileSystemDirectoryHandle);

  await assert.rejects(() => session.resolveFileHandle('photos/./cover.png'), /RELATIVE_PATH_DOT_SEGMENT/);
  await assert.rejects(() => session.resolveFileHandle('   '), /RELATIVE_PATH_EMPTY/);
});

test('streaming target exposes abort so a failed close can release the writable', async () => {
  const root = new MockDirectoryHandle('root');
  const session = createDirectorySaveSession({
    rootDirectoryHandle: root as unknown as FileSystemDirectoryHandle,
  });

  const target = await session.createStreamingTarget('docs/report.txt');
  const writable = (root.directories.get('docs')?.files.get('report.txt') as MockFileHandle)
    .lastWritable;

  assert.equal(typeof target.abort, 'function');
  await target.abort?.();

  assert.equal(writable?.aborted, true);
});
