import test from 'node:test';
import assert from 'node:assert/strict';

import { restoreCompletedFilesForResume } from './completedFileRestore.ts';

const files = [{ size: 100 }, { size: 200 }, { size: 300 }];

test('marks every file before the checkpoint index as completed', () => {
  const marked: Array<{ fileIndex: number; size: number; directSaved: boolean }> = [];
  const restored = restoreCompletedFilesForResume(
    {
      checkpointFileIndex: 2,
      files,
      markCompleted: (fileIndex, size, directSaved) => marked.push({ fileIndex, size, directSaved }),
    },
    { directSaved: true },
  );

  assert.deepEqual(restored, [0, 1]);
  assert.deepEqual(marked, [
    { fileIndex: 0, size: 100, directSaved: true },
    { fileIndex: 1, size: 200, directSaved: true },
  ]);
});

test('does nothing when the checkpoint points at the first file', () => {
  const marked: number[] = [];
  const restored = restoreCompletedFilesForResume({
    checkpointFileIndex: 0,
    files,
    markCompleted: (fileIndex) => marked.push(fileIndex),
  });

  assert.deepEqual(restored, []);
  assert.deepEqual(marked, []);
});

test('clamps out-of-range and malformed indexes instead of restoring everything', () => {
  const marked: number[] = [];
  const restore = (checkpointFileIndex: number) => {
    marked.length = 0;
    restoreCompletedFilesForResume({
      checkpointFileIndex,
      files,
      markCompleted: (fileIndex) => marked.push(fileIndex),
    });
    return [...marked];
  };

  assert.deepEqual(restore(99), [0, 1, 2]);
  assert.deepEqual(restore(-3), []);
  assert.deepEqual(restore(1.7), [0]);
  assert.deepEqual(restore(Number.NaN), []);
});

test('one failing mark does not stop the others', () => {
  const restored = restoreCompletedFilesForResume({
    checkpointFileIndex: 3,
    files,
    markCompleted: (fileIndex) => {
      if (fileIndex === 1) throw new Error('manifest rejected');
    },
  });

  assert.deepEqual(restored, [0, 2]);
});
