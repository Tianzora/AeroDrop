import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearResumeCheckpoint,
  createMemoryResumeCheckpointStorage,
  createResumeMetadataFingerprint,
  getResumeCheckpointKey,
  isResumeCheckpointExpired,
  loadResumeCheckpoint,
  RESUME_CHECKPOINT_DEFAULTS,
  resolveCheckpointOffset,
  saveResumeCheckpoint,
  type ResumeCheckpointStorage,
} from './resumeCheckpoint.ts';

const SESSION_ID = 'session-1';
const FINGERPRINT = 'name:size:type:lastModified';

const createCheckpointInput = (overrides: Partial<Parameters<typeof saveResumeCheckpoint>[0]> = {}) => ({
  sessionId: SESSION_ID,
  metadataFingerprint: FINGERPRINT,
  fileIndex: 0,
  committedBytes: 1024,
  totalSize: 4096,
  updatedAt: 1_000,
  ...overrides,
});

test('saves and loads a checkpoint scoped to the session', () => {
  const storage = createMemoryResumeCheckpointStorage();
  const saved = saveResumeCheckpoint(createCheckpointInput(), { storage, now: () => 1_000 });

  assert.ok(saved);
  assert.deepEqual(saved, {
    sessionId: SESSION_ID,
    metadataFingerprint: FINGERPRINT,
    fileIndex: 0,
    committedBytes: 1024,
    totalSize: 4096,
    updatedAt: 1_000,
  });
  assert.ok(storage.getItem(getResumeCheckpointKey(SESSION_ID)));

  const loaded = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 1_000 }
  );
  assert.deepEqual(loaded, saved);
});

test('stores the checkpoint under the configured key prefix', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput(), {
    storage,
    keyPrefix: 'test.prefix.',
    now: () => 1_000,
  });

  assert.ok(storage.getItem('test.prefix.session-1'));
  assert.equal(storage.getItem(getResumeCheckpointKey(SESSION_ID)), null);

  const loaded = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, keyPrefix: 'test.prefix.', now: () => 1_000 }
  );
  assert.ok(loaded);
});

test('rejects a checkpoint written for a different metadata fingerprint without deleting it', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput(), { storage, now: () => 1_000 });

  const mismatched = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: 'another-batch' },
    { storage, now: () => 1_000 }
  );
  assert.equal(mismatched, null);
  assert.ok(storage.getItem(getResumeCheckpointKey(SESSION_ID)));

  const matched = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 1_000 }
  );
  assert.equal(matched?.fileIndex, 0);
});

test('drops the checkpoint once it is older than the ttl', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput(), { storage });

  const expired = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 1_000 + RESUME_CHECKPOINT_DEFAULTS.TTL_MS + 1 }
  );

  assert.equal(expired, null);
  assert.equal(storage.getItem(getResumeCheckpointKey(SESSION_ID)), null);
});

test('keeps the checkpoint at the exact ttl boundary and honours a custom ttl', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput(), { storage });

  const boundary = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 1_000 + RESUME_CHECKPOINT_DEFAULTS.TTL_MS }
  );
  assert.ok(boundary);

  const customTtlExpired = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 2_000, ttlMs: 500 }
  );
  assert.equal(customTtlExpired, null);
});

test('treats a future updatedAt (clock skew) as fresh', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput({ updatedAt: 10_000 }), { storage });

  const loaded = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage, now: () => 9_000 }
  );
  assert.equal(loaded?.updatedAt, 10_000);
  assert.equal(isResumeCheckpointExpired({ updatedAt: 10_000 }, 9_000), false);
});

test('degrades safely when the stored payload is corrupt', () => {
  const storage = createMemoryResumeCheckpointStorage([
    [getResumeCheckpointKey(SESSION_ID), '{not-json'],
  ]);

  const loaded = loadResumeCheckpoint(
    { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT },
    { storage }
  );

  assert.equal(loaded, null);
  assert.equal(storage.getItem(getResumeCheckpointKey(SESSION_ID)), null);
});

test('degrades safely on an unsupported record version or invalid shape', () => {
  const storage = createMemoryResumeCheckpointStorage();
  const key = getResumeCheckpointKey(SESSION_ID);

  storage.setItem(key, JSON.stringify({ version: 999, checkpoint: {} }));
  assert.equal(
    loadResumeCheckpoint({ sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT }, { storage }),
    null
  );
  assert.equal(storage.getItem(key), null);

  storage.setItem(
    key,
    JSON.stringify({
      version: RESUME_CHECKPOINT_DEFAULTS.VERSION,
      checkpoint: { sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT, fileIndex: -1 },
    })
  );
  assert.equal(
    loadResumeCheckpoint({ sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT }, { storage }),
    null
  );
  assert.equal(storage.getItem(key), null);
});

test('refuses to persist invalid checkpoints', () => {
  const storage = createMemoryResumeCheckpointStorage();

  assert.equal(
    saveResumeCheckpoint(createCheckpointInput({ committedBytes: 8192, totalSize: 4096 }), { storage }),
    null
  );
  assert.equal(saveResumeCheckpoint(createCheckpointInput({ totalSize: 0 }), { storage }), null);
  assert.equal(saveResumeCheckpoint(createCheckpointInput({ fileIndex: -1 }), { storage }), null);
  assert.equal(saveResumeCheckpoint(createCheckpointInput({ sessionId: '  ' }), { storage }), null);
  assert.equal(saveResumeCheckpoint(createCheckpointInput({ metadataFingerprint: '' }), { storage }), null);
  assert.equal(storage.getItem(getResumeCheckpointKey(SESSION_ID)), null);
});

test('never throws when the injected storage fails', () => {
  const throwingStorage: ResumeCheckpointStorage = {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('quota exceeded');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };

  assert.equal(saveResumeCheckpoint(createCheckpointInput(), { storage: throwingStorage }), null);
  assert.equal(
    loadResumeCheckpoint({ sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT }, {
      storage: throwingStorage,
    }),
    null
  );
  assert.equal(clearResumeCheckpoint(SESSION_ID, { storage: throwingStorage }), false);
  assert.equal(
    saveResumeCheckpoint(createCheckpointInput(), { storage: null }),
    null
  );
});

test('clears the checkpoint by session id', () => {
  const storage = createMemoryResumeCheckpointStorage();
  saveResumeCheckpoint(createCheckpointInput(), { storage });

  assert.equal(clearResumeCheckpoint(SESSION_ID, { storage }), true);
  assert.equal(
    loadResumeCheckpoint({ sessionId: SESSION_ID, metadataFingerprint: FINGERPRINT }, { storage }),
    null
  );
  assert.equal(clearResumeCheckpoint('   ', { storage }), false);
});

test('resolves the checkpoint offset only for the matching file and clamps to the file size', () => {
  const checkpoint = saveResumeCheckpoint(createCheckpointInput({ committedBytes: 2048 }), {
    storage: createMemoryResumeCheckpointStorage(),
  });
  assert.ok(checkpoint);

  assert.equal(resolveCheckpointOffset(checkpoint, 0, 4096), 2048);
  assert.equal(resolveCheckpointOffset(checkpoint, 1, 4096), 0);
  assert.equal(resolveCheckpointOffset(null, 0, 4096), 0);
  assert.equal(resolveCheckpointOffset({ ...checkpoint, committedBytes: 9000 }, 0, 4096), 4096);
  assert.equal(resolveCheckpointOffset({ ...checkpoint, committedBytes: 2048 }, 0, 1000), 1000);
});

test('derives a stable metadata fingerprint that changes with the batch', () => {
  const files = [
    { name: 'a.txt', size: 10, type: 'text/plain', lastModified: 1 },
    { name: 'b.txt', size: 20, type: 'text/plain', lastModified: 2 },
  ];

  const fingerprint = createResumeMetadataFingerprint(files);
  assert.equal(fingerprint, createResumeMetadataFingerprint(files.map((file) => ({ ...file }))));
  assert.match(fingerprint, /^md-2-/);

  assert.notEqual(fingerprint, createResumeMetadataFingerprint([files[0], { ...files[1], size: 21 }]));
  assert.notEqual(fingerprint, createResumeMetadataFingerprint([files[1], files[0]]));
  assert.notEqual(fingerprint, createResumeMetadataFingerprint([files[0]]));
});

test('a stored checkpoint only loads for the fingerprint of the same batch', () => {
  const storage = createMemoryResumeCheckpointStorage();
  const fingerprint = createResumeMetadataFingerprint([
    { name: 'a.txt', size: 10, type: 'text/plain', lastModified: 1 },
  ]);

  saveResumeCheckpoint(createCheckpointInput({ metadataFingerprint: fingerprint }), {
    storage,
    now: () => 1_000,
  });

  assert.ok(
    loadResumeCheckpoint({ sessionId: SESSION_ID, metadataFingerprint: fingerprint }, {
      storage,
      now: () => 1_000,
    })
  );
  assert.equal(
    loadResumeCheckpoint(
      { sessionId: SESSION_ID, metadataFingerprint: createResumeMetadataFingerprint([{ name: 'a.txt', size: 11 }]) },
      { storage, now: () => 1_000 }
    ),
    null
  );
});
