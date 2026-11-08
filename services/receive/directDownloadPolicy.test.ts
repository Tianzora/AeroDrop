import test from 'node:test';
import assert from 'node:assert/strict';

import { RECEIVE_STORAGE } from '../../constants/transfer.ts';
import { resolveDirectDownloadPolicy } from './directDownloadPolicy.ts';

const baseInput = {
  fileCount: 1,
  totalBytes: 8 * 1024 * 1024,
  isIOS: false,
  isSafari: false,
  supportsSaveFilePicker: true,
};

test('downloads a small single file straight to the browser download directory', () => {
  const policy = resolveDirectDownloadPolicy(baseInput);
  assert.equal(policy.useDirectDownload, true);
  assert.equal(policy.fallbackReason, null);
});

test('keeps multi-file transfers on the remembered directory flow', () => {
  const policy = resolveDirectDownloadPolicy({ ...baseInput, fileCount: 12, totalBytes: 64 * 1024 * 1024 });
  assert.equal(policy.useDirectDownload, false);
  assert.equal(policy.fallbackReason, 'multi-file');
});

test('falls back when the payload exceeds the limit', () => {
  const policy = resolveDirectDownloadPolicy({
    ...baseInput,
    totalBytes: RECEIVE_STORAGE.DIRECT_DOWNLOAD_MAX_BYTES + 1,
  });
  assert.equal(policy.useDirectDownload, false);
  assert.equal(policy.fallbackReason, 'too-large');
});

test('falls back when the payload size is unknown', () => {
  const policy = resolveDirectDownloadPolicy({ ...baseInput, totalBytes: Number.NaN });
  assert.equal(policy.useDirectDownload, false);
  assert.equal(policy.fallbackReason, 'too-large');
});

test('never overrides iOS or Safari system save panels', () => {
  assert.equal(resolveDirectDownloadPolicy({ ...baseInput, isIOS: true }).useDirectDownload, false);
  assert.equal(resolveDirectDownloadPolicy({ ...baseInput, isSafari: true }).useDirectDownload, false);
});

test('leaves browsers without a save picker on their existing path', () => {
  const policy = resolveDirectDownloadPolicy({ ...baseInput, supportsSaveFilePicker: false });
  assert.equal(policy.useDirectDownload, false);
  assert.equal(policy.fallbackReason, 'unsupported-environment');
});

test('ignores empty file lists', () => {
  const policy = resolveDirectDownloadPolicy({ ...baseInput, fileCount: 0, totalBytes: 0 });
  assert.equal(policy.useDirectDownload, false);
});

test('honours an explicit byte limit', () => {
  assert.equal(
    resolveDirectDownloadPolicy({ ...baseInput, totalBytes: 2048, maxBytes: 1024 }).fallbackReason,
    'too-large'
  );
  assert.equal(
    resolveDirectDownloadPolicy({ ...baseInput, totalBytes: 1024, maxBytes: 1024 }).useDirectDownload,
    true
  );
});
