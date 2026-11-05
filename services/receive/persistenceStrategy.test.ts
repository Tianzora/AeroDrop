import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decidePersistenceStrategy,
  DESKTOP_RESUME_BUFFERING_DEFAULTS,
  shouldBufferDesktopFileForResume,
} from './persistenceStrategy.ts';

test('prefers native fs for desktop when available', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    preferBrowserDownload: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'native-fs');
});

test('falls back to stream saver on desktop when native fs is unavailable', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'stream-saver');
});

test('uses indexeddb buffer for large ios files', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: true,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: false,
    supportsIndexedDb: true,
    fileSize: 20 * 1024 * 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'indexeddb-buffer');
});

test('falls back to memory blob when no streaming path is available', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: false,
    supportsIndexedDb: false,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'memory-blob');
});

test('prefers browser staging over direct/native streaming when archive export mode is active', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    preferBrowserDownload: true,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'memory-blob');
});

test('desktop keeps native fs when no refresh-resume capability is requested', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 100 * 1024 * 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
    hasResumeCheckpoint: false,
    preferIndexedDbBuffering: false,
  });

  assert.equal(strategy, 'native-fs');
});

test('desktop buffers through indexeddb when a resume checkpoint should survive a refresh', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 100 * 1024 * 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
    hasResumeCheckpoint: true,
  });

  assert.equal(strategy, 'indexeddb-buffer');
});

test('desktop resume buffering honours the minimum size gate and the upper cap', () => {
  const base = {
    isIOS: false,
    isSafari: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
    hasResumeCheckpoint: true,
  } as const;

  assert.equal(
    decidePersistenceStrategy({ ...base, fileSize: 1024 * 1024 }),
    'native-fs'
  );
  assert.equal(
    decidePersistenceStrategy({ ...base, fileSize: 3 * 1024 * 1024 * 1024 }),
    'native-fs'
  );
});

test('user explicit preference enables indexeddb buffering without a checkpoint', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: DESKTOP_RESUME_BUFFERING_DEFAULTS.MIN_FILE_BYTES,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
    preferIndexedDbBuffering: true,
  });

  assert.equal(strategy, 'indexeddb-buffer');
});

test('custom desktop buffering bounds override the module defaults', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 2 * 1024 * 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
    hasResumeCheckpoint: true,
    desktopIndexedDbMinBytes: 1024 * 1024,
  });

  assert.equal(strategy, 'indexeddb-buffer');
});

test('shouldBufferDesktopFileForResume ignores iOS, Safari and browsers without indexeddb', () => {
  const base = {
    supportsIndexedDb: true,
    fileSize: 100 * 1024 * 1024,
    hasResumeCheckpoint: true,
  };

  assert.equal(shouldBufferDesktopFileForResume({ ...base, isIOS: false, isSafari: false }), true);
  assert.equal(shouldBufferDesktopFileForResume({ ...base, isIOS: true, isSafari: false }), false);
  assert.equal(shouldBufferDesktopFileForResume({ ...base, isIOS: false, isSafari: true }), false);
  assert.equal(
    shouldBufferDesktopFileForResume({ ...base, isIOS: false, isSafari: false, supportsIndexedDb: false }),
    false
  );
  assert.equal(
    shouldBufferDesktopFileForResume({
      supportsIndexedDb: true,
      fileSize: 100 * 1024 * 1024,
      isIOS: false,
      isSafari: false,
    }),
    false
  );
});
