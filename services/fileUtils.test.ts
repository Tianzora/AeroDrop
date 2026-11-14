import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize, generateFileFingerprint } from './fileUtils.ts';

test('formatFileSize：0、负数与非有限值走各自的兜底文案', () => {
  assert.equal(formatFileSize(0), '0 Bytes');
  assert.equal(formatFileSize(-1), '0 Bytes');
  assert.equal(formatFileSize(Number.NaN), '---');
  assert.equal(formatFileSize(Number.POSITIVE_INFINITY), '---');
});

test('formatFileSize：按 1024 进制换算，小数最多两位', () => {
  assert.equal(formatFileSize(1), '1 Bytes');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1 MB');
  assert.equal(formatFileSize(1024 ** 4), '1 TB');
});

test('formatFileSize：超出 TB 时停在最大单位，而不是出现 undefined', () => {
  assert.equal(formatFileSize(1024 ** 5), '1024 TB');
  assert.ok(!formatFileSize(1024 ** 5).includes('undefined'));
});

test('generateFileFingerprint：同名不同大小/时间必须得到不同指纹', () => {
  const base = { name: 'a.bin', size: 10, type: 'application/octet-stream', lastModified: 1 };
  const same = { ...base };
  const otherSize = { ...base, size: 11 };
  const otherTime = { ...base, lastModified: 2 };

  assert.equal(generateFileFingerprint(base), generateFileFingerprint(same));
  assert.notEqual(generateFileFingerprint(base), generateFileFingerprint(otherSize));
  assert.notEqual(generateFileFingerprint(base), generateFileFingerprint(otherTime));
  assert.match(generateFileFingerprint(base), /^[0-9a-z]+$/);
});
