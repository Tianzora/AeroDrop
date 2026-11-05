import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMultiFileSaveMode,
  resolveReceiveSaveCapability,
} from './saveCapabilityResolver.ts';

test('prefers directory-direct on supported desktop multi-file receives', () => {
  const result = resolveMultiFileSaveMode({
    fileCount: 4,
    isIOS: false,
    isSafari: false,
    supportsDirectoryPicker: true,
    supportsArchiveExport: true,
  });

  assert.equal(result.mode, 'directory-direct');
  assert.equal(result.shouldPromptForDirectory, true);
});

test('falls back to archive export when directory direct is unavailable', () => {
  const result = resolveMultiFileSaveMode({
    fileCount: 3,
    isIOS: false,
    isSafari: false,
    supportsDirectoryPicker: false,
    supportsArchiveExport: true,
  });

  assert.equal(result.mode, 'archive-export');
  assert.equal(result.shouldPromptForDirectory, false);
});

test('uses per-file save queue when no higher-level fallback exists', () => {
  const result = resolveMultiFileSaveMode({
    fileCount: 10,
    isIOS: true,
    isSafari: true,
    supportsDirectoryPicker: false,
    supportsArchiveExport: false,
  });

  assert.equal(result.mode, 'per-file-save-queue');
});

test('keeps directory-direct disabled on mobile and single-file transfers', () => {
  const mobile = resolveReceiveSaveCapability({
    fileCount: 3,
    isChromium: true,
    isIOS: false,
    isMobileDevice: true,
    isSafari: false,
    supportsArchiveExport: true,
    supportsDirectoryPicker: true,
  });
  const singleFile = resolveReceiveSaveCapability({
    fileCount: 1,
    isChromium: true,
    isIOS: false,
    isMobileDevice: false,
    isSafari: false,
    supportsArchiveExport: true,
    supportsDirectoryPicker: true,
  });

  assert.equal(mobile.selectedMode, 'archive-export');
  assert.equal(mobile.capabilities.canUseDirectoryDirect, false);
  assert.deepEqual(mobile.orderedModes, ['archive-export', 'per-file-save-queue']);

  assert.equal(singleFile.isMultiFileTransfer, false);
  assert.equal(singleFile.selectedMode, 'per-file-save-queue');
  assert.deepEqual(singleFile.orderedModes, ['per-file-save-queue']);
  assert.equal(singleFile.shouldPromptForDirectory, false);
});

test('resolveMultiFileSaveMode honours the caller-provided device kind', () => {
  const mobile = resolveMultiFileSaveMode({
    fileCount: 3,
    isIOS: false,
    isSafari: false,
    isMobileDevice: true,
    supportsArchiveExport: true,
    supportsDirectoryPicker: true,
  });
  const desktop = resolveMultiFileSaveMode({
    fileCount: 3,
    isIOS: false,
    isSafari: false,
    supportsArchiveExport: true,
    supportsDirectoryPicker: true,
  });

  assert.equal(mobile.supportsDirectoryDirect, false);
  assert.equal(mobile.mode, 'archive-export');
  assert.equal(desktop.supportsDirectoryDirect, true);
  assert.equal(desktop.mode, 'directory-direct');
});
