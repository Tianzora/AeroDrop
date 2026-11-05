import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDirectoryHandleForResume } from './resumeDirectoryHandle.ts';

const handle = (name: string) => ({ name } as unknown as FileSystemDirectoryHandle);

test('prefers the in-session cached handle and never asks again', async () => {
  const picked: string[] = [];
  const result = await resolveDirectoryHandleForResume({
    getCachedHandle: async () => handle('cached'),
    loadPersistedHandle: async () => handle('persisted'),
    ensureWritePermission: async () => true,
    pickDirectory: async () => {
      picked.push('picker');
      return handle('picked');
    },
  });

  assert.equal(result?.source, 'cache');
  assert.equal(result?.handle.name, 'cached');
  assert.deepEqual(picked, []);
});

test('reuses the persisted handle when permission can be re-granted', async () => {
  const requested: string[] = [];
  const result = await resolveDirectoryHandleForResume({
    getCachedHandle: async () => null,
    loadPersistedHandle: async () => handle('persisted'),
    ensureWritePermission: async (value) => {
      requested.push(value.name);
      return true;
    },
    pickDirectory: async () => handle('picked'),
  });

  assert.equal(result?.source, 'persisted');
  assert.equal(result?.handle.name, 'persisted');
  assert.deepEqual(requested, ['persisted']);
});

test('falls back to the directory picker when the persisted handle is gone or denied', async () => {
  for (const persisted of [null, handle('stale')]) {
    const result = await resolveDirectoryHandleForResume({
      getCachedHandle: async () => null,
      loadPersistedHandle: async () => persisted,
      ensureWritePermission: async () => false,
      pickDirectory: async () => handle('picked'),
    });

    assert.equal(result?.source, 'picker');
    assert.equal(result?.handle.name, 'picked');
  }
});

test('returns null when the user cancels the picker', async () => {
  const result = await resolveDirectoryHandleForResume({
    getCachedHandle: async () => null,
    loadPersistedHandle: async () => null,
    ensureWritePermission: async () => true,
    pickDirectory: async () => null,
  });

  assert.equal(result, null);
});

test('survives deps that reject instead of throwing', async () => {
  const result = await resolveDirectoryHandleForResume({
    getCachedHandle: async () => {
      throw new Error('cache broke');
    },
    loadPersistedHandle: async () => {
      throw new Error('idb broke');
    },
    ensureWritePermission: async () => true,
    pickDirectory: async () => handle('picked'),
  });

  assert.equal(result?.source, 'picker');
});
