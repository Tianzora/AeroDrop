import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRelativePathFileName,
  normalizeRelativePath,
  normalizeRelativePathSegments,
} from './relativePath.ts';

test('normalizes nested paths and rejects traversal, absolute and control characters', () => {
  assert.deepEqual(normalizeRelativePathSegments('a/b/c.txt'), ['a', 'b', 'c.txt']);
  assert.equal(normalizeRelativePath('a\\b\\c.txt'), 'a/b/c.txt');

  assert.throws(() => normalizeRelativePath('../evil.txt'), /RELATIVE_PATH_TRAVERSAL/);
  assert.throws(() => normalizeRelativePath('a/../../b'), /RELATIVE_PATH_TRAVERSAL/);
  assert.throws(() => normalizeRelativePath('./a'), /RELATIVE_PATH_DOT_SEGMENT/);
  assert.throws(() => normalizeRelativePath('/etc/passwd'), /RELATIVE_PATH_ABSOLUTE/);
  assert.throws(() => normalizeRelativePath('C:\\Windows\\win.ini'), /RELATIVE_PATH_ABSOLUTE/);
  assert.throws(() => normalizeRelativePath('a/\u0001b'), /RELATIVE_PATH_INVALID_SEGMENT/);
  assert.throws(() => normalizeRelativePath('   '), /RELATIVE_PATH_EMPTY/);
});

test('prefixes Windows reserved device names so they can be written on every platform', () => {
  assert.equal(normalizeRelativePath('CON'), '_CON');
  assert.equal(normalizeRelativePath('folder/NUL.txt'), 'folder/_NUL.txt');
  assert.equal(normalizeRelativePath('com1'), '_com1');
  assert.equal(normalizeRelativePath('LPT9.log'), '_LPT9.log');
  // 不是保留名的普通前缀不能误伤。
  assert.equal(normalizeRelativePath('CONSOLE.txt'), 'CONSOLE.txt');
  assert.equal(normalizeRelativePath('COM10.txt'), 'COM10.txt');
});

test('exposes the last path segment for download naming', () => {
  assert.equal(getRelativePathFileName('a/b/c.txt'), 'c.txt');
  assert.equal(getRelativePathFileName('c.txt'), 'c.txt');
});
