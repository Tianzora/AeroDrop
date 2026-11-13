// 传输偏移量的纯计算：从 components/Sender.tsx 抽出，便于单测与复用。
// 抛错语义保持不变——调用方（ACCEPT_TRANSFER / FILE_REQUEST 处理）依赖它来拒绝
// 非法的续传位置。

export const getTotalFileBytes = (files: ReadonlyArray<File>): number =>
  files.reduce((total, file) => total + file.size, 0);

export const getResumeOffset = (
  files: ReadonlyArray<File>,
  fileIndex: number,
  byteOffset: number,
): number => {
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > files.length) {
    throw new Error('Invalid resume fileIndex');
  }
  if (fileIndex === files.length) {
    if (byteOffset !== 0) {
      throw new Error('Completed transfer resume byteOffset must be zero');
    }
    return getTotalFileBytes(files);
  }
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > files[fileIndex].size) {
    throw new Error('Invalid resume byteOffset');
  }
  return files.slice(0, fileIndex).reduce((total, file) => total + file.size, 0) + byteOffset;
};

export const getPositionForOverallOffset = (
  files: ReadonlyArray<File>,
  overallOffset: number,
): { fileIndex: number; byteOffset: number } => {
  const totalBytes = getTotalFileBytes(files);
  if (!Number.isSafeInteger(overallOffset) || overallOffset < 0 || overallOffset > totalBytes) {
    throw new Error('Invalid persistedOverallBytes');
  }
  if (overallOffset === 0) {
    return { fileIndex: 0, byteOffset: 0 };
  }

  let remaining = overallOffset;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (remaining < files[fileIndex].size) {
      return { fileIndex, byteOffset: remaining };
    }
    remaining -= files[fileIndex].size;
  }
  return { fileIndex: files.length, byteOffset: 0 };
};
